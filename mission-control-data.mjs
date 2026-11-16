import { open, readdir, realpath } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { readJson } from './runner-state.mjs';
import { workFrontier } from './work-policy.mjs';
import { reduceHistory } from './attempt-history.mjs';

export const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value);
const pick = (value, keys) => Object.fromEntries(keys.filter(key => value?.[key] !== undefined).map(key => [key, value[key]]));
const accepted = { proof_accepted: 'proof', sketch_accepted: 'reduction', disproof_accepted: 'disproof' };
const pendingStatuses = new Set(['SUBMITTING', 'SUBMISSION_UNKNOWN', 'PENDING', 'PUBLISHING', 'PUBLISH_PENDING', 'PUBLISH_UNKNOWN']);

export function redact(value, secrets = []) {
  let text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of secrets.filter(s => typeof s === 'string' && s.length >= 8)) text = text.split(secret).join('[REDACTED]');
  return text.replace(/\b(sk-[A-Za-z0-9_-]{12,}|p2m_[A-Za-z0-9_-]{12,})\b/g, '[REDACTED]')
    .replace(/(bearer\s+)[A-Za-z0-9._~+\/-]+/gi, '$1[REDACTED]')
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization)["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi, '$1[REDACTED]');
}

export async function readJobs(runs) {
  let entries;
  try { entries = await readdir(runs, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const jobs = [];
  for (let offset = 0; offset < entries.length; offset += 24) {
    const batch = await Promise.all(entries.slice(offset, offset + 24).filter(e => e.isDirectory() && safeId(e.name))
      .map(entry => readJson(join(runs, entry.name, 'state.json'))));
    jobs.push(...batch.filter(Boolean));
  }
  return jobs;
}

function nodeView(node) {
  return { ...pick(node, ['theorem_id', 'definition_id', 'theorem_name', 'formal_statement', 'preamble', 'status', 'deprecated_at']),
    reductions: (node.reductions ?? []).map(r => ({ ...pick(r, ['submission_id', 'status', 'usable', 'deprecated_at']),
      children: (r.children ?? []).map(c => pick(c, ['theorem_id', 'definition_id', 'theorem_name', 'status'])) })) };
}

export function buildMissionView({ mission, summary, graph, jobs, since = 0, until = Date.now() + 1 }) {
  const root = summary?.target?.root ?? mission.target?.root;
  const members = new Set([root, ...(graph?.nodes ?? graph?.leaves ?? []).map(n => n.theorem_id)]);
  const relevant = root ? jobs.filter(j => members.has(j.theorem_id) || j.root_id === root) : [];
  const nodes = new Map([...(graph?.root ? [graph.root] : []), ...(graph?.nodes ?? graph?.leaves ?? [])].map(n => [n.theorem_id, n]));
  const workers = new Map((summary?.live_workers ?? []).map(w => [w.theorem_id, w]));
  const results = new Map(), activity = [], pending = new Map();
  let attributionPartial = false;
  const work = relevant.map(job => {
    const history = reduceHistory(job);
    const starts = new Map((job.history ?? []).filter(e => e.result === 'started').map(e => [e.attempt_id, e]));
    const excluded = new Set((job.history ?? []).filter(e => e.event_type === 'attempt_exclusion').map(e => e.attempt));
    for (const event of job.history ?? []) {
      if (event.event_type !== 'attempt' || excluded.has(event.attempt)) continue;
      const start = starts.get(event.attempt_id);
      const eventRoot = event.root_id ?? start?.root_id;
      if (eventRoot && eventRoot !== root) continue;
      if (!eventRoot) attributionPartial = true;
      if (Date.parse(event.observed_at) < since || Date.parse(event.observed_at) >= until) continue;
      const row = { ...pick(event, ['event_id', 'attempt_id', 'attempt', 'result', 'model', 'reasoning_effort', 'operation', 'observed_at', 'submission_id']),
        theorem_id: job.theorem_id, theorem_name: nodes.get(job.theorem_id)?.theorem_name ?? job.theorem_name ?? job.theorem_id,
        kind: accepted[event.result], timestamp_basis: 'local observation of server verdict' };
      activity.push(row);
      if (row.kind && row.submission_id) results.set(row.submission_id, row);
    }
    for (const op of job.remote_operations ?? []) {
      if (op.status && ['ACCEPTED', 'REJECTED', 'DISPROVED', 'FAILED', 'ERROR', 'SKETCH_ACCEPTED', 'DISPROOF_REJECTED'].includes(op.status)) continue;
      // Only current unfinished operations; older replaced identities are history.
      if (op.submission_id && op.submission_id !== job.submission_id && !['PENDING', 'SUBMITTING'].includes(op.status)) continue;
      if (pendingStatuses.has(job.status)) pending.set(op.submission_id ?? op.operation_id ?? job.job_id, {
        theorem_id: job.theorem_id, operation_id: op.operation_id, submission_id: op.submission_id,
        started_at: op.started_at, status: op.status ?? job.status, unknown: !op.submission_id });
    }
    for (const publication of Object.values(job.publications ?? {})) {
      if (['PUBLISHED', 'FAILED', 'ERROR', 'REJECTED'].includes(publication.status)) continue;
      for (const op of publication.operations?.length ? publication.operations : [publication]) {
        if (['PUBLISHED', 'FAILED', 'ERROR', 'REJECTED'].includes(op.status)) continue;
        const id = op.job_id ?? op.operation_id ?? publication.job_id;
        if (!id) continue;
        pending.set(`publication:${id}`, { theorem_id: job.theorem_id, operation_id: op.operation_id,
          publication_id: op.job_id ?? publication.job_id, started_at: op.started_at, status: op.status ?? publication.status,
          unknown: !op.job_id && !publication.job_id });
      }
    }
    if (pendingStatuses.has(job.status) && !(job.remote_operations ?? []).length && !Object.keys(job.publications ?? {}).length) pending.set(job.submission_id ?? job.job_id ?? job.theorem_id,
      { theorem_id: job.theorem_id, submission_id: job.submission_id, status: job.status, unknown: /UNKNOWN/.test(job.status) });
    const worker = workers.get(job.theorem_id);
    const running = !!(mission.running && worker && job.job_status === 'ACTIVE' && worker.stage === job.stage &&
      (!summary.run_id || !job.run_id || job.run_id === summary.run_id) &&
      (!job.dispatch_state || job.dispatch_state === 'RUNNING'));
    const retryWaiting = job.job_status === 'READY' && job.recovery_failure &&
      job.recovery_failure.message !== 'incomplete_argument' && Date.parse(job.retry_after ?? '') > Date.now();
    return { ...pick(job, ['theorem_id', 'job_id', 'root_id', 'run_id', 'revision', 'job_status', 'stage', 'operation', 'dispatch_state',
      'status', 'model', 'reasoning_effort', 'attempt_id', 'attempt_count', 'context_id', 'updated_at', 'claimed_at', 'next_poll_at',
      'stage_wait_ms', 'verification_mode', 'submission_id']), theorem_name: nodes.get(job.theorem_id)?.theorem_name ?? job.theorem_name ?? job.theorem_id,
      running, worker_model: worker?.model,
      next_poll_at: retryWaiting ? job.retry_after : job.next_poll_at,
      preparation: running && job.stage === 'PREPARE' && worker.preparation ? pick(worker.preparation,
        ['phase', 'message', 'started_at', 'updated_at', 'files_copied', 'bytes_copied']) : null,
      total_attempts: history.totalAttempts, context_attempts: history.attemptsInCurrentContext,
      failure: history.latestFailure ? pick(history.latestFailure, ['origin', 'category', 'message', 'code']) : null,
      remote_issued: pendingStatuses.has(job.status),
      waiting_reason: retryWaiting ? `Previous ${job.recovery_failure.stage ?? 'job'} failure${job.recovery_failure.code ? ` (${job.recovery_failure.code})` : ''}: ${job.recovery_failure.message}`
        : job.job_status === 'ACTIVE' && (job.dispatch_state === 'DELAYED' ||
        job.pending_outcome?.dispatch_state === 'DELAYED') ? job.infrastructure_wait ?? null : null,
      history: (job.history ?? []).filter(e => e.event_type === 'attempt' && !excluded.has(e.attempt)).map(e => pick(e,
        ['event_id', 'attempt_id', 'attempt', 'result', 'model', 'reasoning_effort', 'operation', 'observed_at', 'submission_id', 'root_id', 'run_id'])).slice(-150),
      remote_operations: (job.remote_operations ?? []).map(op => pick(op, ['operation_id', 'submission_id', 'attempt_id', 'status', 'started_at', 'checked_at', 'reason', 'proof_type'])),
    };
  });
  let frontier = null;
  if (graph?.root) {
    const tasks = workFrontier(graph).tasks;
    // A parent whose sketches are all blocked is itself back on the frontier.
    const leafIds = [...new Set(tasks.filter(t => !t.cycle_members).map(t => t.theorem_id))];
    frontier = { leaves: leafIds.length, leafIds,
      repairs: new Set(tasks.filter(t => t.task_kind === 'parent').map(t => t.theorem_id)).size,
      cycles: new Set(tasks.filter(t => t.cycle_members).map(t => t.cycle_members.map(n => n.theorem_id).sort().join(','))).size,
      selectable: summary?.ready_work?.length ?? null };
  }
  const resultRows = [...results.values()].sort((a, b) => b.observed_at.localeCompare(a.observed_at));
  return { mission, summary: summary ? { ...pick(summary, ['run_id', 'started_at', 'status', 'root_status', 'root_confirmed', 'completed', 'updated_at',
    'finished_at', 'runner_pid', 'operator', 'pipeline', 'limits', 'waiting_reason', 'error', 'codex_quota', 'codex_sandbox_recovery', 'api_recovery', 'proof_storage_recovery',
    'graph_reconciling', 'graph_updates_pending', 'mission_research']),
    ready_work: (summary.ready_work ?? []).map(row => pick(row, ['theorem_id', 'theorem_name', 'task_kind', 'operation', 'score', 'closability', 'selection_reason', 'totalAttempts', 'attemptsInCurrentContext', 'cycle_members'])) } : null,
    root: graph?.root ? nodeView(graph.root) : null, frontier, jobs: work,
    graph: graph ? { observed_at: graph.updated_at, coverage: 'Solver frontier; completed paths may be pruned',
      nodes: (graph.nodes ?? graph.leaves ?? []).map(nodeView) } : null,
    counts: { proofs: resultRows.filter(r => r.kind === 'proof').length, reductions: resultRows.filter(r => r.kind === 'reduction').length,
      disproofs: resultRows.filter(r => r.kind === 'disproof').length, pending: pending.size,
      unknown: [...pending.values()].filter(p => p.unknown).length,
      proved_theorems: new Set(resultRows.filter(r => r.kind === 'proof').map(r => r.theorem_id)).size,
      sketched_theorems: new Set(resultRows.filter(r => r.kind === 'reduction').map(r => r.theorem_id)).size },
    results: resultRows, pending: [...pending.values()], activity: activity.sort((a, b) => b.observed_at.localeCompare(a.observed_at)),
    coverage: attributionPartial ? 'Historical events without a saved root are attributed by graph membership. Counts may overlap between missions.'
      : 'Distinct server submission IDs, attributed to the root saved with each attempt. Verdict times use local observation.',
    period: { since: new Date(since).toISOString(), until: new Date(until).toISOString() } };
}

const artifactPattern = /^(?:(?:solution|proof|counterexample|explanation|answer|codex|lean|agent|candidate|decomposition|prompt|failure)-[A-Za-z0-9_.-]+\.(?:lean|json|md|txt|log)|environment-(?:(?:\d+|check)-\d+(?:-elevated)?|codex-recovery-unelevated)\.log|context\.json)$/;
export async function artifactList(runs, id) {
  if (!safeId(id)) throw new Error('Invalid theorem ID');
  try {
    return (await readdir(join(runs, id), { withFileTypes: true })).filter(e => e.isFile() && artifactPattern.test(e.name))
      .map(e => ({ name: e.name, log: e.name.endsWith('.log') })).sort((a, b) => a.name.localeCompare(b.name));
  } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
export async function readArtifact(runs, id, name) {
  if (!safeId(id) || !artifactPattern.test(name) || !(await artifactList(runs, id)).some(e => e.name === name)) throw new Error('Unknown artifact');
  const base = await realpath(runs), path = await realpath(join(runs, id, name));
  const rel = relative(base, path);
  if (rel !== join(id, name)) throw new Error('Artifact is outside this run');
  const handle = await open(path, 'r');
  try {
    const { size } = await handle.stat(), limit = 256 * 1024;
    const buffer = Buffer.alloc(Math.min(size, limit));
    await handle.read(buffer, 0, buffer.length, name.endsWith('.log') ? Math.max(0, size - limit) : 0);
    return { content: buffer.toString('utf8'), truncated: size > limit, bytes: size };
  } finally { await handle.close(); }
}
