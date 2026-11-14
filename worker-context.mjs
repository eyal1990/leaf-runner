import { open } from 'node:fs/promises';
import { join } from 'node:path';

const pick = (value, keys) => value && Object.fromEntries(keys.filter(k => value[k] !== undefined).map(k => [k, value[k]]));
const clip = (value, limit) => typeof value === 'string'
  ? value.length > limit ? `${value.slice(0, limit)}\n[Excerpt; see the full artifact.]` : value : undefined;
const newestFirst = rows => [...rows].sort((a, b) =>
  (Date.parse(b.created_at ?? '') || 0) - (Date.parse(a.created_at ?? '') || 0));

// Select existing evidence deterministically. No scouting model or network calls.
function scoutingEvidence(manifest) {
  const milestoneEvents = manifest.milestone_history ?? [];
  const relevantEvents = newestFirst(milestoneEvents.filter(event => event.reason ||
    event.changed_fields?.includes('theorem_id')));
  const submissions = newestFirst(manifest.previous_submissions ?? []);
  const accepted = submissions.filter(row => ['ACCEPTED', 'SKETCH_ACCEPTED'].includes(row.status));
  const rejected = submissions.filter(row => ['CE', 'WA', 'SORRY', 'FAILED', 'ERROR'].includes(row.status));
  const sources = [...(manifest.accepted_reductions ?? []), ...(manifest.previous_submission_sources ?? [])];
  const sourcePaths = new Map(sources.filter(row => row.path).map(row => [row.submission_id, row.path]));
  const sourceErrors = new Map(sources.filter(row => row.error).map(row => [row.submission_id, row.error]));
  const submissionBrief = row => ({
    ...pick(row, ['id', 'submission_id', 'status', 'created_at', 'deprecated_at']),
    explanation: clip(row.explanation, 800), error_message: clip(row.error_message, 800),
    source_artifact_path: sourcePaths.get(row.id ?? row.submission_id),
    source_error: clip(sourceErrors.get(row.id ?? row.submission_id), 800),
  });
  const flags = (manifest.target?.audits ?? []).filter(row => row.decision === 'flag');
  return {
    // Link changes are observations, not automatically rejected proof routes.
    milestone_changes: relevantEvents.slice(0, 6).map(event => ({
      ...pick(event, ['id', 'event_type', 'created_at']),
      changed_fields: event.changed_fields?.slice(0, 12), reason: clip(event.reason, 1000),
      previous_theorem_id: event.old_values?.theorem_id,
      replacement_theorem_id: event.new_values?.theorem_id,
    })),
    milestone_events_omitted: milestoneEvents.length - Math.min(relevantEvents.length, 6),
    accepted_submissions: accepted.slice(0, 3).map(submissionBrief),
    rejected_submissions: rejected.slice(0, 3).map(submissionBrief),
    submissions_omitted: submissions.length - Math.min(accepted.length, 3) - Math.min(rejected.length, 3),
    review_flags: flags.slice(-3).map(row => ({
      ...pick(row, ['audit_id', 'decision', 'created_at']), comment: clip(row.comment, 1000),
    })),
    review_flags_omitted: Math.max(0, flags.length - 3),
  };
}

// Read the worker's labeled handoff without asking a model to summarize it.
// This remains advisory text, never a compilation or correctness certificate.
function proofHandoff(explanation) {
  if (typeof explanation !== 'string' || !explanation) return undefined;
  const labels = { 'remaining obligation': 'remaining_obligation', 'completed work': 'completed_work',
    'failed routes': 'failed_routes', 'next step': 'next_step' };
  const matches = [...explanation.matchAll(/^(?:#{1,6}\s+|[-*]\s+)?(?:\*\*)?(Remaining obligation|Completed work|Failed routes|Next step):(?:\*\*)?\s*/gim)];
  if (!matches.length) return undefined;
  return Object.fromEntries(matches.map((match, index) => [labels[match[1].toLowerCase()],
    clip(explanation.slice(match.index + match[0].length, matches[index + 1]?.index).trim(), 900)]));
}

// Bound automatic reads; complete artifacts stay available through explicit paths.
async function excerpt(path, limit) {
  if (!path) return undefined;
  let file;
  try {
    file = await open(path, 'r');
    const buffer = Buffer.alloc(limit * 4 + 4), { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, bytesRead).toString('utf8');
    return text.length > limit ? `${text.slice(0, limit)}\n[Excerpt; read the referenced file for details.]` : text;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  finally { await file?.close(); }
}

export async function workerContext(manifest, { dir, attempt, feedback, auditPath }) {
  const starts = new Map((manifest.history ?? []).filter(e => e.result === 'started').map(e => [e.attempt_id, e]));
  const outcomes = (manifest.history ?? []).filter(e => e.event_type === 'attempt' && e.result !== 'started');
  const recent = await Promise.all(outcomes.slice(-3).map(async event => {
    const start = starts.get(event.attempt_id), answerPath = event.artifacts?.answer_path;
    // Candidate envelopes store the mathematical explanation even for incomplete attempts.
    let explanation = await excerpt(event.artifacts?.candidate?.explanation_path, 50000);
    explanation ??= await excerpt(event.artifacts?.explanation_path, 50000);
    const candidatePath = event.artifacts?.candidate?.path;
    if (!explanation && candidatePath) {
      const text = await excerpt(candidatePath, 12000);
      try { explanation = JSON.parse(text)?.candidate?.explanation; } catch { /* legacy answer fallback below */ }
    }
    if (!explanation && answerPath) {
      const text = await excerpt(answerPath, 60000);
      try { explanation = JSON.parse(text)?.explanation; } catch { /* older or interrupted answer */ }
    }
    return { attempt: event.attempt, result: event.result, model: start?.model,
      reasoning_effort: start?.reasoning_effort, context_id: event.context_id,
      failure: event.failure, explanation: clip(explanation, 1800), handoff: proofHandoff(explanation), answer_path: answerPath,
      explanation_path: event.artifacts?.candidate?.explanation_path ?? event.artifacts?.explanation_path,
      solution_path: event.artifacts?.solution_path, candidate_path: candidatePath };
  }));
  return {
    schema_version: 1, target: manifest.target, environment: manifest.environment,
    operation: manifest.operation, context_id: manifest.context_id,
    escalation: manifest.escalation,
    total_attempts: manifest.total_attempts, current_context_attempts: manifest.current_context_attempts,
    selection: pick(manifest.selection, ['theorem_id', 'task_kind', 'score', 'closability', 'selection_reason', 'cycle_members']),
    legacy_awareness: manifest.legacy_baseline?.awareness,
    latest_diagnostic: feedback || null,
    previous_artifacts: attempt > 1 ? {
      solution_path: join(dir, `solution-${attempt - 1}.lean`), answer_path: join(dir, `answer-${attempt - 1}.json`),
      diagnostic_path: join(dir, `failure-${attempt - 1}.json`),
    } : null,
    recent_attempts: recent,
    earlier_attempts_omitted: Math.max(0, outcomes.length - recent.length),
    previous_candidate: manifest.previous_candidate,
    accepted_sketch: manifest.operation === 'reconsider_reduction' ? manifest.accepted_sketch : undefined,
    accepted_reductions: manifest.accepted_reductions,
    dependency_evidence: manifest.dependency_evidence,
    published_dependencies: manifest.published_dependencies,
    allowed_direct_proof_imports: manifest.allowed_direct_proof_imports,
    scouting_evidence: scoutingEvidence(manifest),
    mission_research: manifest.mission_research ? { ...manifest.mission_research,
      notes_excerpt: await excerpt(manifest.mission_research.notes_path, 2400) } : null,
    audit_context_path: auditPath,
  };
}
