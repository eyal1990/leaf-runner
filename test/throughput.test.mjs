import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JobStore } from '../job-store.mjs';
import { save } from '../runner-state.mjs';
import { decomposition, scopeArtifactNames } from '../lean-artifacts.mjs';
import { publishArtifacts, createRemoteActions } from '../remote-actions.mjs';
import { ApiError } from '../api-errors.mjs';
import { publicationEntries, PublicationStore } from '../publication-store.mjs';
import { createJobStages } from '../job-stages.mjs';

async function temporary(t) {
  const root = await mkdtemp(join(tmpdir(), 'prove2me-throughput-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.mock.method(console, 'log', () => {});
  return root;
}
const target = { theorem_id: 'parent', theorem_name: 'Goal', mathlib_rev: 'rev', status: 'Open', formal_statement: 'theorem Goal : True ∧ True := by sorry' };
const child = name => ({ theorem_name: name, theorem_title: name, preamble: '', formal_statement: `theorem ${name} : True := by sorry`, natural_language_statement: 'True.' });
const answer = { kind: 'sketch', ready: true, explanation: 'Two steps.', children: [child('Ns.A'), child('Ns.B')], definitions: [] };
const source = 'import Theorems.Thm_Ns_A\nimport Theorems.Thm_Ns_B\n-- Ns.A stays in this comment\ntheorem solution : True := by exact Ns.A';

test('runner index follows durable writes across stores and never shares mutable snapshots', async t => {
  const root = await temporary(t), cached = new JobStore(root, { cacheIndex: true }), other = new JobStore(root);
  t.after(() => cached.releaseIndex());
  const initial = await cached.index();
  assert.equal(initial.size, 0);
  const state = await other.ensure('leaf');
  assert.equal((await cached.index()).get('leaf').revision, 0);
  const snapshot = await cached.index(); snapshot.get('leaf').history.push({ bad: true });
  state.feedback = 'persisted'; assert.equal(await other.replace(state, 0), true);
  assert.equal((await cached.index()).get('leaf').feedback, 'persisted');
  assert.equal((await cached.index()).get('leaf').history.length, 0);
  const view = await cached.index({ readOnly: true });
  assert.throws(() => view.get('leaf').history.push({ bad: true }), TypeError);
  view.delete('leaf'); assert.equal((await cached.index()).size, 1);
  await save(other.path('leaf'), { ...state, feedback: 'external coordinated save' });
  assert.equal((await cached.index()).get('leaf').feedback, 'external coordinated save');
  await assert.rejects(other.replace({ ...state, feedback: 'bad' }, -1).then(ok => { assert.ok(ok); }));
  assert.equal((await cached.read('leaf')).feedback, 'external coordinated save');
});

test('scoping rewrites proposed imports, declarations and structure projections, preserving comments and strings', () => {
  const result = scopeArtifactNames(answer, source + '\n#check "Ns.A"', target, 2);
  assert.match(result.source, /Theorems.Thm_Ns_A__p2m_parent_a2/);
  assert.match(result.source, /exact Ns.A__p2m_parent_a2/);
  assert.match(result.source, /-- Ns.A stays in this comment/);
  assert.match(result.source, /"Ns.A"/);
  assert.equal(decomposition(result.candidate, target, result.source).ordered.length, 2);
});

test('validation scopes conflicting cross-job declarations before freezing without another model attempt', async t => {
  const root = await temporary(t), dir = join(root, 'parent'), workspace = join(root, 'workspace');
  await mkdir(dir); await mkdir(workspace);
  const solution = join(workspace, 'solution.lean'); await writeFile(solution, source);
  await save(join(dir, 'state.json'), { job_id: 'new-owner' });
  const previous = decomposition({ ...answer, children: [child('Ns.A')] }, target,
    'import Theorems.Thm_Ns_A\ntheorem solution : True := by exact Ns.A');
  previous.ordered[0].formal_statement = 'theorem Ns.A : False := by sorry';
  await new PublicationStore(root).reserve(publicationEntries(previous, target), 'other-owner');
  const stages = createJobStages({ client: { request: async () => target }, target, context: {}, environment: { toolchain: 'test' },
    options: { runs: root, verificationMode: 'server-only' }, dir, mirror: async () => [], pins: () => '',
    command: () => assert.fail('no build'), agent: () => assert.fail('no model') });
  const outcome = await stages.validate({ workspace, knownDependencies: [], candidate: { ...answer, solution, module: 'Solutions.Test' }, attempt: 1 });
  assert.equal(outcome.type, 'VALIDATED');
  assert.match(outcome.artifact.source, /Ns.A__p2m_parent_a1/);
  assert.equal(outcome.artifact.source, await readFile(solution, 'utf8'));
  assert.equal(outcome.plan.children[0].theorem_name, 'Ns.A__p2m_parent_a1');
});

async function publications(t, candidate = answer, code = source) {
  const root = await temporary(t), jobs = new Map(), declarations = new Map(), posts = [];
  const state = { job_id: 'owner', theorem_id: 'parent' };
  const plan = decomposition(candidate, target, code), options = { runs: root };
  const client = { pages: async () => [],
    publish: async (kind, payload) => {
      const id = String(posts.length + 1); posts.push(payload);
      jobs.set(id, { status: 'COMPILING', theorem_id: id });
      declarations.set(id, { ...payload, theorem_id: id, mathlib_rev: 'rev', status: kind === 'definition' ? 'Definition' : 'Open' });
      return { job_id: id };
    },
    request: async path => path.startsWith('publish-jobs/') ? jobs.get(path.split('/')[1]) : declarations.get(path.split('/')[1]),
  };
  return { root, state, plan, jobs, posts, run: () => publishArtifacts(client, plan, target, state, join(root, 'parent/state.json'), options) };
}

test('independent publications start together, resume without duplicate POSTs and complete as one set', async t => {
  const h = await publications(t);
  assert.equal(await h.run(), null); assert.equal(h.posts.length, 2);
  assert.equal(await h.run(), null); assert.equal(h.posts.length, 2);
  for (const job of h.jobs.values()) job.status = 'PUBLISHED';
  assert.equal((await h.run()).length, 2); assert.equal(h.posts.length, 2);
});

test('publication failure drains already-issued siblings before yielding to repair', async t => {
  const h = await publications(t);
  await h.run(); h.jobs.get('1').status = 'FAILED'; h.jobs.get('1').error_message = 'bad type';
  assert.equal(await h.run(), null); assert.equal(h.state.status, 'PUBLISH_PENDING');
  h.jobs.get('2').status = 'PUBLISHED';
  await assert.rejects(h.run(), /bad type/);
  assert.equal(h.posts.length, 2);
  assert.equal(h.state.status, 'PUBLICATIONS_READY');
});

test('proposed definitions must publish before dependent children are issued', async t => {
  const definition = { definition_name: 'Support', definition_title: 'Support', definition: 'def Support := True', natural_language_statement: 'Support.' };
  const candidate = { ...answer, definitions: [definition], children: [{ ...child('Ns.A'), preamble: 'import Definitions.Def_Support' }] };
  const h = await publications(t, candidate, 'import Theorems.Thm_Ns_A\ntheorem solution : True := by exact Ns.A');
  assert.equal(await h.run(), null); assert.equal(h.posts.length, 1);
  h.jobs.get('1').status = 'PUBLISHED';
  assert.equal(await h.run(), null); assert.equal(h.posts.length, 2);
  h.jobs.get('2').status = 'PUBLISHED'; assert.equal((await h.run()).length, 2);
});

for (const missing of [false, true]) test(`read-only verdict lane defers ${missing ? 'missing' : 'stale'} submission recovery before any replacement POST`, async t => {
  const root = await temporary(t);
  const state = { theorem_id: 'parent', status: 'PENDING', submission_id: 'sub', submissions: ['sub'], submission_started_at: new Date(0).toISOString() };
  const remote = createRemoteActions({ target, state, statePath: join(root, 'parent/state.json'), options: {},
    client: { submit: () => assert.fail('poll lane cannot POST'), pages: () => assert.fail('recovery belongs to action worker') },
    hooks: { now: () => 1800001, readOnlyPoll: () => true,
      poll: async () => { if (missing) throw new ApiError(404, '/verify'); return { status: 'PENDING' }; } } });
  const outcome = await remote.pollSubmission();
  assert.equal(outcome.type, missing ? 'WAIT' : 'REMOTE_RESULT');
  assert.equal(state.status, missing ? 'SUBMISSION_UNKNOWN' : 'PENDING');
});
