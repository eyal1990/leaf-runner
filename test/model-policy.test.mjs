import test from 'node:test';
import assert from 'node:assert/strict';
import { attemptModel, modelProfile, incompleteEscalation, incompleteEvidence, proofProgressHash } from '../model-policy.mjs';
import { selectable, scoreWork, escalationBlocker } from '../work-policy.mjs';
import { pipelineLimits } from '../pipeline.mjs';
import defaults from '../runner-config.json' with { type: 'json' };

test('the default schedule follows the project config for every lifetime attempt', () => {
  for (const options of [{}, { pipeline: pipelineLimits() }]) {
    const schedule = defaults.attemptModels.length ? defaults.attemptModels : ['luna-6-high'];
    for (const n of [1, 2, 3, 26]) assert.deepEqual(attemptModel(n, options), modelProfile(schedule[Math.min(n - 1, schedule.length - 1)]));
  }
});

test('an explicitly empty schedule uses the legacy Luna High fallback', () => {
  for (const options of [{ attemptModels: [] }, { pipeline: { attemptModels: [] } }]) {
    for (const n of [1, 2, 3, 26]) assert.deepEqual(attemptModel(n, options), {
      model: 'gpt-6-luna', reasoningEffort: 'high', modelProfile: 'luna-6-high',
    });
  }
});

test('configured positions include reasoning and repeat the final profile after restart', () => {
  const options = { pipeline: { attemptModels: ['luna-6-high', 'luna-6-high', 'sol-6.1-medium'] } };
  assert.equal(attemptModel(1, options).model, 'gpt-6-luna');
  assert.equal(attemptModel(2, options).reasoningEffort, 'high');
  for (const n of [3, 4, 26]) assert.deepEqual(attemptModel(n, JSON.parse(JSON.stringify(options))), {
    model: 'gpt-6.1-sol', reasoningEffort: 'medium', modelProfile: 'sol-6.1-medium',
  });
  assert.equal(attemptModel(4, { attemptModels: ['luna-6-medium'] }).reasoningEffort, 'medium');
  assert.equal(modelProfile('gpt-6.1-sol-low').model, 'gpt-6.1-sol');
  assert.equal(attemptModel(2, { ...options, model: 'sol-6.1-low' }).reasoningEffort, 'low');
  assert.equal(attemptModel(2, { model: 'custom-model' }).model, 'custom-model');
});

test('bad schedules fail during configuration validation and arrays are independent', () => {
  for (const value of [null, false, 'luna-6-high', {}, [null], [undefined], [12], [''], [' luna-6-high'], ['luna-6-impossible'], ['terra-6.1-impossible']]) {
    assert.throws(() => pipelineLimits({ attemptModels: value }));
  }
  const settings = { attemptModels: ['luna-6-high'] }, parsed = pipelineLimits(settings);
  parsed.attemptModels.push('sol-6.1-medium');
  assert.deepEqual(settings.attemptModels, ['luna-6-high']);
  assert.deepEqual(pipelineLimits().attemptModels, defaults.attemptModels);
});

const outcome = (attempt, result = 'incomplete', context = 'initial', model = 'gpt-6-luna') => ({ event_type: 'attempt',
  attempt, attempt_id: `attempt-${attempt}`, context_id: context, result,
  failure: { category: result === 'incomplete' ? 'incomplete_argument' : 'compile_error',
    stagnation: incompleteEvidence({ explanation: 'The unresolved coefficient identity requires finite expansion of ideal powers and homogeneous component products.' }, null, model, null) } });
const stalled = (model = 'gpt-6-luna') => ({ context_id: 'initial', history: [outcome(1, 'incomplete', 'initial', model), outcome(2, 'incomplete', 'initial', model)] });

test('configured Terra stalls escalate to Sol High, survive restart and quota, and reset on progress', () => {
  const state = stalled('gpt-6.1-terra');
  const options = { attemptModels: ['terra-6.1-medium'], incompleteEscalation: { maxAttempts: null } };
  assert.equal(attemptModel(2, options, { ...state, history: state.history.slice(0, 1) }).model, 'gpt-6.1-terra');
  const decision = attemptModel(3, options, JSON.parse(JSON.stringify(state)));
  assert.equal(decision.model, 'gpt-6.1-sol');
  assert.equal(decision.reasoningEffort, 'high');
  assert.equal(decision.escalation.automatic, true);
  assert.equal(decision.escalation.trigger_attempt, 2);
  const capped = { ...options, incompleteEscalation: { maxAttempts: 1 } };
  state.history.push({ ...outcome(3, 'started'), model: decision.model, escalation: decision.escalation });
  const paused = { ...JSON.parse(JSON.stringify(state)), attempt_id: 'attempt-3', codex_quota_wait: true };
  assert.equal(attemptModel(3, capped, paused).model, 'gpt-6.1-sol');
  assert.equal(incompleteEscalation(paused).attempts, 1);
  state.history.push(outcome(3, 'rejected'));
  assert.equal(attemptModel(4, options, state).model, 'gpt-6.1-sol');
  assert.equal(attemptModel(4, capped, state).model, 'gpt-6.1-terra');
  state.history.push({ ...outcome(4), failure: { category: 'incomplete_argument', stagnation:
    incompleteEvidence({ explanation: rewordedBlockers[0] }, null, decision.model, 'lemma advance : True := by trivial') } });
  assert.equal(attemptModel(5, options, state).model, 'gpt-6.1-terra');
});

test('historical Terra calls that did not escalate do not consume a Sol rescue', () => {
  const state = stalled('gpt-6.1-terra');
  state.history.push({ ...outcome(3, 'started'), model: 'gpt-6.1-terra',
    escalation: { ...incompleteEscalation(state), automatic: false } }, outcome(3, 'incomplete', 'initial', 'gpt-6.1-terra'));
  const decision = attemptModel(4, { incompleteEscalation: { maxAttempts: 1 } }, state);
  assert.equal(decision.model, 'gpt-6.1-sol');
  assert.equal(decision.escalation.attempts, 0);
});

test('two identical Luna incompletes keep Sol active through failures until accepted progress', () => {
  const state = stalled();
  const options = { attemptModels: [], incompleteEscalation: { maxAttempts: null } };
  assert.equal(attemptModel(2, options, { ...state, history: state.history.slice(0, 1) }).model, 'gpt-6-luna');
  const decision = attemptModel(3, options, state);
  assert.equal(decision.model, 'gpt-6.1-sol'); assert.equal(decision.reasoningEffort, 'high');
  assert.equal(decision.escalation.trigger_attempt, 2); assert.equal(decision.escalation.pending, true);
  state.history.push({ ...outcome(3, 'started'), model: decision.model, escalation: decision.escalation }, outcome(3, 'rejected'));
  const next = attemptModel(4, options, JSON.parse(JSON.stringify(state)));
  assert.equal(next.model, 'gpt-6.1-sol');
  assert.equal(next.escalation.attempts, 1);
  state.history.push(outcome(4), outcome(5));
  assert.equal(attemptModel(6, options, state).model, 'gpt-6.1-sol', 'failures without positive progress retain Sol');
  assert.equal(attemptModel(4, options, { ...state, context_id: 'changed' }).model, 'gpt-6-luna');
  state.history.push(outcome(6, 'sketch_accepted'));
  assert.equal(attemptModel(7, options, state).model, 'gpt-6-luna');
});

test('incompleteness alone, changed mathematical output, or incomplete evidence cannot establish stagnation', () => {
  const base = { explanation: 'The same missing lemma remains unproved.' };
  const evidence = (candidate, hash = null, model = 'gpt-6-luna') => incompleteEvidence(candidate, hash, model);
  for (const changed of [evidence({ explanation: 'Reduced the problem to a smaller missing lemma.' }),
    evidence(base, 'a'.repeat(64)), evidence({ ...base, children: [{ theorem_name: 'new_child' }] }),
    evidence({ ...base, definitions: [{ name: 'new_definition' }] }), evidence(base, null, 'gpt-6.1-sol'), undefined]) {
    const state = stalled();
    state.history[1].failure.stagnation = changed;
    assert.equal(incompleteEscalation(state), null);
    assert.equal(attemptModel(3, { attemptModels: [] }, state).model, 'gpt-6-luna');
  }
  assert.equal(incompleteEvidence({ explanation: '  ' }, null, 'gpt-6-luna'), undefined);
  assert.deepEqual(evidence({ explanation: 'The same\n missing lemma remains unproved.' }), evidence(base));
  const legacy = stalled(); legacy.history.forEach(event => delete event.failure.stagnation);
  assert.equal(incompleteEscalation(legacy), null, 'old incomplete labels cannot establish no progress');
});

test('new progress revokes a pending rescue; repeating the new unchanged output can establish a fresh stall', () => {
  const state = stalled();
  assert.equal(incompleteEscalation(state).pending, true);
  const progress = outcome(3);
  progress.failure.stagnation = incompleteEvidence({ explanation: 'The unresolved determinant bound requires a finite coefficient expansion for separated polynomial interpolation.' }, 'b'.repeat(64), 'gpt-6-luna', 'lemma smaller : True := by trivial');
  state.history.push(progress);
  assert.equal(incompleteEscalation(state), null);
  state.history.push({ ...structuredClone(progress), attempt: 4, attempt_id: 'attempt-4' });
  assert.equal(incompleteEscalation(state).trigger_attempt, 4);
});

const rewordedBlockers = [
  'The unresolved coefficient identity requires finite expansion of ideal powers and homogeneous component products.',
  'Finite expansion for homogeneous component products and ideal powers is missing; the coefficient identity is unproved.',
  'The remaining obstacle is the coefficient identity for ideal powers, homogeneous component products, and their finite expansion.',
];
const rewordedState = (sources = rewordedBlockers.map(() => 'import Mathlib\n-- research notes\n')) => ({ context_id: 'initial',
  history: rewordedBlockers.map((explanation, i) => ({ ...outcome(i + 1), failure: { category: 'incomplete_argument',
    stagnation: incompleteEvidence({ kind: 'proof', explanation, children: [], definitions: [] }, String(i), 'gpt-6-luna', sources[i]) } })) });

test('three concrete reworded blockers with unchanged code keep Sol active across restart', () => {
  const state = rewordedState(['import Mathlib\n-- first notes', '/- newer /- nested -/ notes -/\nimport Mathlib', 'import Mathlib\n-- third notes']);
  const options = { attemptModels: [], incompleteEscalation: { maxAttempts: null } };
  assert.equal(incompleteEscalation({ ...state, history: state.history.slice(0, 2) }), null);
  const decision = attemptModel(4, options, JSON.parse(JSON.stringify(state)));
  assert.equal(decision.model, 'gpt-6.1-sol');
  assert.equal(decision.escalation.evidence_kind, 'unchanged_code_repeated_blocker');
  assert.equal(decision.escalation.evidence_attempts, 3);
  state.history.push({ ...outcome(4, 'started'), model: decision.model, escalation: decision.escalation }, outcome(4, 'rejected'));
  state.history.push(...rewordedState().history.map((e, i) => ({ ...e, attempt: i + 5, attempt_id: `attempt-${i + 5}` })));
  assert.equal(attemptModel(8, options, JSON.parse(JSON.stringify(state))).model, 'gpt-6.1-sol');
});

test('three reworded Terra blockers escalate without treating research notes as proof progress', () => {
  const state = rewordedState();
  state.history.forEach(event => { event.failure.stagnation.model = 'gpt-6.1-terra'; });
  assert.equal(incompleteEscalation({ ...state, history: state.history.slice(0, 2) }), null);
  const decision = attemptModel(4, {}, JSON.parse(JSON.stringify(state)));
  assert.equal(decision.model, 'gpt-6.1-sol');
  assert.equal(decision.escalation.automatic, true);
  assert.equal(decision.escalation.evidence_kind, 'unchanged_code_repeated_blocker');
  assert.equal(decision.escalation.evidence_attempts, 3);
});

test('Sol incompletes, rewording, missing evidence, interruptions and rejected artifacts retain escalation', () => {
  const options = { attemptModels: [], incompleteEscalation: { maxAttempts: null } };
  const state = stalled(), decision = attemptModel(3, options, state);
  state.history.push({ ...outcome(3, 'started'), model: decision.model, escalation: decision.escalation });
  const unchanged = incompleteEvidence({ explanation: rewordedBlockers[1] }, null, decision.model, null);
  for (const event of [
    { ...outcome(3), failure: { category: 'incomplete_argument', stagnation: unchanged } },
    { ...outcome(4), failure: { category: 'incomplete_argument' } },
    outcome(5, 'interrupted'), outcome(6, 'rejected'),
  ]) {
    state.history.push(event);
    assert.equal(attemptModel(event.attempt + 1, options, JSON.parse(JSON.stringify(state))).model, decision.model);
  }
});

test('Sol proof or declaration progress returns to Luna and a later stall can escalate again', () => {
  const explanation = rewordedBlockers[0];
  for (const change of [{ source: 'lemma advance : True := by trivial' },
    { children: [{ theorem_name: 'smaller_goal' }] }, { definitions: [{ name: 'useful_definition' }] }]) {
    const state = stalled(), decision = attemptModel(3, { attemptModels: [] }, state);
    state.history.push({ ...outcome(3, 'started'), model: decision.model, escalation: decision.escalation });
    const candidate = { explanation, children: change.children, definitions: change.definitions };
    const progress = { ...outcome(3), failure: { category: 'incomplete_argument',
      stagnation: incompleteEvidence(candidate, null, decision.model, change.source ?? null) } };
    state.history.push(progress);
    assert.equal(attemptModel(4, { attemptModels: [] }, JSON.parse(JSON.stringify(state))).model, 'gpt-6-luna');
    const lunaEvidence = incompleteEvidence(candidate, null, 'gpt-6-luna', change.source ?? null);
    for (const attempt of [4, 5]) state.history.push({ ...outcome(attempt),
      failure: { category: 'incomplete_argument', stagnation: lunaEvidence } });
    const restarted = attemptModel(6, { attemptModels: [] }, JSON.parse(JSON.stringify(state)));
    assert.equal(restarted.model, decision.model);
    assert.equal(restarted.escalation.attempts, 0, 'progress starts a fresh stall episode');
  }
});

test('every accepted outcome ends Sol escalation without requiring stagnation evidence', () => {
  for (const result of ['sketch_accepted', 'proof_accepted', 'disproof_accepted']) {
    const state = stalled();
    state.history.push({ ...outcome(3, result), failure: undefined });
    assert.equal(incompleteEscalation(state), null);
    assert.equal(attemptModel(4, { attemptModels: [] }, state).model, 'gpt-6-luna');
  }
});

test('code changes, unrelated blockers, generic refusals and legacy hashes cannot fund a rescue', () => {
  const changed = rewordedState(['import Mathlib', 'import Mathlib\nlemma advance : True := by trivial', 'import Mathlib\nlemma advance : True := by trivial']);
  assert.equal(incompleteEscalation(changed), null);
  for (const explanation of ['I cannot finish this proof.', 'The unresolved integral convergence requires measurable domination, uniform tail estimates and compact support.']) {
    const state = rewordedState();
    state.history[1].failure.stagnation = incompleteEvidence({ explanation }, null, 'gpt-6-luna', 'import Mathlib');
    assert.equal(incompleteEscalation(state), null);
  }
  const generic = { context_id: 'initial', history: [1, 2, 3].map(n => ({ ...outcome(n), failure: { category: 'incomplete_argument',
    stagnation: incompleteEvidence({ explanation: 'I cannot finish the proof.' }, null, 'gpt-6-luna', null) } })) };
  assert.equal(incompleteEscalation(generic), null);
  const legacy = rewordedState();
  legacy.history.forEach(e => { e.failure.stagnation.schema_version = 1; delete e.failure.stagnation.blocker_terms; });
  assert.equal(incompleteEscalation(legacy), null);
});

test('proof progress normalization ignores comments and formatting but retains literals and tokens', () => {
  assert.equal(proofProgressHash('lemma x : True := by\n trivial -- notes'), proofProgressHash('/- nested /- note -/ -/ lemma x : True := by trivial'));
  for (const [a, b] of [['def x := "a b"', 'def x := "ab"'], ['def x := "--"', 'def x := " "'],
    ['def x := r#"/- text -/"#', 'def x := r#"changed"#'], ['def x := a++b', 'def x := a + + b'],
    ['lemma x : True := by trivial', 'lemma x : True := by simp'], ['', null]]) {
    assert.notEqual(proofProgressHash(a), proofProgressHash(b));
  }
});

test('escalation excludes quota corrections, legacy counters, other contexts, and duplicate outcomes', () => {
  assert.equal(incompleteEscalation({ attempt_count: 100, recovery_failure: { count: 100 } }), null);
  assert.equal(incompleteEscalation({ context_id: 'new', history: stalled().history }), null);
  assert.equal(incompleteEscalation({ ...stalled(), history: [outcome(1), outcome(1)] }), null);
  assert.equal(incompleteEscalation({ ...stalled(), history: [...stalled().history,
    { event_type: 'attempt_exclusion', attempt: 1 }] }), null);
  assert.equal(incompleteEscalation({ ...stalled(), history: [outcome(1), outcome(2, 'rejected'), outcome(3)] }), null);
  assert.equal(incompleteEscalation({ ...stalled(), history: [outcome(1), outcome(2, 'interrupted'), outcome(3)] })?.trigger_attempt, 3);
  assert.equal(incompleteEscalation(stalled(), { pipeline: { incompleteEscalation: { after: 0 } } }), null);
});

test('operator override and stronger configured models are respected; policy is configurable', () => {
  const state = stalled();
  assert.equal(attemptModel(3, { model: 'custom-model' }, state).model, 'custom-model');
  assert.equal(attemptModel(3, { attemptModels: ['astra-6-high'] }, state).model, 'gpt-6-astra');
  const terra = attemptModel(3, { attemptModels: ['terra-6.1-medium'] }, state);
  assert.equal(terra.model, 'gpt-6.1-sol'); assert.equal(terra.reasoningEffort, 'high');
  assert.equal(terra.escalation.automatic, true, 'saved stalls escalate the configured Terra profile');
  assert.equal(attemptModel(3, { model: 'terra-6.1-medium' }, stalled('gpt-6.1-terra')).escalation.automatic, false);
  assert.equal(attemptModel(3, { attemptModels: ['sol-6.1-xhigh'] }, state).reasoningEffort, 'xhigh');
  assert.equal(attemptModel(3, { attemptModels: ['sol-6.1-medium'] }, state).reasoningEffort, 'high');
  assert.equal(attemptModel(2, { pipeline: { attemptModels: [], incompleteEscalation: { after: 1, model: 'astra-6-high' } } }, state).model, 'gpt-6-astra');
  for (const value of [null, [], false, { after: -1 }, { after: 1.5 }, { after: '2' }, { maxAttempts: -1 }, { maxAttempts: 1.5 }, { maxAttempts: '1' }, { model: '' }, { model: 'sol-6.1-wrong' }, { extra: 1 }]) {
    assert.throws(() => pipelineLimits({ incompleteEscalation: value }));
  }
  const configured = pipelineLimits({ incompleteEscalation: { after: 3 } });
  assert.deepEqual(configured.incompleteEscalation, { ...defaults.incompleteEscalation, after: 3 });
});

test('saved mathematical cooldowns do not delay a rescue or subsequent Luna work', () => {
  const state = { ...stalled(), job_status: 'READY', retry_after: new Date(900000).toISOString(),
    recovery_failure: { message: 'incomplete_argument' } };
  assert.equal(selectable(state, {}, 0), true);
  assert.equal(selectable(state, {}, 900001), true);
  assert.equal(selectable(state, {}, 0, { pipeline: { incompleteEscalation: { after: 0 } } }), true);
  assert.equal(selectable({ ...state, job_status: 'ACTIVE' }, {}, 0), false);
  assert.equal(selectable({ ...state, status: 'PENDING' }, {}, 0), false);
  assert.equal(selectable({ ...state, recovery_failure: { message: 'network failure' } }, {}, 0), false);
  state.history.push({ ...outcome(3, 'started'), escalation: incompleteEscalation(state) }, outcome(3));
  assert.equal(selectable(state, {}, 0), true);
});

test('uncapped escalation survives restart and quota continuation with an optional operator cap', () => {
  const options = { attemptModels: [], incompleteEscalation: { maxAttempts: null } };
  const state = stalled(), decision = attemptModel(3, options, state);
  state.history.push({ ...outcome(3, 'started'), model: decision.model, escalation: decision.escalation });
  const resumed = { ...JSON.parse(JSON.stringify(state)), attempt_id: 'attempt-3', codex_quota_wait: true };
  assert.equal(attemptModel(3, options, resumed).model, 'gpt-6.1-sol');
  assert.equal(attemptModel(4, options, state).model, 'gpt-6.1-sol');
  assert.equal(attemptModel(4, { attemptModels: [], incompleteEscalation: { maxAttempts: 1 } }, state).model, 'gpt-6-luna');
  assert.equal(attemptModel(3, { attemptModels: [], incompleteEscalation: { maxAttempts: 1 } }, resumed).model, 'gpt-6.1-sol');
  assert.equal(attemptModel(4, { attemptModels: [], incompleteEscalation: { maxAttempts: 2 } }, state).model, 'gpt-6.1-sol');
  state.history.push({ ...outcome(4, 'started'), model: 'gpt-6.1-sol', escalation: decision.escalation });
  assert.equal(attemptModel(4, options, { ...resumed, history: state.history, attempt_id: 'attempt-4' }).model, 'gpt-6.1-sol');
  assert.equal(attemptModel(5, { attemptModels: [], incompleteEscalation: { maxAttempts: 0 } }, state).model, 'gpt-6-luna');
  state.history.push({ event_type: 'attempt_exclusion', attempt: 3 }, { event_type: 'attempt_exclusion', attempt: 4 });
  assert.equal(attemptModel(5, options, state).model, 'gpt-6.1-sol');
});

test('unstuck work ranks first; unrelated in-flight and cooling Luna jobs do not starve a confirmed rescue', () => {
  const root = { theorem_id: 'root', status: 'Open' };
  const hard = { theorem_id: 'hard', status: 'Open', closability: 100 };
  const easy = { theorem_id: 'easy', status: 'Open', closability: 0 };
  const graph = { root, leaves: [hard, easy] };
  const states = new Map([['hard', stalled()]]);
  assert.deepEqual(scoreWork(graph, states, Date.now(), { attemptModels: [] }).map(w => w.theorem_id), ['easy', 'hard']);
  for (const state of [{ job_status: 'ACTIVE' }, { retry_after: new Date(Date.now() + 60000).toISOString() }]) {
    states.set('easy', state);
    assert.deepEqual(scoreWork(graph, states, Date.now(), { attemptModels: [] }).map(w => w.theorem_id), ['hard']);
    assert.equal(escalationBlocker(graph, states, 'hard'), null);
  }
  graph.leaves = [hard];
  assert.equal(scoreWork(graph, states, Date.now(), { attemptModels: [] })[0].automatic_escalation, true);
  assert.equal(scoreWork(graph, states, Date.now(), { model: 'custom-model' })[0].automatic_escalation, false);
});

test('one automatic rescue reserves the frontier; restored reservations have a stable winner', () => {
  const root = { theorem_id: 'root', status: 'Open' };
  const graph = { root, leaves: ['a', 'b'].map(theorem_id => ({ theorem_id, status: 'Open' })) };
  const states = new Map(['a', 'b'].map(id => [id, { ...stalled(), theorem_id: id }]));
  states.set('a', { ...states.get('a'), job_status: 'ACTIVE', claimed_at: '2026-10-24T00:00:00Z',
    selection: { automatic_escalation: true } });
  assert.equal(scoreWork(graph, states, Date.now(), { attemptModels: [] }).length, 0);
  states.set('b', { ...states.get('b'), job_status: 'ACTIVE', claimed_at: '2026-10-24T00:00:01Z',
    selection: { automatic_escalation: true } });
  assert.equal(escalationBlocker(graph, states, 'a'), null);
  assert.match(escalationBlocker(graph, states, 'b'), /rescue/);
});
