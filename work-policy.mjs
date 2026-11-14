import { historyState, observeContext, reduceHistory, operationFor } from './attempt-history.mjs';
import { cyclicComponents } from './graph-cycles.mjs';
import { attemptModel, incompleteEscalation } from './model-policy.mjs';

export const liveOpen = node => (node.status === undefined || node.status === 'Open') && !node.deprecated_at;
export const acceptedReduction = r => r.submission_id != null && !r.deprecated_at &&
  (r.status === undefined || ['ACCEPTED', 'SKETCH_ACCEPTED'].includes(r.status));
export const usableReduction = (r, nodes) => acceptedReduction(r) && r.usable !== false &&
  !(r.children ?? []).some(child => {
    const live = nodes.get(child.theorem_id ?? child.definition_id) ?? child;
    return live.deprecated_at || !child.definition_id && !['Open', 'Proved'].includes(live.status);
  });

export function workFrontier(graph) {
  const nodes = new Map((graph.nodes ?? [graph.root, ...graph.leaves]).map(n => [n.theorem_id, n]));
  const root = nodes.get(graph.root.theorem_id) ?? graph.root;
  const needed = new Set(), tasks = [], satisfied = new Set();
  if (!liveOpen(root)) return { needed, tasks, nodes };
  if (!Array.isArray(root.reductions)) {
    needed.add(root.theorem_id);
    for (const leaf of graph.leaves.filter(liveOpen)) { needed.add(leaf.theorem_id); tasks.push({ ...leaf, task_kind: 'leaf' }); }
    return { needed, tasks, nodes };
  }
  // Accepted reductions can close several ancestors after one leaf verdict.
  // This affects scheduling only; authoritative node/root statuses stay intact.
  let closed;
  do {
    closed = false;
    for (const node of nodes.values()) if (liveOpen(node) && !satisfied.has(node.theorem_id) &&
      (node.reductions ?? []).some(r => usableReduction(r, nodes) && (r.children ?? []).every(c =>
        c.definition_id || (nodes.get(c.theorem_id) ?? c).status === 'Proved' || satisfied.has(c.theorem_id)))) {
      satisfied.add(node.theorem_id); closed = true;
    }
  } while (closed);
  const queue = [root];
  for (let i = 0; i < queue.length; i++) {
    const node = queue[i], id = node.theorem_id;
    if (needed.has(id) || !liveOpen(node)) continue;
    if (!nodes.has(id)) nodes.set(id, node);
    needed.add(id);
    const accepted = (node.reductions ?? []).filter(acceptedReduction);
    const usable = accepted.filter(r => usableReduction(r, nodes));
    if (satisfied.has(id)) {
      needed.delete(id); satisfied.add(id); continue;
    }
    if (!usable.length) {
      tasks.push({ ...node, task_kind: accepted.length ? 'parent' : 'leaf' });
      continue;
    }
    for (const r of usable) for (const child of r.children ?? []) if (!child.definition_id) queue.push(nodes.get(child.theorem_id) ?? child);
  }
  // A cycle with an independent alternative can be closed by ordinary leaf work.
  // Ground the AND/OR graph from actionable tasks, never from the cycle itself.
  const grounded = new Set([...satisfied, ...tasks.map(t => t.theorem_id)]);
  let changed;
  do {
    changed = false;
    for (const id of needed) if (!grounded.has(id) && (nodes.get(id).reductions ?? []).some(r =>
      usableReduction(r, nodes) && (r.children ?? []).every(child => child.definition_id ||
        (nodes.get(child.theorem_id) ?? child).status === 'Proved' || grounded.has(child.theorem_id)))) {
      grounded.add(id); changed = true;
    }
  } while (changed);
  const unresolved = [...needed].filter(id => !grounded.has(id));
  const dependencies = new Map(unresolved.map(id => [id, (nodes.get(id).reductions ?? [])
    .filter(r => usableReduction(r, nodes)).flatMap(r => (r.children ?? []).filter(c => !c.definition_id).map(c => c.theorem_id))]));
  for (const component of cyclicComponents(unresolved, dependencies)) {
    const members = component.map(id => ({ theorem_id: id, theorem_name: nodes.get(id).theorem_name }));
    for (const id of component) tasks.push({ ...nodes.get(id), task_kind: 'parent',
      selection_reason: 'cyclic_reduction', cycle_members: members });
  }
  return { needed, tasks, nodes };
}

// Hypothetical direct proof, including non-leaf parents. AND within each
// reduction, OR across reductions; shared ancestors contribute once.
export function closabilityFor(id, graph) {
  const nodes = new Map((graph.nodes ?? []).map(n => [n.theorem_id, n]));
  if (!nodes.size || ![...nodes.values()].some(n => Array.isArray(n.reductions))) {
    return graph.leaves.find(n => n.theorem_id === id)?.closability ?? 0;
  }
  function cascade(seed) {
    const resolved = new Set(seed);
    let changed;
    do {
      changed = false;
      for (const n of nodes.values()) if (liveOpen(n) && !resolved.has(n.theorem_id) &&
        (n.reductions ?? []).some(r => usableReduction(r, nodes) && (r.children ?? []).every(c =>
          c.definition_id || (nodes.get(c.theorem_id) ?? c).status === 'Proved' || resolved.has(c.theorem_id)))) {
        resolved.add(n.theorem_id); changed = true;
      }
    } while (changed);
    return resolved;
  }
  const baseline = cascade([]);
  return cascade([...baseline, id]).size - baseline.size - (baseline.has(id) ? 0 : 1);
}

const pending = new Set(['SUBMITTING', 'SUBMISSION_UNKNOWN', 'PENDING', 'PUBLISHING', 'PUBLISH_PENDING', 'PUBLISH_UNKNOWN']);
export function selectable(state, task, now = Date.now(), options = {}) {
  if (!state) return true;
  if (['ACTIVE', 'NEEDS_ATTENTION'].includes(state.job_status) || pending.has(state.status) || state.pending_outcome) return false;
  // Older runs persisted backoff for incomplete mathematics. Ignore that saved
  // delay on restart while retaining delays for infrastructure/job failures.
  if (state.recovery_failure?.message !== 'incomplete_argument' && Date.parse(state.retry_after ?? '') > now) return false;
  if (state.status === 'COUNTEREXAMPLE' && state.job_status !== 'RETIRED') return false;
  const changedTarget = state.target_fingerprint && state.relevant_snapshot?.target !== state.target_fingerprint ||
    state.mathlib_rev && state.relevant_snapshot?.environment !== state.mathlib_rev;
  if (['ACCEPTED', 'DISPROVED'].includes(state.status) && !changedTarget) return false;
  if (state.status === 'SKETCH_ACCEPTED' && state.submission_id && !changedTarget &&
      !(task.reductions ?? []).some(r => r.submission_id === state.submission_id)) return false;
  if (state.status === 'SKETCH_ACCEPTED' && task.task_kind !== 'parent' && !changedTarget) return false;
  return true;
}

// Shared by atomic admission and the final check immediately before a model
// invocation. A newly opened Luna leaf can supersede a queued rescue.
export function escalationBlocker(graph, states = new Map(), theoremId, now = Date.now(), options = {}) {
  const { tasks, nodes } = workFrontier(graph);
  const current = states.get(theoremId);
  const order = state => `${state.claimed_at ?? ''}:${state.theorem_id ?? ''}`;
  for (const task of tasks) {
    if (task.theorem_id === theoremId) continue;
    const original = states.get(task.theorem_id) ?? graph.states?.[task.theorem_id];
    const state = observeContext(historyState(original), task, nodes, graph.snapshot_ref, graph.updated_at ?? null);
    const rescue = state.selection?.automatic_escalation || state.escalation && state.escalation.automatic !== false ||
      attemptModel(Math.max(1, (state.attempt_count ?? 0) + (state.codex_quota_wait ? 0 : 1)), options, state).escalation?.automatic;
    if (state.job_status === 'ACTIVE' && rescue && (!current || order(state) < order(current))) return 'another rescue is already reserved';
  }
  return null;
}

// Pure projection, used for preview as well as the fresh atomic claim.
export function scoreWork(graph, states = new Map(), now = Date.now(), options = {}) {
  if (!liveOpen(graph.root)) return [];
  const { tasks, nodes } = workFrontier(graph);
  const ranked = tasks.flatMap(task => {
    // One independent repair can break an entire component. Preserve capacity
    // for other work while that repair is already preparing or awaiting a verdict.
    if (task.cycle_members?.some(member => {
      if (member.theorem_id === task.theorem_id) return false;
      const peer = states.get(member.theorem_id) ?? graph.states?.[member.theorem_id];
      return peer?.job_status === 'ACTIVE' || pending.has(peer?.status) || peer?.pending_outcome;
    })) return [];
    const original = states.get(task.theorem_id) ?? graph.states?.[task.theorem_id] ??
      (task.work_status || task.attempt_count ? { ...task, status: task.work_status } : undefined);
    const state = observeContext(historyState(original), task, nodes, graph.snapshot_ref, graph.updated_at ?? null);
    if (!selectable(original ? state : undefined, task, now, options)) return [];
    const counts = reduceHistory(state), closability = closabilityFor(task.theorem_id, graph);
    return [{ ...task, closability, totalAttempts: counts.totalAttempts, attemptsInCurrentContext: counts.attemptsInCurrentContext,
      score: 10 * closability - 10 * counts.attemptsInCurrentContext - counts.totalAttempts -
        (state.recovery_failure?.origin === 'job_error' ? 10 * state.recovery_failure.count : 0),
      operation: operationFor(state, task.task_kind === 'parent'),
      selection_reason: task.selection_reason ?? (task.task_kind === 'parent' ? 'invalidated_reduction' : counts.totalAttempts ? 'retry_open_theorem' : 'untried_leaf'),
      context_id: state.context_id, context_change: state.history.filter(e => e.event_type === 'context_change').at(-1),
      stuck: !!incompleteEscalation(state, options),
      automatic_escalation: !!attemptModel(counts.totalAttempts + 1, options, state).escalation?.automatic,
      last_attempt_at: counts.lastAttemptAt, projected_state: state }];
  }).sort((a, b) => Number(a.stuck) - Number(b.stuck) || b.score - a.score || Number(a.totalAttempts > 0) - Number(b.totalAttempts > 0) ||
    a.last_attempt_at.localeCompare(b.last_attempt_at) ||
    (a.theorem_name ?? a.theorem_id).localeCompare(b.theorem_name ?? b.theorem_id) || a.theorem_id.localeCompare(b.theorem_id));
  // Inexpensive work ranks first. A confirmed stall may use spare capacity
  // without waiting indefinitely for unrelated cooldowns or verdicts. Reserve
  // at most one automatic rescue across preparing, running, and remote jobs.
  return ranked.filter(work => !work.automatic_escalation || !escalationBlocker(graph, states, work.theorem_id, now, options));
}

export const selectWork = (graph, states, options) => scoreWork(graph, states, Date.now(), options)[0] ?? null;
