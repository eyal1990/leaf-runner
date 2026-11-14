import { targetFingerprint } from './runner-state.mjs';
import { acceptedReduction, workFrontier } from './work-policy.mjs';

export class GraphUpdatePending extends Error {}

const idOf = row => row.theorem_id ?? row.definition_id;
export const sameGraphTarget = (node, event) => !event.target_hash || !node.formal_statement ||
  targetFingerprint(node) === event.target_hash;
const sameTarget = sameGraphTarget;

// Only completed, server-confirmed outcomes change platform graph metadata.
// Attempt history and publication journals already have their own durable stores.
export function graphOutcome(job) {
  if (job.job_status !== 'DONE') return null;
  const status = { ACCEPTED: 'Proved', DISPROVED: 'Disproved' }[job.status];
  const inspect = job.status?.startsWith('SKIPPED');
  if (!status && job.status !== 'SKETCH_ACCEPTED' && !inspect) return null;
  return { id: `${job.theorem_id}:${job.submission_id ?? job.job_id}:${job.status}`,
    theorem_id: job.theorem_id, submission_id: job.submission_id,
    target_hash: job.target_fingerprint, status,
    kind: inspect ? 'inspect' : status ? 'status' : 'sketch',
    pending: !status, next_check_at: 0, observed_at: job.updated_at };
}

export function reconciledUpdate(frontier, event) {
  const node = (frontier.nodes ?? [frontier.root, ...frontier.leaves]).find(n => n.theorem_id === event.theorem_id);
  if (!node) return true;
  if (!sameTarget(node, event)) return false;
  if (event.kind !== 'status' && (node.deprecated_at || ['Proved', 'Disproved', 'Dead'].includes(node.status))) return true;
  if (event.kind === 'status') return node.status === event.status;
  if (event.kind === 'inspect') return !event.pending;
  return (node.reductions ?? []).some(r => r.submission_id === event.submission_id);
}

// This is a scheduling projection. Inferred ancestor closure never changes a
// theorem's server status, including the root's completion status.
export function applyGraphUpdates(frontier, events) {
  const graph = structuredClone(frontier);
  const nodes = new Map((graph.nodes ?? [graph.root, ...graph.leaves]).map(n => [n.theorem_id, n]));
  nodes.set(graph.root.theorem_id, { ...nodes.get(graph.root.theorem_id), ...graph.root });
  for (const event of events) {
    const target = nodes.get(event.theorem_id);
    const replaces = target?.formal_statement && event.previous_target_hash && targetFingerprint(target) === event.previous_target_hash;
    if (!target || !sameTarget(target, event) && !replaces || event.pending) continue;
    for (const node of event.nodes ?? []) {
      if (node.theorem_id === event.theorem_id || !nodes.has(node.theorem_id)) nodes.set(node.theorem_id, structuredClone(node));
    }
  }
  // A sketch's dependency metadata must not overwrite a newer accepted proof.
  for (const event of events) {
    const node = nodes.get(event.theorem_id);
    if (node && sameTarget(node, event) && event.status) node.status = event.status;
  }
  for (const node of nodes.values()) if (Array.isArray(node.reductions)) {
    node.reductions = node.reductions.map(r => {
      const blockers = (r.children ?? []).filter(child => {
        const live = nodes.get(idOf(child)) ?? child;
        return live.deprecated_at || !child.definition_id && !['Open', 'Proved'].includes(live.status);
      });
      return { ...r, blockers, usable: acceptedReduction(r) && !blockers.length };
    });
    node.children = [...new Set(node.reductions.filter(acceptedReduction)
      .flatMap(r => (r.children ?? []).filter(c => !c.definition_id).map(idOf)))];
  }
  graph.root = nodes.get(graph.root.theorem_id) ?? graph.root;
  graph.nodes = [...nodes.values()];
  if (Array.isArray(graph.root.reductions)) {
    graph.leaves = workFrontier(graph).tasks.filter(t => !t.cycle_members);
  } else graph.leaves = graph.leaves.map(n => nodes.get(n.theorem_id) ?? n).filter(n => n.status === 'Open');
  return graph;
}

// Read just the changed theorem and expand previously unknown prerequisites.
// The server's accepted edges, rather than the proposed artifact list, are used.
export async function readGraphUpdate(client, event, graph) {
  const target = structuredClone(await client.request(`theorems/${encodeURIComponent(event.theorem_id)}`));
  if (target.theorem_id !== event.theorem_id || typeof target.status !== 'string') throw new Error('Invalid graph update theorem');
  const matches = sameTarget(target, event);
  if (event.verify_identity && matches && event.status && target.status === 'Open' && !target.deprecated_at) target.status = event.status;
  const known = new Set((graph.nodes ?? [graph.root, ...graph.leaves]).map(n => n.theorem_id));
  const nodes = new Map([[target.theorem_id, target]]), queue = [];
  if (target.status === 'Open' && !target.deprecated_at) queue.push(target.theorem_id);
  for (let offset = 0; offset < queue.length;) {
    const batch = queue.slice(offset, offset + 4);
    const results = await Promise.allSettled(batch.map(id => client.request(`theorems/${encodeURIComponent(id)}/decompositions`)));
    for (const [i, result] of results.entries()) {
      if (result.status === 'rejected') throw result.reason;
      const reductions = result.value.decompositions;
      if (!Array.isArray(reductions)) throw new Error('Invalid graph update decompositions');
      const node = nodes.get(batch[i]); node.reductions = structuredClone(reductions);
      for (const reduction of reductions) {
        if (!reduction || typeof reduction !== 'object' || !Array.isArray(reduction.children)) throw new Error('Invalid graph update reduction');
        if (!acceptedReduction(reduction)) continue;
        if (typeof reduction.submission_id !== 'string' || !reduction.submission_id) throw new Error('Invalid graph update reduction ID');
        for (const child of reduction.children) {
          if (child.definition_id) continue;
          if (typeof child.theorem_id !== 'string' || typeof child.theorem_name !== 'string' || typeof child.status !== 'string') {
            throw new Error('Invalid graph update child');
          }
          if (known.has(child.theorem_id) || nodes.has(child.theorem_id)) continue;
          if (known.size + nodes.size >= 10000) throw new Error('Frontier exceeds 10000 theorems; select a smaller milestone');
          nodes.set(child.theorem_id, structuredClone(child));
          if (child.status === 'Open' && !child.deprecated_at) queue.push(child.theorem_id);
        }
      }
    }
    offset += batch.length;
  }
  if (event.kind === 'sketch' && sameTarget(target, event) && target.status === 'Open' && !target.deprecated_at &&
      !(target.reductions ?? []).some(r => r.submission_id === event.submission_id)) {
    throw new GraphUpdatePending('Accepted reduction is not visible yet');
  }
  return { nodes: [...nodes.values()], target_hash: target.formal_statement ? targetFingerprint(target) : undefined,
    ...(event.verify_identity || !matches ? { status: matches && event.status ? target.status : undefined,
      kind: matches && event.status ? 'status' : 'inspect', verify_identity: false } : {}),
    ...(['Proved', 'Disproved'].includes(target.status) ? { kind: 'status', status: target.status } : {}) };
}
