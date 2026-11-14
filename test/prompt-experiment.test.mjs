import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { selectPrompt, PROMPT_EXPERIMENT } from '../prompt-experiment.mjs';
import { agentPrompt } from '../agent-prompts.mjs';
import { digest } from '../runner-state.mjs';
import { analyzePromptExperiment } from '../scripts/analyze-prompt-experiment.mjs';
import defaults from '../runner-config.json' with { type: 'json' };

test('only fixed prompt variants can be selected; legacy original selects balanced', () => {
  assert.equal(selectPrompt({}).variant, defaults.promptVariant);
  for (const variant of ['balanced', 'proof_first', 'proofOnly']) {
    const assignment = selectPrompt({ pipeline: { promptVariant: variant } });
    assert.deepEqual(assignment, { experiment_id: null, variant,
      assignment_unit: 'mathematical_attempt', probability: 1 });
    assert.deepEqual(selectPrompt({ promptVariant: variant }), assignment);
  }
  assert.equal(selectPrompt({ promptVariant: 'original' }).variant, 'balanced');
  assert.throws(() => selectPrompt({ promptVariant: 'ab_test' }), /promptVariant/);
  assert.throws(() => selectPrompt({ promptVariant: 'typo' }), /promptVariant/);
});

test('balanced preserves the original prompt and shared naming contracts stay consistent', () => {
  const target = { theorem_name: 'Goal', formal_statement: 'theorem Goal : True := by sorry' };
  const render = options => agentPrompt(target, 'run', 1, '', 'solution.lean', options);
  const original = render({ promptExperiment: selectPrompt({ promptVariant: 'balanced' }) });
  assert.equal(original, render({ promptExperiment: { variant: 'original' } }), 'saved original assignments still resume');
  // Both variants include the deterministic artifact naming policy.
  assert.equal(digest(original), '25801cf343581e3a3671c2b9e5d1a034d4e1ee3aec7a7b162ef6663bb7649a6b');
  assert.match(original, /__p2m_Goal_a1/);
  assert.equal(original, render({}));
  const proofFirst = render({ promptExperiment: selectPrompt({ promptVariant: 'proof_first' }) });
  assert.match(proofFirst, /^Your primary objective is a complete Lean proof/);
  assert.match(proofFirst, /New child theorems are a last resort/);
  assert.match(proofFirst, /write and prove auxiliary lemmas inside the solution file/);
  assert.match(proofFirst, /return ready=false/);
  assert.match(proofFirst, /certify the exact full negation/);
  assert.ok(proofFirst.endsWith(original.slice(original.indexOf('\n\n') + 2)), 'all shared contracts are preserved');
  assert.throws(() => render({ promptExperiment: { variant: 'typo' } }), /Unknown/);
});

test('hourly analysis attributes uploads and failures, deduplicates IDs, and separates pending and legacy attempts', async t => {
  const runs = await mkdtemp(join(tmpdir(), 'prove2me-prompts-'));
  t.after(() => rm(runs, { recursive: true, force: true }));
  const at = minute => new Date(Date.UTC(2026, 9, 26, 10, minute)).toISOString();
  const start = (n, variant, minute = n) => ({ event_type: 'attempt', result: 'started', attempt: n,
    attempt_id: `a${n}`, observed_at: at(minute), prompt_experiment: variant ? { experiment_id: PROMPT_EXPERIMENT, variant } : undefined,
    model: 'gpt-6-luna', operation: 'implement' });
  const end = (n, result, kind, failure) => ({ event_type: 'attempt', attempt_id: `a${n}`, attempt: n,
    result, candidate_kind: kind, observed_at: at(n + 10), failure });
  const history = [start(1, 'original'), end(1, 'sketch_accepted', 'sketch'),
    start(2, 'proof_first'), end(2, 'proof_accepted', 'proof'),
    start(3, 'proof_first'), end(3, 'incomplete', 'proof', { origin: 'model', category: 'incomplete_argument' }),
    start(4, 'original'), end(4, 'rejected', 'proof', { origin: 'server_verification', category: 'compile_error' }),
    start(5, 'proof_first'), start(6), end(6, 'proof_accepted', 'proof'),
    start(7, 'original'), end(7, 'rejected', 'proof'), { event_type: 'attempt_exclusion', attempt: 7 },
    start(8, 'proof_first', -10), end(8, 'proof_accepted', 'proof'),
    { ...start(9), prompt_experiment: selectPrompt({ promptVariant: 'original' }) }, end(9, 'proof_accepted', 'proof'),
    { ...start(10), prompt_experiment: selectPrompt({ promptVariant: 'proofOnly' }) }, end(10, 'proof_accepted', 'proof'),
    { ...start(11), prompt_experiment: { experiment_id: 'proof-first-v1', variant: 'original' } }, end(11, 'proof_accepted', 'proof'),
    { ...start(12), prompt_experiment: { experiment_id: null, variant: 'original' } }, end(12, 'proof_accepted', 'proof')];
  const upload = (n, extra = {}) => ({ attempt: n, submission_id: `s${n}`, started_at: at(n + 1),
    candidate_kind: n === 1 ? 'sketch' : 'proof', status: n === 1 ? 'SKETCH_ACCEPTED' : n === 4 ? 'CE' : 'ACCEPTED', ...extra });
  await mkdir(join(runs, 'leaf'));
  await writeFile(join(runs, 'leaf/state.json'), JSON.stringify({ theorem_id: 'leaf', history,
    remote_operations: [upload(1), upload(2, { attempt_id: 'a2' }), upload(2), upload(4), upload(6), upload(8), upload(9)] }));
  const report = await analyzePromptExperiment({ runs, since: at(0), until: at(60) });
  const groups = report.attempts_started_in_window;
  assert.equal(groups.original.attempts, 2); assert.equal(groups.original.sketches, 1);
  assert.equal(groups.original.rejected, 1); assert.equal(groups.original.submissions, 2);
  assert.equal(groups.proof_first.attempts, 3); assert.equal(groups.proof_first.proofs, 1);
  assert.equal(groups.proof_first.incomplete, 1); assert.equal(groups.proof_first.failures, 1);
  assert.equal(groups.proof_first.pending, 1); assert.equal(groups.proof_first.submissions, 1);
  assert.equal(groups.proof_first.upload_operations, 2);
  assert.equal(groups.proof_first.failures_by_category.incomplete_argument, 1);
  assert.equal(groups.legacy_unassigned.proofs, 1);
  assert.equal(groups.configured_balanced.proofs, 1);
  assert.equal(groups.configured_original.proofs, 1);
  assert.equal(groups.configured_proofOnly.proofs, 1);
  assert.equal(groups['historical_proof-first-v1_original'].proofs, 1, 'older prompt contracts stay outside the current experiment');
  assert.equal(report.submissions_in_window.configured_balanced.submissions, 1);
  assert.equal(report.excluded_quota_attempts, 1);
  assert.equal(report.submissions_in_window.proof_first.submissions, 2, 'includes older attempt uploaded in window');
  assert.equal(report.outcomes_recorded_in_window.proof_first.proofs, 2);
  assert.equal(report.attempts.find(r => r.attempt === 2).submissions.length, 1);
  const output = join(runs, 'report.json');
  execFileSync(process.execPath, [fileURLToPath(new URL('../scripts/analyze-prompt-experiment.mjs', import.meta.url)),
    '--runs', runs, '--since', at(0), '--until', at(60), '--output', output]);
  const saved = JSON.parse(await readFile(output, 'utf8'));
  assert.deepEqual(saved.attempts_started_in_window, report.attempts_started_in_window);
  await assert.rejects(analyzePromptExperiment({ runs, since: at(60), until: at(0) }), /since < until/);
});

test('proofOnly permits complete proofs and exact disproof certificates without sketch instructions', () => {
  const target = { theorem_name: 'Goal', formal_statement: 'theorem Goal : True := by sorry' };
  for (const verificationMode of ['local', 'server-only']) {
    const prompt = agentPrompt(target, 'run', 2, 'previous invocation stopped at a Codex quota limit', 'solution.lean', {
      verificationMode, promptExperiment: selectPrompt({ promptVariant: 'proofOnly' }),
      workerContextPath: 'worker-context.json', escalation: { after: 2 }, operation: 'reconsider_reduction',
    });
    assert.match(prompt, /^Your only objective is a complete Lean proof/);
    assert.match(prompt, /local have statements inside theorem solution/);
    assert.match(prompt, /Set ready=true only if you believe you have completed a sound proof/);
    assert.match(prompt, /return kind=proof, ready=false, children=\[\], definitions=\[\]/);
    assert.match(prompt, /Complete proofs and certified disproofs are equally valid outcomes/);
    assert.match(prompt, /return kind=counterexample, ready=false, children=\[\], definitions=\[\]/);
    assert.match(prompt, /ALL target binders universally quantified INSIDE the negation/);
    assert.match(prompt, /solution : ¬ \(∀ \(n : Nat\), n > 0 → n = 1\)/);
    assert.match(prompt, /must not import Theorems\.\*/);
    assert.match(prompt, /proof_type=disprove/);
    assert.ok(!prompt.includes('Do not return or submit a counterexample'));
    assert.ok(!prompt.includes('Return kind=proof, children=[], and definitions=[] in every answer'));
    assert.match(prompt, /No sorry, admit, new axioms/);
    assert.match(prompt, /Do not launch Lake or Lean/);
    assert.match(prompt, /worker-context.json/);
    assert.match(prompt, /Codex quota limit/);
    assert.ok(!prompt.includes('Return kind=proof or sketch'));
    assert.match(prompt, /Give proof and disproof equal consideration/);
    assert.ok(!prompt.includes('For a sketch,'));
    assert.equal(prompt.includes('Verification mode is server-only'), verificationMode === 'server-only');
  }
  const prompt = agentPrompt(target, 'run', 1, '', 'solution.lean', {
    promptExperiment: selectPrompt({ promptVariant: 'proofOnly' }),
  });
  assert.ok(prompt.includes(target.formal_statement));
});

test('all proof modes share the mathematical workflow while the runner retains operational work', () => {
  for (const variant of ['balanced', 'proof_first', 'proofOnly']) {
    const prompt = agentPrompt({ theorem_name: 'Goal' }, 'run', 1, '', 'solution.lean', {
      promptExperiment: selectPrompt({ promptVariant: variant }), workerContextPath: 'worker.json',
    });
    assert.match(prompt, /Read the custom definitions/);
    assert.match(prompt, /Follow the exact source argument/);
    assert.match(prompt, /missing Mathlib lemma is work to complete/);
    assert.match(prompt, /Platform API\/catalog retrieval belongs to the runner/);
    assert.match(prompt, /Remaining obligation:, Completed work:, Failed routes:, Next step:/);
    assert.match(prompt, /do not add JSON fields/);
    assert.equal(prompt.match(/Do not launch Lake or Lean/g)?.length, 1);
    assert.ok(!prompt.includes('Search the platform'));
  }
});
