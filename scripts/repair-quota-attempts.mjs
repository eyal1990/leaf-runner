import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { acquireRunnerLock } from '../prove2me.mjs';
import { JobStore } from '../job-store.mjs';
import { appendEvent, reduceHistory, validHistory } from '../attempt-history.mjs';
import { quotaFailureFromLog } from '../codex-quota.mjs';
import { digest, readJson, save } from '../runner-state.mjs';
import { scoreWork } from '../work-policy.mjs';

async function tail(path) {
  const file = await open(path, 'r');
  try {
    const { size } = await file.stat(), buffer = Buffer.alloc(Math.min(size, 65536));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, Math.max(0, size - buffer.length));
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally { await file.close(); }
}
async function hashFile(path) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest('hex');
}

// Keep attempt numbers, artifacts, and the original history intact. An explicit
// evidence-backed correction removes only a failed quota attempt from scoring.
export async function repairQuotaAttempts(runs, { apply = false } = {}) {
  runs = resolve(runs);
  const release = apply ? acquireRunnerLock(join(runs, 'runner.lock')) : () => {};
  try {
    const store = new JobStore(runs), index = await store.index();
    const stamp = new Date().toISOString().replaceAll(':', '-');
    const directory = join(runs, 'diagnostics', `quota-repair-${stamp}`);
    const report = { created_at: new Date().toISOString(), applied: apply, runs,
      attempts: [], jobs: [], skipped: [], already_excluded: [], timeline: [] };
    for (const [id, state] of index) {
      const before = reduceHistory(state), original = await readFile(store.path(id), 'utf8');
      const proposed = structuredClone(state), excluded = new Set(state.history?.filter(e => e.event_type === 'attempt_exclusion').map(e => e.attempt));
      for (const name of (await readdir(join(runs, id))).filter(name => /^codex-\d+(?:-repair)?\.log$/.test(name)).sort()) {
        const log = join(runs, id, name), error = quotaFailureFromLog(await tail(log), log);
        if (!error) continue;
        const attempt = Number(name.match(/^codex-(\d+)/)[1]);
        const start = state.history?.find(e => e.event_type === 'attempt' && e.attempt === attempt && e.result === 'started');
        const outcome = state.history?.find(e => e.event_type === 'attempt' && e.attempt === attempt && e.result !== 'started');
        const record = { theorem_id: id, attempt, attempt_id: start?.attempt_id, log,
          started_at: start?.observed_at, failed_at: outcome?.observed_at };
        report.timeline.push(record);
        if (excluded.has(attempt)) { report.already_excluded.push(record); continue; }
        const skip = state.schema_version !== 2 ? 'Migrate this legacy record before correcting its score'
          : name.includes('-repair') ? 'Formatting failure does not erase the preceding mathematical attempt'
          : start && (!outcome || !['rejected', 'interrupted'].includes(outcome.result)) ? 'Attempt has a non-quota mathematical outcome or is still active'
          : !start && attempt > state.legacy_baseline.attempts ? 'Attempt is absent from structured history and the legacy baseline'
          : null;
        if (skip) { report.skipped.push({ ...record, reason: skip }); continue; }
        const source_hash = await hashFile(log);
        appendEvent(proposed, { event_type: 'attempt_exclusion', event_id: `quota-exclusion:${attempt}`,
          attempt, attempt_id: start?.attempt_id, reason: 'codex_quota', evidence: { log, source_hash },
          context_id: start?.context_id ?? state.legacy_baseline.context_id });
        excluded.add(attempt); report.attempts.push({ ...record, source_hash });
      }
      if (proposed.history.length === state.history.length) continue;
      if (!validHistory(proposed)) throw new Error(`Invalid corrected history for ${id}`);
      const after = reduceHistory(proposed);
      report.jobs.push({ theorem_id: id, before: { totalAttempts: before.totalAttempts, attemptsInCurrentContext: before.attemptsInCurrentContext },
        after: { totalAttempts: after.totalAttempts, attemptsInCurrentContext: after.attemptsInCurrentContext },
        score_improvement: 10 * (before.attemptsInCurrentContext - after.attemptsInCurrentContext) + before.totalAttempts - after.totalAttempts });
      if (apply) {
        await mkdir(directory, { recursive: true });
        await writeFile(join(directory, `${id}.state.before.json`), original, { flag: 'wx' });
        // The runner lock excludes other runners; still detect an unexpected writer.
        if (digest(await readFile(store.path(id), 'utf8')) !== digest(original)) throw new Error(`State changed during correction: ${id}`);
        proposed.revision++; proposed.quota_scores_corrected_at = report.created_at;
        await save(store.path(id), proposed);
      }
    }
    report.timeline.sort((a, b) => (a.started_at ?? '').localeCompare(b.started_at ?? ''));
    if (apply && report.jobs.length) {
      const summary = await readJson(join(runs, 'last-run.json'));
      const root = summary?.target?.root;
      if (root && /^[A-Za-z0-9_-]+$/.test(root)) {
        const graph = await readJson(join(runs, 'graphs', `${root}.json`));
        if (graph?.root) {
          summary.ready_work = scoreWork(graph, await store.index()).map(({ projected_state, ...work }) => work);
          summary.quota_score_correction = { corrected_at: report.created_at, excluded_attempts: report.attempts.length, report: join(directory, 'report.json') };
          await mkdir(directory, { recursive: true });
          await writeFile(join(directory, 'last-run.before.json'), await readFile(join(runs, 'last-run.json'), 'utf8'), { flag: 'wx' });
          await save(join(runs, 'last-run.json'), summary);
        }
      }
    }
    await mkdir(directory, { recursive: true });
    await save(join(directory, 'report.json'), report);
    return { ...report, report_path: join(directory, 'report.json') };
  } finally { release(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { runs: { type: 'string', default: '.runs' }, apply: { type: 'boolean', default: false } } });
  repairQuotaAttempts(values.runs, values).then(report => console.log(JSON.stringify({
    applied: report.applied, excluded_attempts: report.attempts.length, affected_theorems: report.jobs.length,
    already_excluded: report.already_excluded.length, skipped: report.skipped.length, report: report.report_path,
  }, null, 2))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
