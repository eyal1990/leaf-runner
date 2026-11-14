import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkSelection } from '../work-selection.mjs';
import { applyGraphUpdates, graphOutcome, readGraphUpdate } from '../graph-updates.mjs';
import { workFrontier } from '../work-policy.mjs';
import { targetFingerprint } from '../runner-state.mjs';
import { ApiError } from '../api-errors.mjs';
import { JobStore } from '../job-store.mjs';

const node = (id, extra = {}) => ({ theorem_id: id, theorem_name: `Goal.${id}`, status: 'Open',
  formal_statement: `theorem Goal.${id} : True := by sorry`, preamble: '', mathlib_rev: 'a'.repeat(40), reductions: [], ...extra });
const reduction = (id, children) => ({ submission_id: id, children });
const outcome = (target, status = 'ACCEPTED') => ({ theorem_id: target.theorem_id, job_id: `job-${target.theorem_id}`,
  job_status: 'DONE', status, submission_id: `sub-${target.theorem_id}`, target_fingerprint: targetFingerprint(target) });
const gate = () => { let release; const promise = new Promise(r => { release = r; }); return { promise, release }; };
async function fixture(t) {
  const runs = await mkdtemp(join(tmpdir(), 'prove2me-incremental-'));
  t.after(() => rm(runs, { recursive: true, force: true }));
  const a = node('a'), b = node('b'), root = node('root', { reductions: [reduction('root-plan', [a, b])] });
  const frontier = { root, nodes: [root, a, b], leaves: [a, b] };
  const selection = new WorkSelection({ runs });
  await selection.buildGraph({}, 'root', async () => structuredClone(frontier));
  return { runs, selection, frontier, a, b, root };
}

test('confirmed proofs update selection and persist without a graph API request', async t => {
  const h = await fixture(t);
  assert.equal(await h.selection.recordOutcome(outcome(h.a), 'root'), true);
  assert.equal(await h.selection.recordOutcome(outcome(h.a), 'root'), false, 'duplicate verdict is idempotent');
  assert.equal((await h.selection.getWork()).theorem_id, 'b');
  const saved = JSON.parse(await readFile(join(h.runs, 'graphs/root.json'), 'utf8'));
  assert.equal(saved.nodes.find(n => n.theorem_id === 'a').status, 'Proved');
  assert.equal(saved.root.status, 'Open');
  for (const status of ['READY', 'PENDING', 'PUBLICATIONS_READY', 'REPAIR_REQUIRED']) {
    assert.equal(graphOutcome({ ...outcome(h.a), status, job_status: status === 'READY' ? 'READY' : 'ACTIVE' }), null);
  }
});

test('background discovery admits committed work and replays proof verdicts over its older snapshot', async t => {
  const h = await fixture(t), started = gate(), finish = gate();
  await h.selection.requestGraphRefresh('periodic', { background: true });
  const scan = h.selection.buildGraph({}, 'root', async () => { started.release(); await finish.promise; return h.frontier; });
  await started.promise;
  try {
    await h.selection.recordOutcome(outcome(h.a), 'root');
    assert.equal((await h.selection.getWork({ allowCommitted: true })).theorem_id, 'b');
    assert.notEqual(h.selection.committedGeneration, h.selection.requestedGeneration);
  } finally { finish.release(); await scan; }
  assert.equal(h.selection.graph.nodes.find(n => n.theorem_id === 'a').status, 'Proved');
  assert.equal(h.selection.updates.length, 1, 'unobserved outcome survives the scan');
  const current = applyGraphUpdates(h.frontier, h.selection.updates);
  await h.selection.buildGraph({}, 'root', async () => current);
  assert.equal(h.selection.updates.length, 0, 'observed outcomes are compacted');
});

test('restart replays durable outcomes and drops proofs for a changed declaration', async t => {
  const h = await fixture(t);
  await h.selection.recordOutcome(outcome(h.a), 'root');
  const restart = new WorkSelection({ runs: h.runs });
  await restart.buildGraph({}, 'root', async () => h.frontier);
  assert.equal(restart.graph.nodes.find(n => n.theorem_id === 'a').status, 'Proved');
  const changed = structuredClone(h.frontier);
  changed.nodes[1].formal_statement = 'theorem Goal.a : False := by sorry';
  await restart.buildGraph({}, 'root', async () => changed);
  assert.equal(restart.updates[0].pending, true, 'an identity conflict requires a targeted authoritative read');
  await restart.refreshUpdates({ request: async path => path.endsWith('/decompositions') ? { decompositions: [] } : changed.nodes[1] });
  assert.equal(restart.graph.nodes.find(n => n.theorem_id === 'a').status, 'Open');
  await restart.buildGraph({}, 'root', async () => changed);
  assert.equal(restart.updates.length, 0);
});

test('claims retry when an incremental graph update overtakes their state-store transaction', async t => {
  const h = await fixture(t), claim = h.selection.store.claim.bind(h.selection.store);
  let claims = 0;
  h.selection.store.claim = async (graph, options) => {
    if (++claims === 1) await h.selection.recordOutcome(outcome(h.a), 'root');
    return claim(graph, options);
  };
  assert.equal((await h.selection.getWork({ allowCommitted: true })).theorem_id, 'b');
  assert.equal(claims, 2);
  assert.equal(await h.selection.store.read('a'), null, 'the accepted theorem was never reclaimed');
});

test('accepted sketches read only their parent and unfamiliar dependency region, including nested reductions', async t => {
  const h = await fixture(t), c = node('c'), d = node('d'), paths = [];
  const client = { request: async path => {
    paths.push(path);
    if (path === 'theorems/a') return h.a;
    if (path === 'theorems/a/decompositions') return { decompositions: [reduction('sub-a', [c, h.b,
      { definition_id: 'definition', status: 'Definition' }])] };
    if (path === 'theorems/c/decompositions') return { decompositions: [reduction('sub-c', [d])] };
    if (path === 'theorems/d/decompositions') return { decompositions: [] };
    assert.fail(`unexpected graph read ${path}`);
  } };
  await h.selection.recordOutcome(outcome(h.a, 'SKETCH_ACCEPTED'), 'root');
  assert.equal(h.selection.updates[0].pending, true);
  await h.selection.refreshUpdates(client);
  assert.deepEqual(paths, ['theorems/a', 'theorems/a/decompositions', 'theorems/c/decompositions', 'theorems/d/decompositions']);
  assert.deepEqual(workFrontier(h.selection.graph).tasks.map(n => n.theorem_id).sort(), ['b', 'd']);
  assert.equal(h.selection.graph.nodes.find(n => n.theorem_id === 'a').status, 'Open', 'sketch acceptance is not a proof');
  assert.equal(h.selection.graph.nodes.find(n => n.theorem_id === 'a').reductions[0].submission_id, 'sub-a');
});

test('delayed accepted edges and transient reads retry durably without blocking unrelated claims', async t => {
  const h = await fixture(t); let visible = false, now = 1000, calls = 0;
  const client = { request: async path => {
    calls++;
    if (!visible) throw new ApiError(503, path);
    return path.endsWith('/decompositions') ? { decompositions: [reduction('sub-a', [h.b])] } : h.a;
  } };
  await h.selection.recordOutcome(outcome(h.a, 'SKETCH_ACCEPTED'), 'root');
  await h.selection.refreshUpdates(client, { now: () => now, retryMs: 30000 });
  assert.equal(h.selection.updates[0].next_check_at, 31000);
  await h.selection.refreshUpdates(client, { now: () => now }); assert.equal(calls, 1);
  const restart = new WorkSelection({ runs: h.runs });
  await restart.buildGraph({}, 'root', async () => h.frontier);
  assert.equal(restart.updates[0].pending, true);
  // Simulate the durable DONE state which excludes a while its edges propagate.
  const store = new JobStore(h.runs), job = await store.ensure('a');
  Object.assign(job, outcome(h.a, 'SKETCH_ACCEPTED'));
  await store.replace(job, job.revision);
  const claimed = await restart.getWork(); assert.equal(claimed.theorem_id, 'b');
  visible = true; now = 31000;
  await restart.refreshUpdates(client, { now: () => now });
  assert.equal(restart.updates[0].pending, false);
  assert.equal(restart.graph.nodes.find(n => n.theorem_id === 'a').reductions[0].submission_id, 'sub-a');
});

test('unpropagated acceptance keeps its pending entry and permission failures remain fatal', async t => {
  const h = await fixture(t);
  await h.selection.recordOutcome(outcome(h.a, 'SKETCH_ACCEPTED'), 'root');
  await h.selection.refreshUpdates({ request: async path => path.endsWith('/decompositions') ? { decompositions: [] } : h.a },
    { now: () => 1000, retryMs: 30 });
  assert.match(h.selection.updates[0].last_error, /not visible/);
  await assert.rejects(h.selection.refreshUpdates({ request: async path => { throw new ApiError(403, path); } },
    { now: () => 1030 }), /HTTP 403/);
});

test('local ancestor closure and disproof invalidation preserve server root status', async t => {
  const h = await fixture(t), middle = node('middle', { reductions: [reduction('middle-a', [h.a])] });
  const root = node('root', { reductions: [reduction('root-middle', [middle])] });
  const graph = { root, nodes: [root, middle, h.a], leaves: [h.a] };
  const proved = applyGraphUpdates(graph, [graphOutcome(outcome(h.a))]);
  assert.equal(workFrontier(proved).tasks.length, 0);
  assert.equal(proved.root.status, 'Open'); assert.equal(proved.nodes[1].status, 'Open');
  const disproved = applyGraphUpdates(graph, [graphOutcome(outcome(h.a, 'DISPROVED'))]);
  assert.equal(workFrontier(disproved).tasks[0].theorem_id, 'middle');
  assert.equal(workFrontier(disproved).tasks[0].task_kind, 'parent');
});

test('a locally accepted root still requires an authoritative completion check', async t => {
  const h = await fixture(t);
  await h.selection.recordOutcome(outcome(h.root), 'root');
  assert.equal(h.selection.graph.root.status, 'Proved');
  assert.equal(h.selection.rootConfirmed, false);
  await h.selection.confirmRoot({ ...h.root, status: 'Proved' });
  assert.equal(h.selection.rootConfirmed, true);
  assert.equal(JSON.parse(await readFile(join(h.runs, 'graphs/root.json'), 'utf8')).root.status, 'Proved');
});

test('targeted inspection follows a changed declaration without applying its old proof identity', async t => {
  const h = await fixture(t), event = graphOutcome(outcome(h.a, 'SKETCH_ACCEPTED'));
  const changed = { ...h.a, formal_statement: 'theorem Goal.a : False := by sorry' };
  const patch = await readGraphUpdate({ request: async path => path.endsWith('/decompositions') ? { decompositions: [] } : changed }, event, h.selection.graph);
  assert.equal(patch.target_hash, targetFingerprint(changed));
  assert.equal(patch.nodes[0].formal_statement, changed.formal_statement);
});

test('corrupt durable graph events fail startup rather than silently losing confirmed outcomes', async t => {
  const h = await fixture(t);
  await writeFile(join(h.runs, 'graph-updates/root.json'), JSON.stringify({ schema_version: 1, root_id: 'root', events: [null] }));
  const restart = new WorkSelection({ runs: h.runs });
  await assert.rejects(restart.buildGraph({}, 'root', async () => h.frontier), /Invalid graph update journal/);
});

test('a confirmed root result cannot close a changed root declaration during reconciliation', async t => {
  const h = await fixture(t);
  await h.selection.confirmRoot({ ...h.root, status: 'Proved' });
  const changed = structuredClone(h.frontier);
  changed.root.formal_statement = 'theorem Goal.root : False := by sorry';
  changed.nodes[0] = changed.root;
  await h.selection.buildGraph({}, 'root', async () => changed);
  assert.equal(h.selection.rootConfirmed, false);
  assert.equal(h.selection.graph.root.status, 'Open');
  assert.equal(h.selection.updates[0].pending, true);
  await h.selection.refreshUpdates({ request: async path => path.endsWith('/decompositions')
    ? { decompositions: changed.root.reductions } : changed.root });
  assert.equal(h.selection.graph.root.status, 'Open');
});

test('a skipped theorem remains pending through an older scan, then retains the inspected proof result', async t => {
  const h = await fixture(t);
  await h.selection.recordOutcome({ ...outcome(h.a), status: 'SKIPPED (Proved)' }, 'root');
  await h.selection.buildGraph({}, 'root', async () => h.frontier);
  assert.equal(h.selection.updates[0].pending, true);
  await h.selection.refreshUpdates({ request: async () => ({ ...h.a, status: 'Proved' }) });
  await h.selection.buildGraph({}, 'root', async () => h.frontier);
  assert.equal(h.selection.graph.nodes.find(n => n.theorem_id === 'a').status, 'Proved');
});

test('identity reconciliation preserves a newer terminal server verdict and does not mutate responses', async t => {
  const h = await fixture(t), response = { ...h.a, status: 'Disproved' };
  const event = { ...graphOutcome(outcome(h.a)), verify_identity: true, pending: true };
  const patch = await readGraphUpdate({ request: async () => response }, event, h.selection.graph);
  assert.equal(patch.status, 'Disproved');
  assert.equal(response.status, 'Disproved');
  assert.equal(applyGraphUpdates(h.frontier, [{ ...event, ...patch, pending: false }]).nodes[1].status, 'Disproved');
});

test('a conflicting terminal snapshot requires a targeted read rather than erasing a concurrent verdict', async t => {
  const h = await fixture(t);
  await h.selection.recordOutcome(outcome(h.a), 'root');
  const conflicting = structuredClone(h.frontier); conflicting.nodes[1].status = 'Disproved';
  await h.selection.buildGraph({}, 'root', async () => conflicting);
  assert.equal(h.selection.updates[0].pending, true);
  await h.selection.refreshUpdates({ request: async () => ({ ...h.a, status: 'Proved' }) });
  assert.equal(h.selection.graph.nodes.find(n => n.theorem_id === 'a').status, 'Proved');
});
