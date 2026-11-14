import { solveLeaf } from '../test-support/selection-rounds.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JobStore, JobPersistenceError } from '../job-store.mjs';
import { PublicationStore } from '../publication-store.mjs';
import { WorkSelection, buildGraph } from '../work-selection.mjs';
import { publishArtifacts, runTarget } from '../prove2me.mjs';
import { digest } from '../runner-state.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'prove2me-durable-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.mock.method(console, 'log', () => {});
  const runs = join(root, 'runs'), store = new JobStore(runs);
  const target = { theorem_id: 'leaf', theorem_name: 'Goal', status: 'Open', mathlib_rev: 'a'.repeat(40),
    preamble: '', formal_statement: 'theorem Goal : True := by sorry' };
  const environment = { mathlib_rev: target.mathlib_rev, toolchain: 'leanprover/lean4:v4.33.1' };
  const options = { runs, attempts: 3, lake: 'lake', verificationMode: 'local', attemptModels: [] }, calls = { models: [], posts: 0, builds: 0, workspaces: 0 };
  const client = { request: async () => target, submit: async () => { calls.posts++; return { submission_id: `sub-${calls.posts}` }; } };
  const hooks = {
    workspace: async () => {
      const path = join(root, `workspace-${++calls.workspaces}`);
      await mkdir(join(path, 'Solutions'), { recursive: true }); return path;
    },
    mirror: async () => {}, preflight: async () => {}, command: async () => { calls.builds++; },
    poll: async () => ({ status: 'ACCEPTED' }),
    agent: async (_target, workspace, _dir, attempt, feedback, attemptOptions) => {
      calls.models.push({ attempt, feedback, model: attemptOptions.model });
      const solution = join(workspace, 'Solutions/Sol_leaf.lean');
      await writeFile(solution, 'theorem solution : True := by trivial');
      return { ready: true, kind: 'proof', explanation: 'Trivial.', solution, module: 'Solutions.Sol_leaf', children: [], definitions: [] };
    },
  };
  return { root, runs, store, target, environment, options, calls, client, hooks,
    run: extra => solveLeaf(client, target, {}, environment, { ...options, ...extra }, hooks) };
}

test('concurrent claims across store instances and roots persist exactly one theorem owner', async t => {
  const h = await fixture(t);
  const graph = { root: { theorem_id: 'root', status: 'Open' }, leaves: [h.target], graph_version: 12 };
  const outcomes = await Promise.all([
    h.store.claim(graph, { attempts: 3 }), new JobStore(h.runs).claim(graph, { attempts: 99, testRounds: 2 }),
    new JobStore(h.runs).claim({ ...graph, root: { theorem_id: 'another', status: 'Open' } }, { attempts: 9 }),
  ]);
  assert.equal(outcomes.filter(Boolean).length, 1);
  const saved = await h.store.read('leaf');
  assert.equal(saved.attempt_budget, 3); assert.equal(saved.root_id, 'root');
  assert.equal(saved.graph_version_at_claim, 12); assert.equal(saved.stage, 'PREPARE');
  assert.equal(saved.job_id, outcomes.find(Boolean).job.job_id);
});

test('async getWork waits for an in-flight graph refresh, and refresh failure cannot claim stale work', async t => {
  const h = await fixture(t), scheduler = new WorkSelection({ runs: h.runs });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const refreshing = scheduler.buildGraph({}, 'root', async () => {
    await gate; return { root: { theorem_id: 'root', status: 'Open' }, leaves: [h.target] };
  });
  let returned = false;
  const claiming = scheduler.getWork({ attempts: 3 }).then(job => { returned = true; return job; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(returned, false);
  release(); await refreshing;
  assert.equal((await claiming).theorem_id, 'leaf');
  let fail;
  const failing = scheduler.buildGraph({}, 'root', () => new Promise((_resolve, reject) => { fail = reject; }));
  const stale = scheduler.getWork({ attempts: 3 });
  await new Promise(resolve => setImmediate(resolve));
  fail(new Error('read failed'));
  await assert.rejects(failing, /read failed/); await assert.rejects(stale, /read failed/);
});

test('failed claim writes dispatch nothing and corrupt versioned records cannot reset a budget', async t => {
  const h = await fixture(t);
  await mkdir(join(h.runs, 'leaf', 'state.json'), { recursive: true });
  await assert.rejects(h.store.claim({ root: { status: 'Open' }, leaves: [h.target] }, { attempts: 3 }));
  assert.equal(h.calls.models.length, 0);
  await rm(join(h.runs, 'leaf', 'state.json'), { recursive: true });
  await writeFile(h.store.path('leaf'), JSON.stringify({ schema_version: 1, theorem_id: 'leaf', attempt_budget: 99 }));
  await assert.rejects(h.run(), /Invalid versioned job/);
});

test('revisions reject duplicate completions and completions after retirement', async t => {
  const h = await fixture(t), job = await h.store.ensure('leaf', { attempts: 3 });
  assert.equal(await h.store.completeAction(job.job_id, 0, { stage: 'CODEX', operation: 'implement' }), true);
  assert.equal(await h.store.completeAction(job.job_id, 0, { stage: 'SERVER' }), false);
  assert.equal(await h.store.completeAction(job.job_id, 1, { attempt_budget: 99 }), false);
  assert.equal((await h.store.read('leaf')).attempt_budget, 3);
  const current = await h.store.read('leaf');
  current.job_status = 'RETIRED'; assert.equal(await h.store.replace(current, current.revision), true);
  assert.equal(await h.store.completeAction(job.job_id, current.revision, { stage: 'SERVER' }), false);
  assert.equal((await h.store.read('leaf')).job_status, 'RETIRED');
});

test('same theorem cannot execute a second action while its first model is alive', async t => {
  const h = await fixture(t), generate = h.hooks.agent;
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const invoked = new Promise(resolve => { started = resolve; });
  h.hooks.agent = async (...args) => { started(); await gate; return generate(...args); };
  const running = h.run(); await invoked;
  await assert.rejects(h.run(), /already running/);
  release(); assert.equal(await running, 'ACCEPTED'); assert.equal(h.calls.models.length, 1);
});

// Abort immediately after a selected durable commit to simulate the process
// stopping at that boundary, then reconstruct with a different workspace.
for (const boundary of ['prepared', 'model_start', 'candidate', 'validated', 'submitted', 'verdict']) {
  test(`restart after ${boundary} preserves original budget, attempt numbers and artifact identity`, async t => {
    const h = await fixture(t), abort = new AbortController(), replace = JobStore.prototype.replace;
    let stopped = false;
    const match = job => boundary === 'prepared' ? job.stage === 'CODEX' && job.dispatch_state === 'QUEUED'
      : boundary === 'model_start' ? job.stage === 'CODEX' && job.dispatch_state === 'RUNNING'
      : boundary === 'candidate' ? job.stage === 'VALIDATE' && job.dispatch_state === 'QUEUED'
      : boundary === 'validated' ? job.stage === 'SERVER' && job.operation === 'submit' && job.dispatch_state === 'QUEUED'
      : boundary === 'submitted' ? job.status === 'PENDING'
      : job.status === 'ACCEPTED';
    t.mock.method(JobStore.prototype, 'replace', async function(job, revision) {
      const result = await replace.call(this, job, revision);
      if (!stopped && match(job)) { stopped = true; abort.abort(new Error('simulated crash')); }
      return result;
    });
    await assert.rejects(h.run({ signal: abort.signal }), /simulated crash/); assert.equal(stopped, true);
    const before = await h.store.read('leaf');
    const artifactBytes = before.artifact_manifest ? await readFile(join(h.runs, 'leaf/artifacts-1.json'), 'utf8') : null;
    assert.equal(await h.run({ attempts: 99, testRounds: 2 }), 'ACCEPTED');
    const after = await h.store.read('leaf');
    assert.equal(after.job_id, before.job_id); assert.equal(after.attempt_budget, 3);
    assert.equal(after.attempt_count, boundary === 'model_start' ? 2 : 1);
    assert.equal(h.calls.posts, 1);
    assert.equal(h.calls.models.length, 1);
    if (boundary === 'model_start') {
      assert.equal(h.calls.models[0].attempt, 2); assert.match(h.calls.models[0].feedback, /Interrupted implement/);
      assert.equal(after.attempts_by_model['gpt-6-luna'], 2);
    }
    if (artifactBytes) assert.equal(await readFile(join(h.runs, 'leaf/artifacts-1.json'), 'utf8'), artifactBytes);
    if (['submitted', 'verdict'].includes(boundary)) assert.equal(h.calls.workspaces, 1);
  });
}

for (const boundary of ['candidate', 'validated', 'submitted', 'verdict']) {
  test(`a versioned disproof resumes after ${boundary} without regenerating or changing its certificate`, async t => {
    const h = await fixture(t), abort = new AbortController(), replace = JobStore.prototype.replace;
    h.target.formal_statement = 'theorem Goal : False := by sorry';
    const generate = h.hooks.agent;
    h.hooks.agent = async (...args) => {
      const candidate = await generate(...args);
      await writeFile(candidate.solution, 'theorem solution : ¬ False := by intro h; exact h');
      return { ...candidate, kind: 'counterexample', ready: false };
    };
    let stopped = false;
    t.mock.method(JobStore.prototype, 'replace', async function(job, revision) {
      const result = await replace.call(this, job, revision);
      const match = boundary === 'candidate' ? job.stage === 'VALIDATE' && job.dispatch_state === 'QUEUED'
        : boundary === 'validated' ? job.stage === 'SERVER' && job.operation === 'submit' && job.dispatch_state === 'QUEUED'
        : boundary === 'submitted' ? job.status === 'PENDING' : job.status === 'DISPROVED';
      if (!stopped && match) { stopped = true; abort.abort(new Error('certificate crash')); }
      return result;
    });
    await assert.rejects(h.run({ signal: abort.signal }), /certificate crash/);
    const before = await h.store.read('leaf');
    assert.equal(await h.run({ attempts: 99, testRounds: 2 }), 'DISPROVED');
    const after = await h.store.read('leaf');
    assert.equal(after.attempt_count, 1); assert.equal(after.attempt_budget, 3);
    assert.equal(after.proof_type, 'disprove'); assert.equal(h.calls.posts, 1); assert.equal(h.calls.models.length, 1);
    assert.equal(await readFile(after.counterexample.snapshot, 'utf8'), 'theorem solution : ¬ False := by intro h; exact h');
    if (before.artifact_manifest) assert.equal(after.artifact_manifest.source_hash, before.artifact_manifest.source_hash);
  });
}

for (const boundary of ['candidate', 'validated', 'publication_journal', 'publication_response', 'published', 'published_validation']) {
  test(`a versioned sketch resumes after ${boundary} with the same reduction and one child creation`, async t => {
    const h = await fixture(t), abort = new AbortController(), replace = JobStore.prototype.replace;
    h.target.formal_statement = 'theorem Goal : True ∧ True := by sorry'; h.target.visibility = 'public';
    const child = { theorem_name: 'Child', theorem_title: 'Child', preamble: '',
      formal_statement: 'theorem Child : True := by sorry', natural_language_statement: 'True.' };
    const generate = h.hooks.agent;
    const source = 'import Theorems.Thm_Child\ntheorem solution : True ∧ True := by exact ⟨Child, Child⟩';
    h.hooks.agent = async (...args) => {
      const answer = await generate(...args); await writeFile(answer.solution, source);
      return { ...answer, kind: 'sketch', children: [child], explanation: 'Child supplies both halves.' };
    };
    let creates = 0;
    const row = { ...child, theorem_id: 'child', status: 'Open', mathlib_rev: h.target.mathlib_rev };
    const job = { id: 'publish', status: 'PUBLISHED', theorem_id: 'child', theorem_name: 'Child', visibility: 'public',
      formal_statement: child.formal_statement, definitions: '' };
    h.client.pages = async path => path.startsWith('publish-jobs?') ? creates ? [job] : [] : creates ? [row] : [];
    h.client.request = async path => path === 'theorems/child' ? row : path === 'publish-jobs/publish' ? job : h.target;
    h.client.publish = async () => { creates++; return { job_id: 'publish' }; };
    h.hooks.poll = async () => ({ status: 'SKETCH_ACCEPTED' });
    let stopped = false;
    t.mock.method(JobStore.prototype, 'replace', async function(state, revision) {
      const result = await replace.call(this, state, revision);
      const journal = Object.values(state.publications ?? {})[0];
      const match = boundary === 'candidate' ? state.stage === 'VALIDATE' && state.dispatch_state === 'QUEUED'
        : boundary === 'validated' ? state.stage === 'SERVER' && state.operation === 'publish' && state.dispatch_state === 'QUEUED'
        : boundary === 'publication_journal' ? journal?.status === 'PUBLISHING'
        : boundary === 'publication_response' ? journal?.status === 'PENDING'
        : boundary === 'published' ? state.stage === 'VALIDATE' && state.operation === 'validate_published' && state.dispatch_state === 'QUEUED'
        : state.stage === 'SERVER' && state.operation === 'submit' && state.dispatch_state === 'QUEUED';
      if (!stopped && match) { stopped = true; abort.abort(new Error('sketch crash')); }
      return result;
    });
    await assert.rejects(h.run({ signal: abort.signal }), /sketch crash/); assert.equal(stopped, true);
    if (boundary === 'publication_journal') {
      // A pre-POST journal is deliberately uncertain; recover the request as if
      // it reached the service instead of issuing a second creation.
      creates = 1;
    }
    const before = await h.store.read('leaf');
    assert.equal(await h.run({ attempts: 99, testRounds: 2 }), 'SKETCH_ACCEPTED');
    const after = await h.store.read('leaf');
    assert.equal(creates, 1); assert.equal(h.calls.posts, 1); assert.equal(h.calls.models.length, 1);
    assert.equal(after.attempt_budget, 3); assert.equal(after.attempt_count, 1);
    assert.equal(after.artifact_manifest.source, source);
    if (before.artifact_manifest) assert.equal(after.artifact_manifest.source_hash, before.artifact_manifest.source_hash);
  });
}

test('new attempts use the current run override after restart while preserving lifetime numbering', async t => {
  const h = await fixture(t), job = await h.store.ensure('leaf', { attempts: 3, model: 'original-model' });
  Object.assign(job, { stage: 'CODEX', operation: 'repair', dispatch_state: 'RUNNING', legacy_baseline: { attempts: 2, context_id: 'initial' }, attempt_count: 2,
    attempts_used_in_job: 2, attempts_by_model: { 'original-model': 1, 'gpt-6-luna': 1 } });
  await h.store.replace(job, job.revision);
  assert.equal(await h.run({ model: 'new-cli-model', attempts: 99, testRounds: 2 }), 'ACCEPTED');
  assert.deepEqual(h.calls.models.map(row => [row.attempt, row.model]), [[3, 'new-cli-model']]);
  const other = await h.store.ensure('exhausted', { attempts: 1 });
  Object.assign(other, { stage: 'CODEX', operation: 'implement', dispatch_state: 'RUNNING', legacy_baseline: { attempts: 1, context_id: 'initial' }, attempt_count: 1, attempts_used_in_job: 1 });
  await h.store.replace(other, other.revision);
  assert.equal(await solveLeaf(h.client, { ...h.target, theorem_id: 'exhausted' }, {}, h.environment, { ...h.options, attempts: 99, testRounds: 2 }, h.hooks), 'ACCEPTED');
  assert.equal(h.calls.models.length, 2);
});

test('interrupted formatting repair is not repeated and the next mathematical attempt keeps its sequence', async t => {
  const h = await fixture(t), generate = h.hooks.agent, abort = new AbortController();
  h.hooks.agent = async (...args) => { const answer = await generate(...args); return args[3] === 1 ? { ...answer, explanation: '' } : answer; };
  let repairs = 0;
  h.hooks.repairAnswer = async () => { repairs++; abort.abort(new Error('format interrupted')); throw abort.signal.reason; };
  await assert.rejects(h.run({ signal: abort.signal }), /format interrupted/);
  const interrupted = await h.store.read('leaf');
  assert.equal(interrupted.operation, 'format_repair'); assert.equal(interrupted.format_repair_used, true);
  assert.equal(await h.run(), 'ACCEPTED'); assert.equal(repairs, 1);
  assert.deepEqual(h.calls.models.map(row => [row.attempt, row.model]), [[1, 'gpt-6-luna'], [2, 'gpt-6-luna']]);
});

test('persistence failure after a model result stops before validation or upload', async t => {
  const h = await fixture(t), replace = JobStore.prototype.replace;
  t.mock.method(JobStore.prototype, 'replace', async function(job, revision) {
    if (job.stage === 'VALIDATE') throw new Error('disk full');
    return replace.call(this, job, revision);
  });
  await assert.rejects(h.run(), JobPersistenceError);
  assert.equal(h.calls.models.length, 1); assert.equal(h.calls.posts, 0); assert.equal(h.calls.builds, 0);
  const state = await h.store.read('leaf'); assert.equal(state.stage, 'CODEX'); assert.equal(state.attempt_count, 1);
});

test('the continuous coordinator stops on a persistence failure instead of dispatching another action', async t => {
  const h = await fixture(t);
  h.client.request = async path => path === 'environments' ? { environments: [h.environment] }
    : path.endsWith('/decompositions') ? { decompositions: [] } : h.target;
  h.client.pages = async () => [];
  await assert.rejects(runTarget(h.client, { root: 'leaf', name: 'Example' }, h.options, {
    frontier: async () => ({ root: h.target, leaves: [h.target] }),
    solveLeaf: async () => { throw new JobPersistenceError('disk full'); },
    wait: async () => assert.fail('must not keep dispatching after persistence failure'),
  }), JobPersistenceError);
  const checkpoint = JSON.parse(await readFile(join(h.runs, 'last-run.json'), 'utf8'));
  assert.equal(checkpoint.status, 'ERROR'); assert.equal(h.calls.models.length, 0);
});

test('default server check is one request and persists a delayed action without holding a workspace on restart', async t => {
  const h = await fixture(t); delete h.hooks.poll;
  let checks = 0;
  h.client.request = async path => path.startsWith('verify?') ? (++checks, { status: 'PENDING' }) : h.target;
  assert.equal(await h.run(), 'PENDING'); assert.equal(checks, 1);
  const pending = await h.store.read('leaf');
  assert.equal(pending.stage, 'SERVER'); assert.equal(pending.dispatch_state, 'DELAYED'); assert.ok(Date.parse(pending.next_poll_at) > Date.now());
  h.client.request = async path => path.startsWith('verify?') ? (++checks, { status: 'ACCEPTED' }) : h.target;
  assert.equal(await h.run({ attempts: 99, testRounds: 2 }), 'ACCEPTED');
  assert.equal(checks, 2); assert.equal(h.calls.posts, 1); assert.equal(h.calls.workspaces, 1);
});

test('a verdict saved before a crash repairs instead of resending the old artifact', async t => {
  const h = await fixture(t), abort = new AbortController(), replace = JobStore.prototype.replace;
  h.hooks.poll = async () => ({ status: 'WA', error_message: 'wrong target type' });
  t.mock.method(JobStore.prototype, 'replace', async function(job, revision) {
    const result = await replace.call(this, job, revision);
    if (job.status === 'WA') abort.abort(new Error('verdict crash'));
    return result;
  });
  await assert.rejects(h.run({ signal: abort.signal }), /verdict crash/);
  h.hooks.poll = async () => ({ status: 'ACCEPTED' });
  assert.equal(await h.run({ attempts: 99, testRounds: 2 }), 'ACCEPTED');
  assert.deepEqual(h.calls.models.map(row => row.attempt), [1, 2]);
  assert.match(h.calls.models[1].feedback, /wrong target type/); assert.equal(h.calls.posts, 2);
});

test('unknown POST waits across restarts before the recovery deadline, then can be reconciled', async t => {
  const h = await fixture(t); let posts = 0;
  h.client.submit = async () => { posts++; throw new Error('lost response'); };
  await assert.rejects(h.run(), /lost response/);
  h.client.request = async path => path.startsWith('submissions?') ? { submissions: [], total: 0 } : h.target;
  for (let i = 0; i < 2; i++) assert.equal(await h.run(), 'SUBMISSION_UNKNOWN');
  assert.equal((await h.store.read('leaf')).job_status, 'ACTIVE');
  h.client.request = async path => path.startsWith('submissions?') ? { submissions: [{ id: 'recovered', theorem_id: 'leaf' }], total: 1 }
    : path.endsWith('/solution') ? { content: 'theorem solution : True := by trivial' } : h.target;
  assert.equal(await h.run(), 'ACCEPTED'); assert.equal(posts, 1); assert.equal(h.calls.models.length, 1);
});

test('graph snapshots retain alternatives, submission IDs, definitions, deprecated links and dead blockers', async t => {
  const h = await fixture(t), root = { ...h.target, theorem_id: 'root' };
  const reductions = [
    { submission_id: 'a', status: 'SKETCH_ACCEPTED', children: [h.target] },
    { submission_id: 'b', status: 'ACCEPTED', children: [{ ...h.target, theorem_id: 'dead', status: 'Dead' }] },
    { submission_id: 'c', deprecated_at: 'yesterday', children: [{ definition_id: 'def', status: 'Definition', deprecated_at: 'yesterday' }] },
  ];
  const graph = await buildGraph({ request: async path => path === 'theorems/root' ? root
    : { decompositions: path === 'theorems/root/decompositions' ? reductions : [] } }, 'root', { runs: h.runs });
  const saved = JSON.parse(await readFile(join(h.runs, 'graphs/root.json'), 'utf8'));
  assert.equal(saved.schema_version, 1); assert.equal(saved.graph_version, 1);
  assert.deepEqual(graph.nodes.find(row => row.theorem_id === 'root').reductions.map(row => row.submission_id), ['a', 'b', 'c']);
  assert.equal(saved.nodes[0].reductions[1].blockers[0].theorem_id, 'dead');
  assert.equal(saved.nodes[0].reductions[2].children[0].definition_id, 'def');
  assert.equal(saved.nodes[0].reductions[2].usable, false);
});

test('cross-job publication reservations arbitrate an identical name before either POST, including a lost response', async t => {
  const h = await fixture(t), artifact = { theorem_name: 'Child', theorem_title: 'Child', preamble: '',
    formal_statement: 'theorem Child : True := by sorry', natural_language_statement: 'True.' };
  const plan = { ordered: [artifact] }, parent = { ...h.target, visibility: 'public' };
  const first = { theorem_id: 'first', job_id: 'owner-1' }, second = { theorem_id: 'second', job_id: 'owner-2' };
  let started, release, posts = 0;
  const invoked = new Promise(resolve => { started = resolve; }), barrier = new Promise(resolve => { release = resolve; });
  const client = { pages: async () => [], publish: async () => { posts++; started(); await barrier; throw new Error('response lost'); } };
  const a = publishArtifacts(client, plan, parent, first, join(h.runs, 'first/state.json'), h.options);
  await invoked;
  assert.equal(await publishArtifacts(client, plan, parent, second, join(h.runs, 'second/state.json'), h.options), null);
  release(); await assert.rejects(a, /response lost/);
  assert.equal(posts, 1);
  for (const state of [first, second]) assert.equal(await
    publishArtifacts(client, plan, parent, state, join(h.runs, `${state.theorem_id}/state.json`), h.options), null);
  assert.equal(posts, 1);
});

test('cross-job conflicting declarations fail atomically, and one owner alone can retry a confirmed infrastructure error', async t => {
  const h = await fixture(t), reservations = new PublicationStore(h.runs);
  const entry = { name: 'Child', nameKey: digest('Child'), key: digest('True') };
  await reservations.reserve([entry], 'first');
  await assert.rejects(reservations.reserve([{ ...entry, key: digest('False') }], 'second'), /Conflicting cross-job/);
  assert.equal(await reservations.begin(entry, 'first', { status: 'PUBLISHING' }), true);
  await reservations.record([entry], 'first', { [entry.key]: { status: 'ERROR', job_id: 'failed' } });
  const starts = await Promise.all(['first', 'second'].map(owner => reservations.begin(entry, owner, { status: 'PUBLISHING' })));
  assert.equal(starts.filter(Boolean).length, 1);
});

test('unused publication reservations are released when an owner retires without issuing a POST', async t => {
  const h = await fixture(t), reservations = new PublicationStore(h.runs);
  const entry = { name: 'Child', nameKey: digest('Child'), key: digest('True') };
  await reservations.reserve([entry], 'first'); await reservations.releaseUnused('first');
  assert.equal((await reservations.reserve([{ ...entry, key: digest('False') }], 'second')).get(digest('False')).owner, 'second');
});
