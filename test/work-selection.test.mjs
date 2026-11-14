import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildGraph, selectCandidate, WorkSelection } from '../work-selection.mjs';

test('graph rebuilds replace node data, preserve attempts across restarts, and select new children', async t => {
  const runs = await mkdtemp(join(tmpdir(), 'prove2me-graph-'));
  t.after(() => rm(runs, { recursive: true, force: true }));
  const node = (id, status = 'Open', extra = {}) => ({ theorem_id: id, theorem_name: id, status, ...extra });
  let root = node('root', 'Open', { old_metadata: true });
  let children = [node('a'), node('b')];
  let aChildren = [];
  const client = { request: async path => {
    if (path === 'theorems/root') return root;
    const rows = path === 'theorems/root/decompositions' ? children
      : path === 'theorems/a/decompositions' ? aChildren : [];
    return { decompositions: rows.length ? [{ submission_id: 'sketch', children: rows }] : [] };
  } };
  await mkdir(join(runs, 'a'));
  await writeFile(join(runs, 'a/state.json'), JSON.stringify({ theorem_id: 'a', status: 'UNRESOLVED',
    attempt_count: 3, attempts_by_model: { 'gpt-6-luna': 2, 'gpt-6.1-sol': 1 } }));
  const first = await buildGraph(client, 'root', { runs });
  assert.equal(selectCandidate(first).theorem_id, 'b');
  assert.deepEqual(first.nodes.find(row => row.theorem_id === 'a').attempts_by_model,
    { 'gpt-6-luna': 2, 'gpt-6.1-sol': 1 });

  root = node('root');
  children = [node('a'), node('b', 'Proved')];
  aChildren = [node('child')];
  const rebuilt = await buildGraph(client, 'root', { runs });
  assert.equal(selectCandidate(rebuilt).theorem_id, 'child');
  assert.equal(Object.hasOwn(rebuilt.root, 'old_metadata'), false);
  assert.equal(rebuilt.nodes.find(row => row.theorem_id === 'b').status, 'Proved');
  const a = rebuilt.nodes.find(row => row.theorem_id === 'a');
  assert.deepEqual(a.children, ['child']); assert.equal(a.attempt_count, 3);

  // The history survives disappearance from the active graph and reappearance.
  children = [node('b')];
  await buildGraph(client, 'root', { runs });
  children = [node('a')]; aChildren = [];
  const restarted = await buildGraph(client, 'root', { runs });
  assert.equal(selectCandidate(restarted).theorem_id, 'a');
  const saved = JSON.parse(await readFile(join(runs, 'graphs/root.json'), 'utf8'));
  assert.equal(saved.nodes.find(row => row.theorem_id === 'a').attempt_count, 3);
  assert.deepEqual(saved.attempts.a.attempts_by_model, a.attempts_by_model);

  // Another mission containing the same theorem also respects its history.
  const other = { request: async path => path === 'theorems/other' ? node('other')
    : { decompositions: path === 'theorems/other/decompositions' ? [{ submission_id: 'sketch', children: [node('a')] }] : [] } };
  assert.equal(selectCandidate(await buildGraph(other, 'other', { runs })).theorem_id, 'a');
});

test('legacy history preserves numbering without blocking selection and invalid saved data never silently resets attempts', async t => {
  const runs = await mkdtemp(join(tmpdir(), 'prove2me-graph-'));
  t.after(() => rm(runs, { recursive: true, force: true }));
  const root = { theorem_id: 'legacy', theorem_name: 'Legacy', status: 'Open' };
  const client = { request: async path => path.endsWith('/decompositions') ? { decompositions: [] } : root };
  await mkdir(join(runs, 'legacy'));
  const path = join(runs, 'legacy/state.json');
  await writeFile(path, JSON.stringify({ theorem_id: 'legacy', attempt: 2, status: 'UNRESOLVED' }));
  const graph = await buildGraph(client, 'legacy', { runs });
  assert.equal(selectCandidate(graph).score, -22);
  assert.deepEqual(graph.root.attempts_by_model, { unknown: 2 });
  await writeFile(path, '{broken');
  await assert.rejects(buildGraph(client, 'legacy', { runs }), SyntaxError);
});

test('selectCandidate scores mathematical work while pending attempts use recovery', () => {
  const pending = { theorem_id: 'pending', attempt_count: 1, work_status: 'PENDING' };
  const fresh = { theorem_id: 'fresh', attempt_count: 0 };
  const graph = { root: { status: 'Open' }, leaves: [pending, fresh] };
  assert.equal(selectCandidate(graph).theorem_id, fresh.theorem_id);
  const selection = new WorkSelection();
  assert.deepEqual(selection.next(graph), { kind: 'resume', leaf: pending });
  assert.equal(selection.selectCandidate(graph).theorem_id, fresh.theorem_id);
  graph.leaves = [pending];
  assert.equal(selectCandidate(graph), null);
});

test('accepted disproofs await propagation while rejected disproofs can retry', () => {
  for (const work_status of ['DISPROVED', 'DISPROOF_REJECTED']) {
    const falseLeaf = { theorem_id: 'false', attempt_count: 1, work_status };
    const fresh = { theorem_id: 'fresh', attempt_count: 0 };
    const graph = { root: { status: 'Open' }, leaves: [falseLeaf, fresh] };
    const selection = new WorkSelection();
    assert.equal(selection.next(graph).leaf.theorem_id, fresh.theorem_id);
    graph.leaves = [falseLeaf];
    assert.equal(selection.next(graph).kind, work_status === 'DISPROVED' ? 'wait' : 'work');
    assert.equal(selectCandidate(graph)?.theorem_id ?? null, work_status === 'DISPROVED' ? null : 'false');
  }
});

test('a disproved dependency stays visible as a blocker after disappearing from the open frontier', () => {
  const root = { theorem_id: 'root', status: 'Open', work_status: 'SKETCH_ACCEPTED', attempt_count: 1 };
  const graph = { root, leaves: [root], nodes: [root, { theorem_id: 'false', status: 'Disproved' }] };
  assert.equal(new WorkSelection().next(graph).kind, 'wait');
});

test('legacy local counterexamples remain recoverable jobs for disproof submission', () => {
  const leaf = { theorem_id: 'false', attempt_count: 6, work_status: 'COUNTEREXAMPLE' };
  const graph = { root: { status: 'Open' }, leaves: [leaf] };
  assert.deepEqual(new WorkSelection().next(graph), { kind: 'resume', leaf });
  assert.equal(selectCandidate(graph), null);
});

test('a disproved root is a distinct outcome', () => {
  const selection = new WorkSelection();
  assert.equal(selection.next({ root: { status: 'Disproved' }, leaves: [] }).kind, 'disproved');
});
