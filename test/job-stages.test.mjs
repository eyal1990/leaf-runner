import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJobStages } from '../job-stages.mjs';
import { createRemoteActions } from '../remote-actions.mjs';
import { agentPrompt, answerRepairPrompt, WORKSPACE_INSTRUCTIONS } from '../agent-prompts.mjs';
import { prepareAgentEnvironment } from '../prove2me.mjs';
import { withBuildSlot } from '../shared-resources.mjs';

async function fixture(t, { counterexample = false, commandHook, mirrorHook } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'prove2me-stages-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.mock.method(console, 'log', () => {});
  const workspace = join(root, 'workspace'), dir = join(root, 'runs', 'leaf');
  await mkdir(join(workspace, 'Solutions'), { recursive: true });
  await mkdir(dir, { recursive: true });
  const target = { theorem_id: 'leaf', theorem_name: 'goal', mathlib_rev: 'a'.repeat(40), status: 'Open', preamble: '',
    formal_statement: `theorem goal (n : Nat) : n = ${counterexample ? '0' : 'n'} := by sorry` };
  const source = counterexample ? 'theorem solution : ¬ (∀ n : Nat, n = 0) := by intro h; cases h 1'
    : 'theorem solution (n : Nat) : n = n := by rfl';
  const candidate = { ready: !counterexample, kind: counterexample ? 'counterexample' : 'proof',
    children: [], definitions: [], explanation: 'Original mathematics.',
    solution: join(workspace, 'Solutions/Sol_leaf.lean'), module: 'Solutions.Sol_leaf' };
  const events = [], uploads = [], state = { theorem_id: 'leaf', submissions: [] };
  const statePath = join(dir, 'state.json');
  const client = { request: async () => target,
    submit: async (_id, bytes, explanation, proofType) => {
      const saved = JSON.parse(await readFile(statePath, 'utf8'));
      assert.equal(saved.status, 'SUBMITTING');
      assert.equal(saved.proof_type, proofType);
      events.push('submit'); uploads.push({ bytes, explanation, proofType });
      return { submission_id: 'submission' };
    } };
  let running = 0;
  const command = async (_exe, args, settings) => {
    assert.equal(running++, 0, 'builds/checks must be sequential');
    events.push(args[0]);
    if (commandHook) await commandHook(settings);
    else await new Promise(resolve => setImmediate(resolve));
    running--;
  };
  const options = { lake: 'lake', pollTimeout: 0, verificationMode: 'local' };
  const stages = createJobStages({ client, target, context: {}, environment: { toolchain: 'leanprover/lean4:v4.33.1' },
    options, dir, ensureWorkspace: async () => workspace, mirror: mirrorHook ?? (async () => []), command, pins: () => '-- trusted pins\n',
    releaseWorkspace: async path => { assert.equal(path, workspace); events.push('release'); },
    agent: async () => { events.push('model'); await writeFile(candidate.solution, source); return candidate; },
    repairAnswer: async (_target, _workspace, _dir, _attempt, _feedback, answer) => {
      events.push('format_model'); return { ...answer, explanation: 'Original mathematics.' };
    } });
  const remote = createRemoteActions({ client, target, state, statePath, options,
    hooks: { poll: async () => ({ status: 'ACCEPTED' }) } });
  return { workspace, dir, target, candidate, source, events, uploads, stages, remote };
}

test('readiness and validations across jobs all use the same build slot', async t => {
  let live = 0, calls = 0;
  const run = async ({ log }) => {
    assert.equal(++live, 1, 'readiness and validation builds must not overlap'); calls++;
    await new Promise(resolve => setTimeout(resolve, 5));
    await writeFile(log, 'RUNNER_ENVIRONMENT_READY'); live--;
  };
  const a = await fixture(t, { commandHook: run }), b = await fixture(t, { commandHook: run });
  const candidates = await Promise.all([a, b].map(h => h.stages.invokeModel({ workspace: h.workspace, attempt: 1 })));
  await Promise.all([
    ...[a, b].map((h, index) => h.stages.validate({ workspace: h.workspace, knownDependencies: [], candidate: candidates[index].candidate, attempt: 1 })),
    prepareAgentEnvironment(a.target, a.workspace, a.dir, { codex: 'codex', lake: 'lake', verificationMode: 'local' }, {
      executable: async () => ['lake'], platform: 'linux', command: async (_exe, _args, settings) => run(settings),
    }),
  ]);
  assert.equal(calls, 5); assert.equal(live, 0);
});

test('a queued readiness build cannot split candidate compilation from its type check', async t => {
  const order = [];
  let started, release;
  const compiling = new Promise(resolve => { started = resolve; });
  const finishBuild = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const h = await fixture(t, { commandHook: async ({ log }) => {
    if (log.endsWith('lean-1.log')) {
      order.push('candidate build'); started(); await finishBuild;
    } else order.push('candidate type check');
  } });
  await writeFile(h.candidate.solution, h.source);
  const validation = h.stages.validate({ workspace: h.workspace, knownDependencies: [], candidate: h.candidate, attempt: 1 });
  await compiling;
  // Queue setup while the candidate still owns the compiler slot.
  const readiness = withBuildSlot(async () => { order.push('next job readiness'); });
  release();
  const [outcome] = await Promise.all([validation, readiness]);
  assert.equal(outcome.type, 'VALIDATED');
  assert.deepEqual(order, ['candidate build', 'candidate type check', 'next job readiness']);
});

test('failed initial mirroring releases the new workspace before surfacing its error', async t => {
  const h = await fixture(t, { mirrorHook: async () => { throw new Error('dependency fetch failed'); } });
  await assert.rejects(h.stages.prepare(), /dependency fetch failed/);
  assert.deepEqual(h.events, ['release']);
});

for (const counterexample of [false, true]) {
  test(`${counterexample ? 'counterexample' : 'direct proof'} stages validate and submit frozen artifacts without another model`, async t => {
    const h = await fixture(t, { counterexample });
    const prepared = await h.stages.prepare();
    assert.equal(prepared.type, 'PREPARED');
    const generated = await h.stages.invokeModel({ workspace: h.workspace, attempt: 1, feedback: '' });
    const outcome = await h.stages.validate({ ...prepared, candidate: generated.candidate, attempt: 1 });
    assert.equal(outcome.type, 'VALIDATED');
    assert.deepEqual(h.events, ['model', 'build', 'env']);
    const check = await readFile(join(h.dir, counterexample ? 'CheckCounterexample.lean' : 'CheckType.lean'), 'utf8');
    assert.match(check, /solution type does not match/);
    if (counterexample) { assert.match(check, /mkAppM ``Not/); assert.match(check, /collectAxioms/); }
    assert.ok(Object.isFrozen(outcome.artifact));
    assert.ok(Object.isFrozen(outcome.artifact.candidate.children));
    assert.throws(() => { outcome.artifact.candidate.explanation = 'Changed'; }, TypeError);
    const saved = JSON.parse(await readFile(join(h.dir, 'artifacts-1.json'), 'utf8'));
    assert.equal(saved.source, h.source);
    assert.equal(await readFile(saved.snapshot, 'utf8'), h.source);
    assert.equal(await readFile(saved.explanation_path, 'utf8'), saved.explanation);
    h.candidate.explanation = 'Later mutable answer';
    await writeFile(h.candidate.solution, 'theorem solution : False := by sorry');
    const result = await h.remote.submit(outcome.artifact, counterexample ? 'disprove' : 'prove');
    assert.deepEqual(result, { type: 'REMOTE_RESULT', status: counterexample ? 'DISPROVED' : 'ACCEPTED' });
    assert.deepEqual(h.uploads, [{ bytes: h.source, explanation: 'Original mathematics.', proofType: counterexample ? 'disprove' : 'prove' }]);
    await assert.rejects(h.remote.submit({ ...outcome.artifact, source: 'changed' }), /artifact identity changed/);
    assert.equal(h.uploads.length, 1);
  });
}

for (const counterexample of [false, true]) {
  test(`validation removes a PowerShell BOM before compiling and freezing a ${counterexample ? 'counterexample' : 'proof'}`, async t => {
    const h = await fixture(t, { counterexample });
    const prepared = await h.stages.prepare();
    await writeFile(h.candidate.solution, '\uFEFF' + h.source);
    const outcome = await h.stages.validate({ ...prepared, candidate: h.candidate, attempt: 1 });
    assert.equal(outcome.type, 'VALIDATED');
    assert.deepEqual(h.events, ['build', 'env']);
    assert.equal(await readFile(h.candidate.solution, 'utf8'), h.source);
    assert.equal(outcome.artifact.source, h.source);
    assert.equal(await readFile(outcome.artifact.snapshot, 'utf8'), h.source);
  });
}

test('validation requests a separate formatting invocation and never starts a model itself', async t => {
  const h = await fixture(t);
  const prepared = await h.stages.prepare();
  const generated = await h.stages.invokeModel({ workspace: h.workspace, attempt: 1 });
  generated.candidate.explanation = '';
  const invalid = await h.stages.validate({ ...prepared, candidate: generated.candidate, attempt: 1 });
  assert.equal(invalid.type, 'NEEDS_FORMAT_REPAIR');
  assert.deepEqual(h.events, ['model']);
  const repaired = await h.stages.invokeModel({ ...invalid, workspace: h.workspace, attempt: 1, operation: 'format_repair' });
  const valid = await h.stages.validate({ ...prepared, candidate: repaired.candidate, attempt: 1 });
  assert.equal(valid.type, 'VALIDATED');
  assert.deepEqual(h.events, ['model', 'format_model', 'build', 'env']);
});

test('proof, mathematical repair, format repair, and workspace instructions assign compilation to the runner', () => {
  const target = { theorem_id: 'leaf', formal_statement: 'theorem goal : True := by sorry' };
  for (const repairPrevious of [false, true]) {
    const prompt = agentPrompt(target, 'artifacts', repairPrevious ? 2 : 1, 'Lean: unsolved goals', 'Solutions/Sol_leaf.lean',
      { lake: 'custom-lake', repairPrevious, environmentReady: true });
    assert.match(prompt, /Do not launch Lake or Lean/);
    assert.match(prompt, /ready=true does not certify that it compiles/);
    assert.ok(!prompt.includes('Compile with'));
    assert.ok(!prompt.includes('Iterate on errors'));
    assert.ok(!prompt.includes('then rebuild'));
    assert.ok(!prompt.includes('custom-lake build'));
  }
  assert.match(WORKSPACE_INSTRUCTIONS, /Do not launch Lake or Lean/);
  assert.match(answerRepairPrompt('bad metadata', {}), /Do not .*launch Lake or Lean/);
});

test('proofOnly validates the saved assignment and blocks invalid candidates before reading source', async t => {
  const h = await fixture(t);
  const promptExperiment = { variant: 'proofOnly' };
  for (const fields of [
    { ready: false }, { ready: undefined }, { kind: 'sketch' },
    { kind: 'counterexample', ready: true }, { kind: 'counterexample', ready: undefined },
    { kind: 'counterexample', ready: false, children: [{}] },
    { kind: 'counterexample', ready: false, definitions: [{}] },
    { children: [{}] }, { definitions: [{}] },
  ]) {
    const candidate = { ...h.candidate, ...fields };
    const result = await h.stages.validate({ workspace: h.workspace, knownDependencies: [], candidate, attempt: 1, promptExperiment });
    assert.equal(result.type, 'INCOMPLETE');
    assert.match(result.feedback, /proofOnly requires/);
    await assert.rejects(h.stages.checkSubmission({ candidate }, [], promptExperiment), /proofOnly requires/);
  }
  assert.deepEqual(h.events, []);
  await writeFile(h.candidate.solution, h.source);
  const result = await h.stages.validate({ workspace: h.workspace, knownDependencies: [], candidate: h.candidate, attempt: 1, promptExperiment });
  assert.equal(result.type, 'VALIDATED');
  assert.deepEqual(h.events, ['build', 'env']);
});

test('proofOnly validates an exact disproof through compilation and the submission boundary', async t => {
  const h = await fixture(t, { counterexample: true });
  const promptExperiment = { variant: 'proofOnly' };
  await writeFile(h.candidate.solution, h.source);
  const result = await h.stages.validate({ workspace: h.workspace, knownDependencies: [],
    candidate: h.candidate, attempt: 1, promptExperiment });
  assert.equal(result.type, 'VALIDATED');
  assert.equal(result.plan.kind, 'counterexample');
  assert.deepEqual(h.events, ['build', 'env']);
  assert.equal(await h.stages.checkSubmission(result.artifact, [], promptExperiment), undefined);
  const check = await readFile(join(h.dir, 'CheckCounterexample.lean'), 'utf8');
  assert.match(check, /mkAppM ``Not/);
  assert.match(check, /collectAxioms/);
});
