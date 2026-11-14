import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workerContext } from '../worker-context.mjs';
import { agentPrompt } from '../agent-prompts.mjs';

test('worker packet keeps the score, exact evidence and recent failed routes without duplicating full history', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'prove2me-worker-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const candidatePath = join(dir, 'candidate-25.json');
  await writeFile(candidatePath, JSON.stringify({ candidate: { explanation: 'Induction fails at the zero boundary.' } }));
  const history = Array.from({ length: 25 }, (_, i) => [
    { event_type: 'attempt', attempt_id: String(i), attempt: i + 1, result: 'started', model: 'gpt-6-luna' },
    { event_type: 'attempt', attempt_id: String(i), attempt: i + 1, result: 'incomplete',
      failure: { category: 'incomplete_argument', diagnostic_path: `failure-${i + 1}.json` },
      artifacts: { candidate: { path: candidatePath }, solution_path: `solution-${i + 1}.lean` } },
  ]).flat();
  const manifest = { target: { theorem_name: 'Test', formal_statement: 'theorem Test (n : Nat) : n = n := by sorry' },
    environment: { toolchain: 'pinned' }, history, total_attempts: 25, current_context_attempts: 25,
    selection: { score: -275, closability: 0, cycle_members: [{ theorem_id: 'cycle' }], projected_state: { history } },
    dependency_evidence: [{ theorem_id: 'child', status: 'Disproved', certificate: { snapshot: 'exact.lean' } }],
    publication_journals: [{ lots_of_runner_data: 'x'.repeat(10000) }], accepted_reductions: [{ path: 'reduction.json' }] };
  const original = structuredClone(manifest);
  const packet = await workerContext(manifest, { dir, attempt: 26, feedback: 'Exact current diagnostic', auditPath: 'audit.json' });
  assert.equal(packet.selection.score, -275);
  assert.deepEqual(packet.target, manifest.target);
  assert.deepEqual(packet.dependency_evidence, manifest.dependency_evidence);
  assert.deepEqual(packet.selection.cycle_members, manifest.selection.cycle_members);
  assert.equal(packet.latest_diagnostic, 'Exact current diagnostic');
  assert.equal(packet.recent_attempts.length, 3);
  assert.equal(packet.recent_attempts[2].attempt, 25);
  assert.match(packet.recent_attempts[2].explanation, /zero boundary/);
  assert.equal(packet.earlier_attempts_omitted, 22);
  assert.equal(packet.audit_context_path, 'audit.json');
  assert.ok(JSON.stringify(packet).length < JSON.stringify(manifest).length / 3);
  assert.deepEqual(manifest, original);
});

test('research preview is bounded and worker prompts start with one packet and targeted reads', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'prove2me-research-preview-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const notes = join(dir, 'notes.md');
  await writeFile(notes, 'a'.repeat(16000));
  const packet = await workerContext({ mission_research: { notes_path: notes }, history: [] }, { dir, attempt: 1 });
  assert.ok(packet.mission_research.notes_excerpt.length < 2500);
  assert.equal(packet.mission_research.notes_path, notes);
  const prompt = agentPrompt({ formal_statement: 'EXACT_STATEMENT_ONLY_IN_PACKET' }, dir, 2, 'Diagnostic', 'solution.lean',
    { workerContextPath: 'packet.json', attemptContextPath: 'full-audit.json', operation: 'repair_candidate' });
  assert.match(prompt, /compact worker context: packet.json/);
  assert.doesNotMatch(prompt, /EXACT_STATEMENT_ONLY_IN_PACKET|full-audit.json|codex-1.log|lean-1.log|type-1.log/);
  assert.match(prompt, /targeted lookup only/);
  assert.match(prompt, /autoImplicit=false/);
});

test('escalation packet and prompt demand independent reassessment and exact disproof certificates', async () => {
  const escalation = { reason: 'repeated_incomplete', after: 2, trigger_attempt: 5 };
  const packet = await workerContext({ escalation }, { dir: 'run', attempt: 6 });
  assert.deepEqual(packet.escalation, escalation);
  const options = { escalation, workerContextPath: 'packet.json', operation: 'reconsider_argument' };
  const prompt = agentPrompt({}, 'run', 6, '', 'solution.lean', options);
  assert.match(prompt, /Repeated-incomplete escalation/);
  assert.match(prompt, /fallible evidence/);
  assert.match(prompt, /Give proof and disproof equal consideration/);
  assert.match(prompt, /EVERY hypothesis/);
  assert.match(prompt, /kind=counterexample, ready=false/);
  assert.match(prompt, /existing identity and exact declaration/);
  assert.doesNotMatch(agentPrompt({}, 'run', 1, '', 'solution.lean', {}), /Repeated-incomplete escalation/);
});

test('scouting digest selects bounded existing evidence and preserves provenance without changing the manifest', async () => {
  const manifest = {
    milestone_history: Array.from({ length: 12 }, (_, i) => ({ id: i, event_type: 'updated',
      created_at: new Date(Date.UTC(2026, 9, i + 1)).toISOString(), changed_fields: ['theorem_id'],
      old_values: { theorem_id: `old-${i}` }, new_values: { theorem_id: `new-${i}` },
      reason: `Reason ${i}: ${'x'.repeat(2000)}`, unrelated_payload: 'omit me' })),
    previous_submissions: Array.from({ length: 12 }, (_, i) => ({ id: `s${i}`,
      created_at: new Date(Date.UTC(2026, 9, i + 1)).toISOString(), status: i % 2 ? 'CE' : 'SKETCH_ACCEPTED',
      explanation: 'Proof argument.'.repeat(200), error_message: 'Exact diagnostic.'.repeat(200),
      file_path: 'server-internal-path', ...(i === 10 ? { deprecated_at: '2026-10-20' } : {}) })),
    accepted_reductions: [{ submission_id: 's10', path: 'saved-reduction.json' }],
    target: { audits: Array.from({ length: 5 }, (_, i) => ({ audit_id: `a${i}`, decision: 'flag', comment: `Warning ${i}` })) },
  };
  const original = structuredClone(manifest);
  const packet = await workerContext(manifest, { dir: 'run', attempt: 1, auditPath: 'full-manifest.json' });
  const evidence = packet.scouting_evidence;
  assert.equal(evidence.milestone_changes.length, 6);
  assert.equal(evidence.milestone_changes[0].previous_theorem_id, 'old-11');
  assert.equal(evidence.milestone_changes[0].replacement_theorem_id, 'new-11');
  assert.ok(evidence.milestone_changes[0].reason.length < 1100);
  assert.equal(evidence.milestone_events_omitted, 6);
  assert.deepEqual(evidence.accepted_submissions.map(row => row.id), ['s10', 's8', 's6']);
  assert.deepEqual(evidence.rejected_submissions.map(row => row.id), ['s11', 's9', 's7']);
  assert.equal(evidence.accepted_submissions[0].source_artifact_path, 'saved-reduction.json');
  assert.equal(evidence.accepted_submissions[0].deprecated_at, '2026-10-20');
  assert.equal(evidence.accepted_submissions[0].file_path, undefined, 'internal storage paths are not fetchable sources');
  assert.ok(evidence.rejected_submissions[0].error_message.length < 900);
  assert.equal(evidence.submissions_omitted, 6);
  assert.deepEqual(evidence.review_flags.map(row => row.audit_id), ['a2', 'a3', 'a4']);
  assert.equal(evidence.review_flags_omitted, 2);
  assert.equal(packet.audit_context_path, 'full-manifest.json');
  assert.deepEqual(manifest, original);
});

test('labeled handoffs survive large candidate artifacts and prose outside the preview', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'prove2me-handoff-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const candidatePath = join(dir, 'candidate.json'), explanationPath = join(dir, 'candidate-explanation.md');
  const explanation = 'Long mathematical discussion. '.repeat(600) + '\n\n' +
    'Remaining obligation: Prove the induction step at n + 1.\n\n' +
    'Completed work: Base case saved; not yet compiler checked.\n\n' +
    'Failed routes: Direct simplification leaves the recurrence unchanged.\n\n' +
    'Next step: Apply the recurrence lemma before the induction hypothesis.';
  await writeFile(explanationPath, explanation);
  await writeFile(candidatePath, JSON.stringify({ source: 'x'.repeat(100000), candidate: { explanation } }));
  const packet = await workerContext({ history: [{ event_type: 'attempt', attempt: 1, result: 'incomplete',
    artifacts: { candidate: { path: candidatePath, explanation_path: explanationPath } } }] }, { dir, attempt: 2 });
  assert.ok(packet.recent_attempts[0].explanation.length < 1900);
  assert.deepEqual(packet.recent_attempts[0].handoff, {
    remaining_obligation: 'Prove the induction step at n + 1.',
    completed_work: 'Base case saved; not yet compiler checked.',
    failed_routes: 'Direct simplification leaves the recurrence unchanged.',
    next_step: 'Apply the recurrence lemma before the induction hypothesis.',
  });
});

test('legacy answers remain usable and partial handoffs do not invent missing fields', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'prove2me-legacy-handoff-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const candidatePath = join(dir, 'candidate.json'), answerPath = join(dir, 'answer.json');
  await writeFile(candidatePath, '{truncated');
  await writeFile(answerPath, JSON.stringify({ explanation: '**Remaining obligation:** ' + 'x'.repeat(2000) +
    '\n\n- **Next step:** Search the supplied source.' }));
  const packet = await workerContext({ history: [{ event_type: 'attempt', result: 'incomplete',
    artifacts: { answer_path: answerPath, candidate: { path: candidatePath, explanation_path: join(dir, 'missing.md') } } }] },
  { dir, attempt: 2 });
  assert.ok(packet.recent_attempts[0].handoff.remaining_obligation.length < 1000);
  assert.equal(packet.recent_attempts[0].handoff.next_step, 'Search the supplied source.');
  assert.equal(packet.recent_attempts[0].handoff.completed_work, undefined);
  assert.deepEqual(packet.scouting_evidence.accepted_submissions, []);
  await writeFile(answerPath, JSON.stringify({ explanation: { invalid: true } }));
  const malformed = await workerContext({ history: [{ event_type: 'attempt', result: 'rejected',
    artifacts: { answer_path: answerPath } }] }, { dir, attempt: 3 });
  assert.equal(malformed.recent_attempts[0].handoff, undefined, 'a rejected malformed answer cannot block the next proof attempt');
});
