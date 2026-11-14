import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendEvent, historyState, observeContext, reduceHistory } from '../attempt-history.mjs';
import { scoreWork, selectWork, workFrontier } from '../work-policy.mjs';
import { JobStore } from '../job-store.mjs';
import { buildGraph } from '../work-selection.mjs';
import { solveLeaf, runTarget, main, Client } from '../prove2me.mjs';
import { digest, save } from '../runner-state.mjs';

const node = (id, status = 'Open') => ({ theorem_id: id, theorem_name: id, status,
  mathlib_rev: 'a'.repeat(40), formal_statement: `theorem ${id} : True := by sorry`, preamble: '', reductions: [] });
function brokenGraph() {
  const root = node('root'), parent = node('parent'), dead = node('dead', 'Disproved'), open = node('open');
  root.reductions = [{ submission_id: 'root-reduction', children: [parent] }];
  parent.reductions = [{ submission_id: 'accepted-reduction', children: [dead, open] }];
  return { root, nodes: [root, parent, dead, open], leaves: [open] };
}
async function fixture(t) {
  t.mock.method(console, 'log', () => {});
  const root = await mkdtemp(join(tmpdir(), 'prove2me-continuous-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runs = join(root, 'runs'), store = new JobStore(runs), target = node('goal');
  const models = [], leases = new Set();
  const environment = { mathlib_rev: target.mathlib_rev, toolchain: 'leanprover/lean4:v4.33.1' };
  // These scenarios exercise repeated rescues independently of public defaults.
  const options = { runs, verificationMode: 'server-only', attempts: 1, pipeline: { promptVariant: 'balanced', attemptModels: [],
    incompleteEscalation: { after: 2, model: 'sol-6.1-high', maxAttempts: null } },
    recovery: { initialDelayMs: 1, maxDelayMs: 1 } };
  const client = { request: async () => target };
  const hooks = {
    workspace: async () => {
      const path = join(root, `workspace-${Math.random()}`);
      await mkdir(join(path, 'Solutions'), { recursive: true }); leases.add(path); return path;
    }, releaseWorkspace: async path => { assert.ok(leases.delete(path)); },
    mirror: async () => [], preflight: async () => {},
    command: async () => assert.fail('server-only must not run Lean/Lake'),
    agent: async (_target, workspace, _dir, attempt, _feedback, settings) => {
      models.push({ attempt, model: settings.model, manifest: JSON.parse(await readFile(settings.attemptContextPath, 'utf8')) });
      return { ready: false, kind: 'proof', explanation: 'The unresolved coefficient identity requires finite expansion of ideal powers and homogeneous component products.' };
    },
  };
  return { root, runs, store, target, environment, options, client, hooks, models, leases,
    graph: { root: target, leaves: [target], nodes: [target] },
    run: () => solveLeaf(client, target, {}, environment, options, hooks) };
}

test('starts count once, outcomes deduplicate, and context events consume no attempt', () => {
  const s = historyState({ attempt_count: 7 });
  const start = { event_type: 'attempt', attempt: 8, attempt_id: 'a', context_id: 'initial', result: 'started', event_id: 'a:start' };
  appendEvent(s, start); appendEvent(s, start);
  appendEvent(s, { ...start, result: 'rejected', event_id: 'a:outcome' });
  appendEvent(s, { ...start, result: 'proof_accepted', event_id: 'a:duplicate' });
  appendEvent(s, { event_type: 'context_change', attempt: null, event_id: 'change', result: 'dependency_disproved' });
  assert.equal(reduceHistory(s).totalAttempts, 8);
  assert.equal(s.history.length, 3);
  assert.equal(reduceHistory(s).latestCompleted.result, 'rejected');
});

test('a sole open theorem yields after each failure and continues beyond deprecated budgets', async t => {
  const h = await fixture(t);
  h.options.recovery = { initialDelayMs: 30000, maxDelayMs: 900000 };
  for (let i = 1; i <= 6; i++) {
    const claim = await h.store.claim(h.graph, h.options);
    assert.ok(claim); assert.equal(claim.totalAttempts, i - 1);
    assert.equal(await h.run(), 'READY'); assert.equal(h.leases.size, 0);
    const saved = await h.store.read('goal');
    assert.equal(saved.job_status, 'READY'); assert.equal(saved.attempt_count, i);
    assert.equal(saved.retry_after, undefined);
    assert.equal(saved.recovery_failure, undefined);
    assert.equal(saved.history.filter(e => e.result === 'started').length, i);
    assert.equal(reduceHistory(saved).latestCompleted.result, 'incomplete');
  }
  assert.deepEqual(h.models.map(m => m.attempt), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(h.models.map(m => m.model), ['gpt-6-luna', 'gpt-6-luna', ...Array(4).fill('gpt-6.1-sol')]);
  assert.equal(selectWork(h.graph, await h.store.index()).score, -66);
});

test('configured profiles survive new visits while full score history stays available', async t => {
  const h = await fixture(t), calls = [];
  h.options.pipeline = { attemptModels: ['luna-6-high', 'luna-6-high', 'sol-6.1-medium'] };
  h.hooks.agent = async (_target, _workspace, _dir, attempt, _feedback, settings) => {
    const saved = await h.store.read('goal');
    const packet = JSON.parse(await readFile(settings.workerContextPath, 'utf8'));
    calls.push([settings.model, settings.reasoningEffort]);
    assert.equal(packet.selection.score, attempt === 1 ? 0 : -11 * (attempt - 1));
    assert.equal(saved.reasoning_effort, settings.reasoningEffort);
    assert.equal(saved.history.find(e => e.result === 'started' && e.attempt === attempt).reasoning_effort, settings.reasoningEffort);
    return { ready: false, explanation: 'A concrete mathematical obstacle remains.' };
  };
  for (let attempt = 1; attempt <= 5; attempt++) {
    await h.store.claim(h.graph, h.options);
    assert.equal(await h.run(), 'READY');
  }
  assert.deepEqual(calls, [['gpt-6-luna', 'high'], ['gpt-6-luna', 'high'],
    ['gpt-6.1-sol', 'medium'], ['gpt-6.1-sol', 'medium'], ['gpt-6.1-sol', 'medium']]);
  const saved = await h.store.read('goal');
  assert.equal(saved.history.length, 10);
  assert.equal(selectWork(h.graph, await h.store.index()).score, -55);
});

test('a configured Terra schedule escalates saved incomplete attempts to Sol High', async t => {
  const h = await fixture(t);
  h.options.pipeline.attemptModels = ['terra-6.1-medium'];
  for (let attempt = 1; attempt <= 4; attempt++) {
    const restarted = new JobStore(h.runs);
    const claim = await restarted.claim(h.graph, h.options);
    assert.ok(claim);
    assert.equal(claim.automatic_escalation, attempt > 2);
    assert.equal(await h.run(), 'READY');
    const saved = await restarted.read('goal');
    assert.equal(saved.reasoning_effort, attempt <= 2 ? 'medium' : 'high');
    if (attempt > 2) {
      assert.equal(saved.escalation.automatic, true);
      assert.equal(saved.escalation.trigger_attempt, 2);
      assert.equal(saved.escalation.attempts, attempt - 3);
    }
  }
  assert.deepEqual(h.models.map(m => m.model), ['gpt-6.1-terra', 'gpt-6.1-terra', 'gpt-6.1-sol', 'gpt-6.1-sol']);
});

test('runner saves an incomplete handoff and supplies scouting evidence on the next visit without another model stage', async t => {
  const h = await fixture(t);
  let invocations = 0;
  const explanation = 'Remaining obligation: Prove the successor recurrence.\n\n' +
    'Completed work: Base case drafted, not compiler checked.\n\n' +
    'Failed routes: Simplification alone does not expose the recurrence.\n\n' +
    'Next step: Apply the recurrence lemma.';
  const context = { previous_submissions: [{ id: 'old-proof', status: 'CE', error_message: 'unknown constant oldLemma' }],
    milestone_history: [{ reason: 'Earlier statement lost positivity.', changed_fields: ['theorem_id'],
      old_values: { theorem_id: 'old' }, new_values: { theorem_id: 'goal' } }] };
  h.hooks.agent = async (_target, _workspace, _dir, attempt, _feedback, settings) => {
    invocations++;
    const packet = JSON.parse(await readFile(settings.workerContextPath, 'utf8'));
    assert.equal(packet.scouting_evidence.rejected_submissions[0].id, 'old-proof');
    assert.match(packet.scouting_evidence.milestone_changes[0].reason, /positivity/);
    if (attempt === 2) {
      assert.equal(packet.recent_attempts[0].handoff.remaining_obligation, 'Prove the successor recurrence.');
      assert.equal(packet.recent_attempts[0].handoff.next_step, 'Apply the recurrence lemma.');
    }
    return { ready: false, kind: 'proof', explanation };
  };
  for (let attempt = 1; attempt <= 2; attempt++) {
    assert.ok(await h.store.claim(h.graph, h.options));
    assert.equal(await solveLeaf(h.client, h.target, context, h.environment, h.options, h.hooks), 'READY');
    const saved = await h.store.read('goal');
    assert.equal(await readFile(saved.previous_candidate.explanation_path, 'utf8'), explanation);
    assert.equal(saved.history.at(-1).result, 'incomplete');
    assert.equal(saved.attempt_count, attempt);
  }
  assert.equal(invocations, 2, 'one proof invocation per selected mathematical attempt');
});

test('runner retrieves at most three accepted sources before proving, reuses snapshots, and exposes unavailable evidence', async t => {
  const h = await fixture(t), reads = [];
  const context = { previous_submissions: Array.from({ length: 5 }, (_, i) => ({
    id: `s${i}`, status: i === 4 ? 'CE' : 'SKETCH_ACCEPTED', explanation: `Argument ${i}`,
  })) };
  h.client.request = async path => {
    if (!path.startsWith('submissions/')) return h.target;
    reads.push(path);
    if (path === 'submissions/s2/solution') throw new Error('Source unavailable');
    return { content: 'theorem solution : True := by trivial', file_path: 'internal/server/path' };
  };
  let invocations = 0;
  h.hooks.agent = async (_target, _workspace, _dir, attempt, _feedback, settings) => {
    invocations++;
    assert.equal(reads.length, attempt === 1 ? 3 : 4, 'retrieval finishes before the proof invocation');
    const packet = JSON.parse(await readFile(settings.workerContextPath, 'utf8'));
    const [first, second, missing] = packet.scouting_evidence.accepted_submissions;
    for (const row of [first, second]) {
      const artifact = JSON.parse(await readFile(row.source_artifact_path, 'utf8'));
      assert.equal(artifact.submission_id, row.id);
      assert.equal(artifact.mathlib_rev, h.environment.mathlib_rev);
      assert.equal(artifact.solution.content, 'theorem solution : True := by trivial');
    }
    assert.equal(missing.source_error, 'Source unavailable');
    assert.equal(missing.source_artifact_path, undefined);
    return { ready: false, kind: 'proof', explanation: 'The remaining recurrence still needs a proof.' };
  };
  for (let i = 0; i < 2; i++) {
    assert.ok(await h.store.claim(h.graph, h.options));
    assert.equal(await solveLeaf(h.client, h.target, context, h.environment, h.options, h.hooks), 'READY');
  }
  assert.deepEqual(reads, ['submissions/s0/solution', 'submissions/s1/solution',
    'submissions/s2/solution', 'submissions/s2/solution']);
  assert.equal(invocations, 2);
});

test('incomplete answers without Lean files retain mathematical outcomes and Sol escalation', async t => {
  const h = await fixture(t), calls = [];
  h.hooks.agent = async (_target, workspace, _dir, _attempt, _feedback, settings) => {
    calls.push(settings.model);
    return { ready: false, kind: 'proof', solution: join(workspace, 'Solutions/missing.lean'),
      module: 'Solutions.missing', explanation: 'The unresolved coefficient identity requires finite expansion of ideal powers and homogeneous component products.' };
  };
  for (let i = 0; i < 4; i++) {
    assert.ok(await h.store.claim(h.graph, h.options));
    assert.equal(await h.run(), 'READY');
    const state = await h.store.read('goal');
    assert.equal(reduceHistory(state).latestCompleted.result, 'incomplete');
    assert.equal(state.history.at(-1).failure.category, 'incomplete_argument');
    assert.equal(state.feedback, 'The unresolved coefficient identity requires finite expansion of ideal powers and homogeneous component products.');
    const candidate = JSON.parse(await readFile(join(h.runs, 'goal', `candidate-${i + 1}.json`), 'utf8'));
    assert.equal(candidate.source, null);
  }
  assert.deepEqual(calls, ['gpt-6-luna', 'gpt-6-luna', 'gpt-6.1-sol', 'gpt-6.1-sol']);
});

test('reworded concrete blockers with unchanged code retain Sol through saved candidate evidence', async t => {
  const h = await fixture(t), calls = [];
  const explanations = [
    'The unresolved coefficient identity requires finite expansion of ideal powers and homogeneous component products.',
    'Finite expansion for homogeneous component products and ideal powers is missing; the coefficient identity is unproved.',
    'The remaining obstacle is the coefficient identity for ideal powers, homogeneous component products, and their finite expansion.',
  ];
  h.hooks.agent = async (_target, workspace, _dir, attempt, _feedback, settings) => {
    calls.push(settings.model);
    const solution = join(workspace, 'Solutions/Sol_goal.lean');
    await writeFile(solution, `import Mathlib\n-- updated research notes ${attempt}\n`);
    return { ready: false, kind: 'proof', solution, module: 'Solutions.Sol_goal', children: [], definitions: [],
      explanation: explanations[(attempt - 1) % 3] };
  };
  for (let attempt = 1; attempt <= 5; attempt++) {
    assert.ok(await h.store.claim(h.graph, h.options));
    assert.equal(await h.run(), 'READY');
    const saved = await h.store.read('goal');
    assert.equal(saved.history.at(-1).failure.stagnation.schema_version, 2);
    if (attempt === 4) {
      assert.equal(saved.escalation.evidence_kind, 'unchanged_code_repeated_blocker');
      assert.equal(saved.escalation.evidence_attempts, 3);
    }
  }
  assert.deepEqual(calls, ['gpt-6-luna', 'gpt-6-luna', 'gpt-6-luna', 'gpt-6.1-sol', 'gpt-6.1-sol']);
});

test('saved Sol escalation ends on proof progress, then a new Luna stall escalates again', async t => {
  const h = await fixture(t), calls = [];
  h.hooks.agent = async (_target, workspace, _dir, attempt, _feedback, settings) => {
    calls.push(settings.model);
    const solution = join(workspace, 'Solutions/Sol_goal.lean');
    await writeFile(solution, 'import Mathlib\n' + (attempt >= 5 ? 'lemma advance : True := by trivial\n' : ''));
    return { ready: false, kind: 'proof', solution, module: 'Solutions.Sol_goal',
      explanation: 'The unresolved coefficient identity requires finite expansion of ideal powers and homogeneous component products.' };
  };
  for (let attempt = 1; attempt <= 8; attempt++) {
    assert.ok(await new JobStore(h.runs).claim(h.graph, h.options));
    assert.equal(await h.run(), 'READY');
  }
  assert.deepEqual(calls, ['gpt-6-luna', 'gpt-6-luna', 'gpt-6.1-sol', 'gpt-6.1-sol',
    'gpt-6.1-sol', 'gpt-6-luna', 'gpt-6-luna', 'gpt-6.1-sol']);
});

test('a superseded rescue releases its claim without spending a proof attempt', async t => {
  const h = await fixture(t);
  assert.ok(await h.store.claim(h.graph, h.options));
  h.hooks.beforeModel = async () => false;
  assert.equal(await h.run(), 'READY');
  const state = await h.store.read('goal');
  assert.equal(state.job_status, 'READY'); assert.equal(state.attempt_count, 0);
  assert.equal(state.history.length, 0); assert.equal(h.models.length, 0); assert.equal(h.leases.size, 0);
});

test('Luna keeps working while successive incomplete attempts contain changed mathematical output', async t => {
  const h = await fixture(t), calls = [], fingerprints = [];
  h.hooks.agent = async (_target, workspace, _dir, attempt, _feedback, settings) => {
    calls.push(settings.model);
    const solution = join(workspace, 'Solutions/progress.lean');
    await writeFile(solution, `-- new partial argument ${attempt}\n`);
    return { ready: false, kind: 'proof', explanation: `Reduced to obligation ${attempt}.`, solution, module: 'Solutions.progress' };
  };
  for (let i = 0; i < 4; i++) {
    assert.ok(await h.store.claim(h.graph, h.options));
    assert.equal(await h.run(), 'READY');
    const state = await h.store.read('goal');
    fingerprints.push(state.history.at(-1).failure.stagnation.fingerprint);
  }
  assert.deepEqual(calls, Array(4).fill('gpt-6-luna'));
  assert.equal(new Set(fingerprints).size, 4);
});

test('saved stalled backlog resumes immediately and its one Sol rescue can submit an exact disproof', async t => {
  const h = await fixture(t);
  h.target.formal_statement = 'theorem goal : False := by sorry';
  h.options.recovery = { initialDelayMs: 30000, maxDelayMs: 900000 };
  for (let i = 0; i < 2; i++) {
    assert.ok(await h.store.claim(h.graph, h.options));
    assert.equal(await h.run(), 'READY');
  }
  const previous = await h.store.read('goal');
  previous.retry_after = new Date(Date.now() + 900000).toISOString();
  previous.recovery_failure = { message: 'incomplete_argument', count: 2 };
  await save(h.store.path('goal'), previous);
  const restarted = new JobStore(h.runs);
  assert.ok(await restarted.claim(h.graph, h.options));
  const posts = [];
  h.client.submit = async (...args) => { posts.push(args); return { submission_id: 'disproof' }; };
  h.hooks.poll = async () => ({ status: 'ACCEPTED' });
  h.hooks.agent = async (_target, workspace, _dir, attempt, _feedback, settings) => {
    assert.equal(attempt, 3); assert.equal(settings.model, 'gpt-6.1-sol'); assert.equal(settings.reasoningEffort, 'high');
    const saved = await restarted.read('goal');
    assert.equal(saved.escalation.trigger_attempt, 2);
    assert.equal(saved.history.filter(e => e.result === 'started').length, 3);
    const manifest = JSON.parse(await readFile(settings.attemptContextPath, 'utf8'));
    assert.equal(manifest.escalation.reason, 'repeated_incomplete');
    const packet = JSON.parse(await readFile(settings.workerContextPath, 'utf8'));
    assert.equal(packet.escalation.trigger_attempt, 2);
    const solution = join(workspace, 'Solutions/Sol_goal.lean');
    await writeFile(solution, 'theorem solution : ¬ False := by simp');
    return { kind: 'counterexample', ready: false, explanation: 'False is false.', solution,
      module: 'Solutions.Sol_goal', children: [], definitions: [] };
  };
  assert.equal(await h.run(), 'DISPROVED');
  assert.equal(posts.length, 1); assert.equal(posts[0][3], 'disprove');
  assert.equal((await restarted.read('goal')).history.at(-1).result, 'disproof_accepted');
});

test('scores use closability and history, yield to competitors, and permit negative winners', () => {
  const a = { ...node('a'), closability: 3 }, b = { ...node('b'), closability: 2 };
  const graph = { root: { ...node('root'), reductions: undefined }, leaves: [a, b] };
  assert.equal(selectWork(graph).theorem_id, 'a');
  const states = new Map([['a', { attempt_count: 1, status: 'READY' }]]);
  assert.equal(selectWork(graph, states).theorem_id, 'b');
  states.set('b', { attempt_count: 10, status: 'READY' });
  states.set('a', { attempt_count: 11, status: 'READY' });
  assert.ok(selectWork(graph, states).score < 0);
});

test('first broken parent is scored as a direct proof even with surviving open children and accepted history', () => {
  const graph = brokenGraph();
  const states = new Map([['parent', { attempt_count: 20, status: 'SKETCH_ACCEPTED', job_status: 'DONE', submission_id: 'accepted-reduction' }]]);
  const selected = selectWork(graph, states);
  assert.equal(selected.theorem_id, 'parent'); assert.equal(selected.task_kind, 'parent');
  assert.equal(selected.closability, 1); assert.equal(selected.operation, 'reconsider_reduction');
  assert.equal(selected.totalAttempts, 20); assert.equal(selected.attemptsInCurrentContext, 0);
  assert.equal(workFrontier(graph).needed.has('parent'), true);
  assert.equal(workFrontier(graph).needed.has('open'), false);
  graph.nodes[1].reductions.push({ submission_id: 'alternative', children: [graph.nodes[3]] });
  assert.equal(selectWork(graph, states).theorem_id, 'open');
});

test('batched relevant changes deduplicate across refresh/restart and preserve in-flight awareness', async t => {
  const h = await fixture(t), graph = brokenGraph(), parent = graph.nodes[1];
  graph.nodes[2].status = 'Open';
  let state = observeContext(historyState({ attempt_count: 3 }), parent, new Map(graph.nodes.map(n => [n.theorem_id, n])));
  appendEvent(state, { event_id: 'a:start', event_type: 'attempt', attempt_id: 'a', attempt: 4, result: 'started', context_id: state.context_id });
  graph.nodes[2].status = 'Disproved'; graph.nodes[3].deprecated_at = 'yesterday';
  state = observeContext(state, parent, new Map(graph.nodes.map(n => [n.theorem_id, n])));
  assert.equal(state.history.filter(e => e.event_type === 'context_change').length, 1);
  assert.equal(state.history.at(-1).evidence.dependencies.length, 2);
  assert.equal(reduceHistory(state).attemptsInCurrentContext, 0);
  const roundtrip = JSON.parse(JSON.stringify(state));
  assert.deepEqual(observeContext(roundtrip, parent, new Map(graph.nodes.map(n => [n.theorem_id, n]))), roundtrip);
  const unrelated = node('unrelated', 'Proved'); graph.nodes.push(unrelated);
  assert.equal(observeContext(state, parent, new Map(graph.nodes.map(n => [n.theorem_id, n]))).history.length, state.history.length);
});

test('graph observation during a model call merges history without changing that invocation context', async t => {
  const h = await fixture(t);
  await h.store.claim(h.graph, h.options);
  h.hooks.agent = async (_target, _workspace, _dir, attempt, _feedback, settings) => {
    const manifest = JSON.parse(await readFile(settings.attemptContextPath, 'utf8'));
    const changed = structuredClone(h.graph);
    changed.nodes[0].formal_statement += '\n-- relevant target change';
    await h.store.observeGraph(changed);
    assert.equal(manifest.context_id, 'initial');
    return { ready: false, explanation: 'incomplete' };
  };
  assert.equal(await h.run(), 'READY');
  const saved = await h.store.read('goal');
  assert.notEqual(saved.context_id, 'initial');
  assert.equal(saved.history.find(e => e.result === 'started').context_id, 'initial');
  assert.equal(saved.history.find(e => e.result === 'incomplete').context_id, 'initial');
  assert.equal(reduceHistory(saved).attemptsInCurrentContext, 0);
});

test('an observed environment fingerprint change renews context without resetting lifetime model policy', async t => {
  const h = await fixture(t);
  await h.store.claim(h.graph, h.options); assert.equal(await h.run(), 'READY');
  await h.store.claim(h.graph, h.options);
  h.environment.toolchain = 'leanprover/lean4:v4.34.0';
  assert.equal(await h.run(), 'READY');
  assert.equal(h.models[1].attempt, 2); assert.equal(h.models[1].manifest.current_context_attempts, 0);
  assert.notEqual(h.models[1].manifest.context_id, h.models[0].manifest.context_id);
  const saved = await h.store.read('goal');
  assert.equal(saved.attempt_count, 2); assert.equal(saved.history.filter(e => e.event_type === 'context_change').length, 1);
});

test('migration backs up real counters, remains idempotent, and read-only ranking changes no files', async t => {
  const h = await fixture(t);
  await mkdir(join(h.runs, 'goal'), { recursive: true });
  const legacy = { theorem_id: 'goal', attempt: 9, status: 'UNRESOLVED', feedback: 'old diagnostic' };
  await writeFile(h.store.path('goal'), JSON.stringify(legacy));
  const discover = async () => h.graph;
  const preview = scoreWork(await buildGraph({}, 'goal', { runs: h.runs, readOnly: true }, discover));
  assert.equal(preview[0].totalAttempts, 9); assert.equal(preview[0].score, -99);
  assert.deepEqual(JSON.parse(await readFile(h.store.path('goal'), 'utf8')), legacy);
  assert.deepEqual(await readdir(join(h.runs, 'goal')), ['state.json']);
  await h.store.claim(h.graph, h.options); assert.equal(await h.run(), 'READY');
  const migrated = await h.store.read('goal');
  assert.equal(migrated.attempt_count, 10); assert.equal(migrated.history.length, 2);
  assert.equal(migrated.legacy_baseline.attempts, 9);
  assert.deepEqual(JSON.parse(await readFile(h.store.path('goal') + '.legacy.json', 'utf8')), legacy);
  await h.store.ensure('goal'); assert.deepEqual(await h.store.read('goal'), migrated);
});

test('a crash between candidate rename and state reference recovers the saved candidate without another model', async t => {
  const h = await fixture(t), replace = h.store.replace;
  h.hooks.agent = async (_target, workspace) => {
    h.models.push('called');
    const solution = join(workspace, 'Solutions/Sol_goal.lean');
    await writeFile(solution, 'theorem solution : True := by trivial');
    return { ready: true, kind: 'proof', solution, module: 'Solutions.Sol_goal', explanation: 'Trivial.', children: [], definitions: [] };
  };
  let crash = true, posts = 0;
  t.mock.method(JobStore.prototype, 'replace', async function(state, revision, settings) {
    if (crash && state.stage === 'VALIDATE') { crash = false; throw new Error('crash before reference commit'); }
    return replace.call(this, state, revision, settings);
  });
  await assert.rejects(h.run(), /crash before reference commit/);
  assert.equal((await h.store.read('goal')).stage, 'CODEX');
  h.client.submit = async () => { posts++; return { submission_id: 'sub' }; };
  h.hooks.poll = async () => ({ status: 'ACCEPTED' });
  assert.equal(await h.run(), 'ACCEPTED');
  assert.equal(h.models.length, 1); assert.equal(posts, 1);
  const saved = await h.store.read('goal');
  assert.equal(saved.attempt_count, 1); assert.equal(saved.history.at(-1).result, 'proof_accepted');
});

test('score preview is deterministic and CLI attempts warns only when explicitly supplied', async t => {
  const warnings = [], tables = [], previousKey = process.env.PROVE2ME_API_KEY;
  process.env.PROVE2ME_API_KEY = 'offline-test';
  t.after(() => { if (previousKey === undefined) delete process.env.PROVE2ME_API_KEY; else process.env.PROVE2ME_API_KEY = previousKey; });
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', text => warnings.push(text));
  t.mock.method(console, 'table', rows => tables.push(rows));
  t.mock.method(globalThis, 'fetch', () => assert.fail('offline CLI test must not use the network'));
  const parent = node('continuous_preview_parent'), dead = node('continuous_preview_dead', 'Disproved'), open = node('continuous_preview_open');
  t.mock.method(Client.prototype, 'request', async function(path, options) {
    assert.ok(!options?.method || options.method === 'GET');
    if (path === 'missions/continuous-preview') return { id: 'continuous-preview', name: 'Preview', main_theorem: parent };
    if (path.endsWith('/decompositions')) return { decompositions: path.includes('parent') ? [{ submission_id: 'old-reduction', children: [dead, open] }] : [] };
    return parent;
  });
  await main(['--mission-id', 'continuous-preview', '--list']);
  assert.equal(warnings.length, 0);
  await main(['--mission-id', 'continuous-preview', '--list', '--attempts', '1']);
  assert.equal(warnings.length, 1); assert.match(warnings[0], /deprecated.*no longer caps/);
  assert.equal(tables[0][0].kind, 'parent'); assert.equal(tables[0][0].operation, 'reconsider_reduction');
  assert.deepEqual(tables[0], tables[1]);
  for (const n of ['0', '-1', '1.5', 'abc']) await assert.rejects(main(['--mission-id', 'continuous-preview', '--list', `--attempts=${n}`]), /positive integer/);
  const graph = brokenGraph();
  assert.deepEqual(scoreWork(graph), scoreWork(graph), 'pure projections do not consult wall-clock time');
});

test('corrupt structured history fails without resetting consumption', async t => {
  const h = await fixture(t), saved = await h.store.ensure('goal');
  saved.attempt_count = 2;
  appendEvent(saved, { event_id: 'skip:start', event_type: 'attempt', attempt_id: 'skip', attempt: 2, context_id: 'initial', result: 'started' });
  await save(h.store.path('goal'), saved);
  await assert.rejects(h.store.read('goal'), /Invalid structured job history/);
  assert.equal(JSON.parse(await readFile(h.store.path('goal'), 'utf8')).attempt_count, 2);
});

test('fresh scored claims serialize across roots, and an old callback cannot overwrite the next attempt', async t => {
  const h = await fixture(t);
  const claims = await Promise.all([h.store.claim(h.graph, h.options), new JobStore(h.runs).claim(h.graph, h.options)]);
  assert.equal(claims.filter(Boolean).length, 1);
  const old = claims.find(Boolean).job;
  assert.equal(await h.run(), 'READY');
  const next = await h.store.claim(h.graph, h.options);
  assert.equal(await h.store.completeAction(old.job_id, old.revision, { status: 'ACCEPTED' }), false);
  assert.equal((await h.store.read('goal')).revision, next.job.revision);
});

test('production pipeline reclaims a non-leaf accepted parent and provides its sketch and refutation evidence', async t => {
  const h = await fixture(t), graph = brokenGraph(), parent = graph.nodes[1];
  const old = await h.store.ensure('parent', { attempts: 3 });
  const path = join(h.runs, 'parent', 'candidate-9.json');
  const source = 'import Theorems.Thm_dead\ntheorem solution : True := by trivial';
  await save(path, { source, source_hash: digest(source), attempt: 9,
    candidate: { kind: 'sketch', module: 'Solutions.Sol_goal', solution: 'old-workspace', explanation: 'Accepted original argument.' } });
  Object.assign(old, { schema_version: 1, attempt_count: 9, attempts_used_in_job: 9, attempt_budget: 3,
    status: 'SKETCH_ACCEPTED', job_status: 'DONE', stage: 'SERVER', operation: 'poll_submission',
    submission_id: 'accepted-reduction', candidate: { path, source_hash: digest(source), attempt: 9 },
    artifact_manifest: { source }, sketch: { source, explanation: 'Accepted original argument.' } });
  delete old.history; delete old.legacy_baseline; delete old.context_id;
  await save(h.store.path('parent'), old);
  await save(h.store.path('dead'), { theorem_id: 'dead', status: 'DISPROVED', attempt_count: 1,
    counterexample: { snapshot: 'refutation.lean' }, verdict: { status: 'ACCEPTED' } });
  let completed = false, invocations = 0;
  const hooks = { ...h.hooks,
    frontier: async () => ({ ...graph, root: { ...graph.root, status: completed ? 'Proved' : 'Open' } }),
    agent: async (target, workspace, _dir, attempt, _feedback, settings) => {
      invocations++;
      assert.equal(target.theorem_id, 'parent'); assert.equal(attempt, 10);
      assert.equal(settings.model, 'gpt-6-luna'); assert.equal(settings.operation, 'reconsider_reduction');
      const manifest = JSON.parse(await readFile(settings.attemptContextPath, 'utf8'));
      assert.equal(manifest.accepted_sketch.source, source);
      assert.equal(manifest.current_context_attempts, 0);
      assert.equal(manifest.legacy_baseline.awareness, 'unknown');
      const evidence = manifest.dependency_evidence.find(d => d.theorem_id === 'dead');
      assert.equal(evidence.status, 'Disproved'); assert.equal(evidence.evidence_status, 'server_accepted');
      assert.equal(evidence.certificate.snapshot, 'refutation.lean');
      assert.equal(manifest.accepted_reductions[0].submission_id, 'accepted-reduction');
      assert.equal((await readFile(manifest.accepted_reductions[0].path, 'utf8')).includes('Original accepted reduction'), true);
      const solution = join(workspace, 'Solutions/Sol_goal.lean');
      assert.equal(await readFile(solution, 'utf8'), source);
      await writeFile(solution, 'theorem solution : True := by trivial');
      return { ready: true, kind: 'proof', children: [], definitions: [], module: 'Solutions.Sol_goal', solution, explanation: 'Direct proof.' };
    },
    poll: async () => { completed = true; return { status: 'ACCEPTED' }; },
  };
  h.client.request = async path => path === 'environments' ? { environments: [h.environment] }
    : path === 'theorems/root' ? { ...graph.root, status: completed ? 'Proved' : 'Open' }
    : path === 'submissions/accepted-reduction/solution' ? { content: 'Original accepted reduction' }
      : path.endsWith('/decompositions') ? { decompositions: parent.reductions } : parent;
  h.client.pages = async () => [];
  h.client.submit = async () => ({ submission_id: 'new-direct-proof' });
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(new Error('parent test timeout')), 10000);
  t.after(() => clearTimeout(timer));
  const result = await runTarget(h.client, { root: 'root', name: 'Mission' }, { ...h.options, signal: controller.signal }, hooks);
  assert.equal(result.completed, true); assert.equal(invocations, 1);
  const saved = await h.store.read('parent');
  assert.equal(saved.attempt_count, 10); assert.equal(saved.history.filter(e => e.event_type === 'context_change').length, 1);
  assert.equal(saved.history.at(-1).result, 'proof_accepted');
  assert.equal((await h.store.read('open')), null);
});

test('production cycle repair carries member evidence and accepted reductions into the invocation', async t => {
  const h = await fixture(t), root = node('root'), a = node('a'), b = node('b');
  const dependency = n => ({ theorem_id: n.theorem_id, theorem_name: n.theorem_name, status: n.status });
  root.reductions = [{ submission_id: 'root-to-a', children: [dependency(a)] }];
  a.reductions = [{ submission_id: 'a-to-b', children: [dependency(b)] }];
  b.reductions = [{ submission_id: 'b-to-a', children: [dependency(a)] }];
  const graph = { root, nodes: [root, a, b], leaves: [] };
  let completed = false, invocations = 0;
  h.client.request = async path => path === 'environments' ? { environments: [h.environment] }
    : path === 'theorems/root' ? { ...root, status: completed ? 'Proved' : 'Open' }
    : path === 'submissions/a-to-b/solution' ? { content: 'Original cyclic reduction' }
      : path.endsWith('/decompositions') ? { decompositions: a.reductions } : a;
  h.client.pages = async () => [];
  h.client.submit = async () => ({ submission_id: 'independent-proof' });
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(new Error('cycle test timeout')), 10000);
  t.after(() => clearTimeout(timer));
  const result = await runTarget(h.client, { root: 'root', name: 'Mission' }, { ...h.options, signal: controller.signal }, {
    ...h.hooks,
    frontier: async () => ({ ...graph, root: { ...root, status: completed ? 'Proved' : 'Open' } }),
    agent: async (target, workspace, _dir, _attempt, _feedback, settings) => {
      invocations++;
      assert.equal(target.theorem_id, 'a');
      assert.equal(settings.operation, 'reconsider_reduction');
      const manifest = JSON.parse(await readFile(settings.attemptContextPath, 'utf8'));
      assert.equal(manifest.selection.selection_reason, 'cyclic_reduction');
      assert.deepEqual(manifest.selection.cycle_members.map(n => n.theorem_id), ['a', 'b']);
      assert.equal(manifest.accepted_reductions[0].submission_id, 'a-to-b');
      assert.match(await readFile(manifest.accepted_reductions[0].path, 'utf8'), /Original cyclic reduction/);
      const solution = join(workspace, 'Solutions/Sol_goal.lean');
      await writeFile(solution, 'theorem solution : True := by trivial');
      return { ready: true, kind: 'proof', children: [], definitions: [], module: 'Solutions.Sol_goal', solution, explanation: 'Independent proof.' };
    },
    poll: async () => { completed = true; return { status: 'ACCEPTED' }; },
  });
  assert.equal(result.completed, true); assert.equal(invocations, 1);
  assert.equal((await h.store.read('a')).history.at(-1).result, 'proof_accepted');
  // Preparation can prefetch the other cycle member before the first verdict.
  // Completing the root must retire it without spending a mathematical attempt.
  const unused = await h.store.read('b');
  if (unused) {
    assert.equal(unused.attempt_count, 0);
    assert.equal(unused.job_status, 'RETIRED');
  }
});

test('accepted results and missing sketch propagation park; rejected disproofs remain selectable', () => {
  const graph = { root: { ...node('root'), reductions: undefined }, leaves: [node('goal')] };
  for (const status of ['ACCEPTED', 'DISPROVED', 'SKETCH_ACCEPTED', 'COUNTEREXAMPLE', 'PENDING']) {
    assert.equal(selectWork(graph, new Map([['goal', { status, attempt_count: 1 }]])), null);
  }
  assert.equal(selectWork(graph, new Map([['goal', { status: 'DISPROOF_REJECTED', attempt_count: 10 }]])).theorem_id, 'goal');
  assert.equal(selectWork(graph, new Map([['goal', { status: 'COUNTEREXAMPLE', job_status: 'RETIRED', attempt_count: 10 }]])).theorem_id, 'goal',
    'a retired certificate is recovered when it becomes relevant again');
});

test('pipeline releases a full local/remote pool after failures and keeps selecting until success', async t => {
  const h = await fixture(t), attempted = [], completed = new Set(), targets = ['a', 'b'].map(id => node(id));
  let posts = 0;
  const hooks = { ...h.hooks,
    frontier: async () => ({ root: { ...node('root'), reductions: undefined, status: completed.size === 2 ? 'Proved' : 'Open' }, leaves: targets }),
    agent: async (target, workspace, _dir, attempt) => {
      attempted.push(target.theorem_id);
      const solution = join(workspace, 'Solutions/Sol_goal.lean');
      await writeFile(solution, 'theorem solution : True := by trivial');
      return { ready: true, kind: 'proof', solution, module: 'Solutions.Sol_goal', explanation: 'Trivial.', children: [], definitions: [] };
    },
    poll: async (_client, id) => {
      const target = id.split(':')[1];
      if (posts <= 4) return { status: 'CE', error_message: 'server diagnostic' };
      completed.add(target); return { status: 'ACCEPTED' };
    },
  };
  h.client.request = async path => path === 'environments' ? { environments: [h.environment] }
    : path === 'theorems/root' ? { ...node('root'), status: completed.size === 2 ? 'Proved' : 'Open' }
      : path.endsWith('/decompositions') ? { decompositions: [] } : targets.find(n => path.endsWith(n.theorem_id));
  h.client.pages = async () => [];
  h.client.submit = async id => ({ submission_id: `${++posts}:${id}` });
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(new Error('continuous test timeout')), 15000);
  t.after(() => clearTimeout(timeout));
  const result = await runTarget(h.client, { root: 'root', name: 'Mission' }, { ...h.options, signal: controller.signal,
    pipeline: { verificationMode: 'server-only', maxActiveJobs: 1, maxRemoteJobs: 1 }, graphRefreshInterval: 300 }, hooks);
  assert.equal(result.completed, true); assert.equal(result.pipeline.active, 0);
  assert.deepEqual(attempted, ['a', 'b', 'a', 'b', 'a', 'b']);
  assert.equal(h.leases.size, 0);
  assert.equal((await h.store.read('a')).attempt_count, 3);
});
