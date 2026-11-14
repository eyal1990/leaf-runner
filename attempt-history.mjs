import { digest, json, targetFingerprint } from './runner-state.mjs';

export const terminalResults = new Set(['rejected', 'incomplete', 'interrupted', 'sketch_accepted', 'proof_accepted', 'disproof_accepted']);

// Old counters are evidence of consumption, never evidence of individual outcomes.
export function historyState(state = {}) {
  return { ...state, history: structuredClone(state.history ?? []), context_id: state.context_id ?? 'initial',
    legacy_baseline: state.legacy_baseline ?? { attempts: state.attempt_count ?? state.attempt ?? 0,
      context_id: 'initial', awareness: 'unknown', status: state.status,
      candidate: state.candidate, sketch: state.sketch, submission_id: state.submission_id } };
}

export function appendEvent(state, event) {
  state.history ??= [];
  if (state.history.some(e => e.event_id === event.event_id || event.event_type === 'attempt' &&
      e.attempt_id === event.attempt_id && (event.result === 'started' && e.result === 'started' ||
      terminalResults.has(event.result) && terminalResults.has(e.result)))) return false;
  state.history.push({ ...event, sequence: state.history.length + 1,
    observed_at: Object.hasOwn(event, 'observed_at') ? event.observed_at : new Date().toISOString() });
  return true;
}

export function reduceHistory(input = {}) {
  const state = historyState(input), starts = new Map(), outcomes = new Map();
  const excluded = new Set(state.history.filter(e => e.event_type === 'attempt_exclusion').map(e => e.attempt));
  for (const event of state.history) if (event.event_type === 'attempt' && !excluded.has(event.attempt)) {
    if (event.result === 'started') starts.set(event.attempt_id, event);
    else if (terminalResults.has(event.result) && !outcomes.has(event.attempt_id)) outcomes.set(event.attempt_id, event);
  }
  const baseline = state.legacy_baseline.attempts - [...excluded].filter(n => n <= state.legacy_baseline.attempts).length;
  const completed = [...outcomes.values()].sort((a, b) => a.attempt - b.attempt);
  return { totalAttempts: baseline + starts.size,
    attemptsInCurrentContext: (state.legacy_baseline.context_id === state.context_id ? baseline : 0) +
      [...starts.values()].filter(e => e.context_id === state.context_id).length,
    latestCompleted: completed.at(-1), latestFailure: completed.filter(e => e.failure).at(-1)?.failure,
    acceptedSketches: completed.filter(e => e.result === 'sketch_accepted'),
    lastAttemptAt: [...starts.values()].at(-1)?.observed_at ?? (baseline ? state.updated_at ?? state.claimed_at ?? '' : ''),
    candidates: completed.filter(e => e.artifacts).map(e => ({ attempt: e.attempt, ...e.artifacts })) };
}

// Only dependency identities and meaningful statuses enter the snapshot. Poll and
// graph timestamps cannot give a theorem a new context (or a priority boost).
export function relevantSnapshot(node, state = {}, nodes = new Map()) {
  const reductions = (node.reductions ?? []).filter(r => r.submission_id != null && !r.deprecated_at &&
    (r.status === undefined || ['ACCEPTED', 'SKETCH_ACCEPTED'].includes(r.status)));
  const dependencies = new Map();
  if (!Array.isArray(node.reductions)) for (const dependency of state.relevant_snapshot?.dependencies ?? []) {
    dependencies.set(`${dependency.reduction_id}:${dependency.id}`, dependency);
  }
  const add = (child, reduction) => {
    const id = child.theorem_id ?? child.definition_id;
    if (!id) return;
    const live = nodes.get(id) ?? child;
    const key = `${reduction}:${id}`;
    dependencies.set(key, { id, reduction_id: reduction, status: live.status,
      deprecated: !!live.deprecated_at, definition: !!child.definition_id });
  };
  for (const r of reductions) for (const child of r.children ?? []) add(child, r.submission_id);
  for (const child of state.published_dependencies ?? []) add(child, 'candidate');
  return { target: node.formal_statement === undefined ? state.target_fingerprint ?? null : targetFingerprint(node),
    environment: node.mathlib_rev ?? state.mathlib_rev ?? null,
    environment_fingerprint: node.environment_fingerprint ?? state.environment_fingerprint ?? null,
    dependencies: [...dependencies.values()].sort((a, b) => `${a.reduction_id}:${a.id}`.localeCompare(`${b.reduction_id}:${b.id}`)) };
}

export function observeContext(input, node, nodes = new Map(), graphRef, observedAt = null) {
  const state = historyState(input), snapshot = relevantSnapshot(node, state, nodes);
  const previous = state.relevant_snapshot;
  const blocked = snapshot.dependencies.some(d => d.deprecated || !d.definition && !['Open', 'Proved'].includes(d.status));
  const dependencyChanged = previous && snapshot.dependencies.some(d => {
    const old = previous.dependencies.find(p => p.id === d.id && p.reduction_id === d.reduction_id);
    return old ? old.status !== d.status || old.deprecated !== d.deprecated
      : d.deprecated || !d.definition && !['Open', 'Proved'].includes(d.status);
  });
  const targetChanged = previous ? previous.target !== snapshot.target || previous.environment !== snapshot.environment ||
    (previous.environment_fingerprint ?? state.environment_fingerprint) && (previous.environment_fingerprint ?? state.environment_fingerprint) !== snapshot.environment_fingerprint
    : state.target_fingerprint && state.target_fingerprint !== snapshot.target || state.mathlib_rev && state.mathlib_rev !== snapshot.environment;
  if (targetChanged || dependencyChanged || !previous && blocked) {
    const changed = snapshot.dependencies.filter(d => !previous?.dependencies.some(old => json(old) === json(d)));
    const result = changed.some(d => d.status === 'Disproved') ? 'dependency_disproved'
      : changed.some(d => d.deprecated) ? 'dependency_deprecated'
      : changed.length ? 'dependency_changed' : 'target_environment_changed';
    const contextId = digest(json([state.context_id, snapshot]));
    appendEvent(state, { event_id: contextId, event_type: 'context_change', attempt: null, result,
      observed_at: observedAt,
      previous_context_id: state.context_id, context_id: contextId,
      evidence: { dependencies: changed, previous_snapshot: previous ?? null, current_snapshot: snapshot,
        graph_snapshot_ref: graphRef, legacy_awareness: state.legacy_baseline.attempts ? 'unknown' : undefined } });
    state.context_id = contextId;
    delete state.retry_after; delete state.recovery_failure;
  }
  state.relevant_snapshot = snapshot;
  return state;
}

export function validHistory(state) {
  if (!Array.isArray(state.history) || !Number.isSafeInteger(state.legacy_baseline?.attempts) || state.legacy_baseline.attempts < 0) return false;
  const ids = new Set(), starts = new Map(), outcomes = new Set();
  let attempt = state.legacy_baseline.attempts;
  for (const [index, e] of state.history.entries()) {
    if (!e || e.sequence !== index + 1 || !e.event_id || ids.has(e.event_id)) return false;
    ids.add(e.event_id);
    if (e.event_type === 'context_change') {
      if (e.attempt !== null || !e.context_id) return false;
    } else if (e.event_type === 'attempt') {
      if (!e.attempt_id || !e.context_id || !Number.isSafeInteger(e.attempt)) return false;
      if (e.result === 'started') {
        if (starts.has(e.attempt_id) || e.attempt !== ++attempt) return false;
        starts.set(e.attempt_id, e);
      } else {
        if (!terminalResults.has(e.result) || outcomes.has(e.attempt_id) ||
            starts.get(e.attempt_id)?.attempt !== e.attempt || starts.get(e.attempt_id)?.context_id !== e.context_id) return false;
        outcomes.add(e.attempt_id);
      }
    } else if (e.event_type === 'attempt_exclusion') {
      if (!Number.isSafeInteger(e.attempt) || e.attempt < 1 || e.attempt > state.attempt_count ||
          e.reason !== 'codex_quota' || typeof e.evidence?.log !== 'string' ||
          !/^[a-f0-9]{64}$/.test(e.evidence?.source_hash ?? '') ||
          state.history.slice(0, index).some(old => old.event_type === 'attempt_exclusion' && old.attempt === e.attempt)) return false;
      if (e.attempt > state.legacy_baseline.attempts && starts.get(e.attempt_id)?.attempt !== e.attempt) return false;
      if (state.history.some(old => old.event_type === 'attempt' && old.attempt === e.attempt &&
          ['proof_accepted', 'sketch_accepted', 'disproof_accepted'].includes(old.result))) return false;
    } else return false;
  }
  return attempt === state.attempt_count;
}

export function failureFor({ origin, code, category, diagnostic_path }) {
  // Interpret typed server codes here, never feedback prose in the scheduler.
  category ??= ({ CE: 'compile_error', TLE: 'verification_timeout', TIMEOUT: 'verification_timeout',
    TYPE_MISMATCH: 'type_mismatch' })[code] ?? 'unknown';
  return { origin, category, code, diagnostic_path };
}

export function operationFor(state, parent = false) {
  if (parent) return 'reconsider_reduction';
  const history = reduceHistory(state), failure = history.latestFailure;
  if (history.latestCompleted?.candidate_kind === 'counterexample' &&
      ['rejected', 'incomplete'].includes(history.latestCompleted.result)) return 'certify_counterexample';
  if (['artifact_error', 'publication_conflict'].includes(failure?.category)) return 'repair_artifacts';
  if (failure?.category === 'counterexample_uncertified') return 'certify_counterexample';
  if (failure?.category === 'incomplete_argument') return 'reconsider_argument';
  return reduceHistory(state).totalAttempts ? 'repair_candidate' : 'implement';
}
