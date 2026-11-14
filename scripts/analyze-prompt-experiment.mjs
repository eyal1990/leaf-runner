// Read-only report. No API, model calls, or changes to runner state.
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { PROMPT_EXPERIMENT, PROMPT_VARIANTS, AB_PROMPT_VARIANTS } from '../prompt-experiment.mjs';

const inWindow = (at, since, until) => Date.parse(at) >= since && Date.parse(at) < until;
const countBy = (rows, key) => {
  const counts = {};
  for (const row of rows) { const value = key(row) ?? 'unknown'; counts[value] = (counts[value] ?? 0) + 1; }
  return counts;
};
const variantOf = assignment => assignment?.experiment_id === PROMPT_EXPERIMENT
  ? assignment.variant : assignment?.experiment_id === 'proof-first-v1' && AB_PROMPT_VARIANTS.includes(assignment.variant)
    ? `historical_proof-first-v1_${assignment.variant}` : assignment?.experiment_id === null && [...PROMPT_VARIANTS, 'original'].includes(assignment.variant)
    ? `configured_${assignment.variant}` : 'legacy_unassigned';
const groups = (rows, summarize) => Object.fromEntries([...new Set([...AB_PROMPT_VARIANTS, ...rows.map(r => r.variant)])]
  .map(variant => [variant, summarize(rows.filter(r => r.variant === variant))]));

export function summarizeAttempts(rows) {
  const resultCount = result => rows.filter(r => r.result === result).length;
  const accepted = resultCount('proof_accepted');
  return { attempts: rows.length, distinct_theorems: new Set(rows.map(r => r.theorem_id)).size,
    submissions: new Set(rows.flatMap(r => r.submissions.map(s => s.submission_id))).size,
    upload_operations: rows.reduce((n, r) => n + r.upload_operations, 0),
    proofs: accepted, sketches: resultCount('sketch_accepted'), disproofs: resultCount('disproof_accepted'),
    incomplete: resultCount('incomplete'), rejected: resultCount('rejected'), interrupted: resultCount('interrupted'),
    pending: resultCount('pending'),
    failures: rows.filter(r => ['rejected', 'incomplete', 'interrupted'].includes(r.result)).length,
    proof_acceptance_per_attempt: rows.length ? accepted / rows.length : null,
    outcomes: countBy(rows, r => r.result), candidates: countBy(rows, r => r.candidate_kind),
    failures_by_origin: countBy(rows.filter(r => r.failure), r => r.failure.origin),
    failures_by_category: countBy(rows.filter(r => r.failure), r => r.failure.category),
    models: countBy(rows, r => r.model), operations: countBy(rows, r => r.operation) };
}

export async function analyzePromptExperiment({ runs = '.runs', since, until = Date.now() } = {}) {
  until = typeof until === 'number' ? until : Date.parse(until);
  since = since === undefined ? until - 3600000 : typeof since === 'number' ? since : Date.parse(since);
  if (!Number.isFinite(since) || !Number.isFinite(until) || since >= until) throw new Error('Expected valid dates with since < until');
  const attempts = [], submissions = new Map();
  let excluded = 0;
  for (const entry of await readdir(runs, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    let state;
    try { state = JSON.parse(await readFile(join(runs, entry.name, 'state.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    const history = state.history ?? [], uploads = state.remote_operations ?? [];
    const excludedAttempts = new Set(history.filter(e => e.event_type === 'attempt_exclusion').map(e => e.attempt));
    const starts = history.filter(e => e.event_type === 'attempt' && e.result === 'started');
    const ends = new Map(history.filter(e => e.event_type === 'attempt' && e.result !== 'started').map(e => [e.attempt_id, e]));
    for (const start of starts) {
      if (excludedAttempts.has(start.attempt)) { if (inWindow(start.observed_at, since, until)) excluded++; continue; }
      const end = ends.get(start.attempt_id);
      const remote = uploads.filter(op => op.attempt_id ? op.attempt_id === start.attempt_id : op.attempt === start.attempt);
      const variant = variantOf(start.prompt_experiment);
      const row = { theorem_id: state.theorem_id ?? entry.name, attempt_id: start.attempt_id, attempt: start.attempt,
        variant, prompt_experiment: start.prompt_experiment ?? null,
        started_at: start.observed_at, finished_at: end?.observed_at ?? null,
        duration_seconds: end ? (Date.parse(end.observed_at) - Date.parse(start.observed_at)) / 1000 : null,
        model: start.model, reasoning_effort: start.reasoning_effort, operation: start.operation,
        context_id: start.context_id, result: end?.result ?? 'pending', failure: end?.failure,
        candidate_kind: end?.candidate_kind ?? remote.find(op => op.candidate_kind)?.candidate_kind ??
          (state.attempt_id === start.attempt_id ? state.candidate_kind : undefined),
        prompt_path: start.prompt_path, prompt_metadata_path: start.prompt_metadata_path,
        upload_operations: remote.length, submissions: [] };
      // Recovery uploads can repeat a submission ID. Count each server ID once.
      for (const op of remote.filter(op => op.submission_id)) {
        const submission = { theorem_id: row.theorem_id, attempt_id: start.attempt_id, variant,
          submission_id: op.submission_id, submitted_at: op.started_at, status: op.status,
          candidate_kind: op.candidate_kind ?? row.candidate_kind, proof_type: op.proof_type,
          checked_at: op.checked_at };
        if (!submissions.has(op.submission_id)) submissions.set(op.submission_id, submission);
        if (!row.submissions.some(s => s.submission_id === op.submission_id)) row.submissions.push(submission);
      }
      attempts.push(row);
    }
  }
  const cohort = attempts.filter(r => inWindow(r.started_at, since, until));
  const completed = attempts.filter(r => inWindow(r.finished_at, since, until));
  const submitted = [...submissions.values()].filter(r => inWindow(r.submitted_at, since, until));
  return { experiment_id: PROMPT_EXPERIMENT, generated_at: new Date().toISOString(), runs: resolve(runs),
    window: { since: new Date(since).toISOString(), until_exclusive: new Date(until).toISOString() },
    assignment: { unit: 'mathematical_attempt', probabilities: { original: 0.5, proof_first: 0.5 } },
    interpretation: 'Started-at cohort; outcomes and submission statuses are latest known at report generation. Window activity also includes attempts started earlier. Failures include incomplete, rejected, and interrupted attempts. Pending is separate. Historical experiments, legacy unassigned and configured_* attempts are not part of the current randomized experiment. Quota continuations and formatting repairs are not new attempts. Upload operations include recovery retries; submissions count unique server IDs. Attempts may share theorem history; use model, operation, and theorem IDs when comparing.',
    excluded_quota_attempts: excluded,
    attempts_started_in_window: groups(cohort, summarizeAttempts),
    outcomes_recorded_in_window: groups(completed, summarizeAttempts),
    submissions_in_window: groups(submitted, rows => ({ submissions: rows.length,
      candidates: countBy(rows, r => r.candidate_kind), statuses: countBy(rows, r => r.status) })),
    attempts: attempts.filter(r => inWindow(r.started_at, since, until) || inWindow(r.finished_at, since, until) ||
      r.submissions.some(s => inWindow(s.submitted_at, since, until))).sort((a, b) => a.started_at.localeCompare(b.started_at)),
  };
}

async function main() {
  const { values } = parseArgs({ options: { runs: { type: 'string', default: '.runs' },
    since: { type: 'string' }, until: { type: 'string' }, 'last-minutes': { type: 'string' },
    output: { type: 'string' }, help: { type: 'boolean' } } });
  if (values.help) {
    console.log('Usage: node scripts/analyze-prompt-experiment.mjs [--runs PATH] [--last-minutes 60 | --since ISO_DATE] [--until ISO_DATE] [--output FILE]\nOutputs a JSON comparison and per-attempt data without changing runner state. Dates must include Z or a numeric timezone offset.'); return;
  }
  if (values.since && values['last-minutes']) throw new Error('Use either --since or --last-minutes');
  for (const key of ['since', 'until']) if (values[key] && !/(Z|[+-]\d{2}:\d{2})$/i.test(values[key])) {
    throw new Error(`--${key} must include a timezone (Z or numeric offset)`);
  }
  const until = values.until ? Date.parse(values.until) : Date.now();
  const minutes = Number(values['last-minutes'] ?? 60);
  if (!Number.isFinite(minutes) || minutes <= 0) throw new Error('--last-minutes must be positive');
  const report = JSON.stringify(await analyzePromptExperiment({ runs: values.runs, until,
    since: values.since ?? until - minutes * 60000 }), null, 2) + '\n';
  if (values.output) await writeFile(values.output, report, 'utf8');
  else process.stdout.write(report);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
