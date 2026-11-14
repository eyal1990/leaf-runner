import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { JobStore } from '../job-store.mjs';
import { appendEvent, reduceHistory, validHistory } from '../attempt-history.mjs';
import { scoreWork } from '../work-policy.mjs';
import { repairQuotaAttempts } from '../scripts/repair-quota-attempts.mjs';
import { digest } from '../runner-state.mjs';

const quota = JSON.stringify({ type: 'turn.failed', error: { message: 'You’ve hit your usage limit. Try again at 1:31 PM.' } }) + '\n';
const exclusion = (attempt, attempt_id) => ({ event_id: `quota-exclusion:${attempt}`, event_type: 'attempt_exclusion',
  attempt, attempt_id, reason: 'codex_quota', evidence: { log: `codex-${attempt}.log`, source_hash: digest(quota) } });
function attempt(state, n, result, category) {
  appendEvent(state, { event_type: 'attempt', event_id: `${n}:start`, attempt: n, attempt_id: `attempt-${n}`,
    context_id: 'initial', result: 'started', model: 'gpt-6-luna' });
  appendEvent(state, { event_type: 'attempt', event_id: `${n}:outcome`, attempt: n, attempt_id: `attempt-${n}`,
    context_id: 'initial', result, failure: category ? { origin: 'model', category } : undefined });
}

test('explicit quota exclusions remove structured and legacy attempts from scores while preserving their identities', () => {
  const state = { history: [], legacy_baseline: { attempts: 2, context_id: 'initial' }, context_id: 'initial',
    attempt_count: 4, status: 'READY', job_status: 'READY' };
  attempt(state, 3, 'rejected', 'unknown'); attempt(state, 4, 'rejected', 'compile_error');
  appendEvent(state, exclusion(1)); appendEvent(state, exclusion(3, 'attempt-3'));
  assert.equal(validHistory(state), true);
  const reduced = reduceHistory(state);
  assert.equal(reduced.totalAttempts, 2); assert.equal(reduced.attemptsInCurrentContext, 2);
  assert.equal(reduced.latestFailure.category, 'compile_error');
  assert.equal(state.attempt_count, 4);
  const leaf = { theorem_id: 'leaf', theorem_name: 'Leaf', status: 'Open' };
  const scored = scoreWork({ root: { theorem_id: 'root', status: 'Open' }, leaves: [leaf] }, new Map([['leaf', state]]))[0];
  assert.equal(scored.score, -22);
  assert.equal(validHistory({ ...state, history: [...state.history, { ...exclusion(3, 'attempt-3'), event_id: 'duplicate', sequence: state.history.length + 1 }] }), false);
});

test('an accepted attempt cannot be excluded and an excluded quota outcome is not repair feedback', () => {
  const state = { history: [], legacy_baseline: { attempts: 0, context_id: 'initial' }, context_id: 'initial', attempt_count: 1 };
  attempt(state, 1, 'proof_accepted'); appendEvent(state, exclusion(1, 'attempt-1'));
  assert.equal(validHistory(state), false);
  const failed = { ...state, history: [] };
  attempt(failed, 1, 'rejected', 'unknown'); appendEvent(failed, exclusion(1, 'attempt-1'));
  assert.equal(validHistory(failed), true); assert.equal(reduceHistory(failed).totalAttempts, 0);
  assert.equal(reduceHistory(failed).latestFailure, undefined);
});

test('quota repair audits first, backs up and corrects canonical scores, and is idempotent', async t => {
  const runs = await mkdtemp(join(tmpdir(), 'prove2me-quota-repair-'));
  t.after(() => rm(runs, { recursive: true, force: true }));
  const store = new JobStore(runs);
  const modern = await store.ensure('modern');
  attempt(modern, 1, 'rejected', 'unknown'); attempt(modern, 2, 'rejected', 'compile_error');
  Object.assign(modern, { attempt_count: 2, attempts_used_in_job: 2, job_status: 'READY', status: 'READY' });
  assert.equal(await store.replace(modern, modern.revision), true);
  await writeFile(join(runs, 'modern', 'codex-1.log'), quota);
  // The later failed proof read an earlier quota message as data. Its real
  // mathematical failure must still count, even though that phrase is present.
  await writeFile(join(runs, 'modern', 'codex-2.log'), JSON.stringify({ type: 'item.completed', item: { text: quota } }) + '\n' +
    JSON.stringify({ type: 'turn.completed', usage: {} }) + '\n');
  const legacy = await store.ensure('legacy');
  Object.assign(legacy, { attempt_count: 2, legacy_baseline: { attempts: 2, context_id: 'initial' }, job_status: 'READY', status: 'UNRESOLVED' });
  assert.equal(await store.replace(legacy, legacy.revision), true);
  await writeFile(join(runs, 'legacy', 'codex-1.log'), 'ERROR: You’ve hit your usage limit.\ntokens used\n33,704\n');
  const original = await readFile(store.path('modern'), 'utf8');
  const audit = await repairQuotaAttempts(runs);
  assert.equal(audit.attempts.length, 2); assert.equal(audit.applied, false);
  assert.equal(await readFile(store.path('modern'), 'utf8'), original);
  const applied = await repairQuotaAttempts(runs, { apply: true });
  assert.equal(applied.attempts.length, 2); assert.equal(applied.jobs.length, 2);
  assert.equal(reduceHistory(await store.read('modern')).totalAttempts, 1);
  assert.equal(reduceHistory(await store.read('legacy')).totalAttempts, 1);
  assert.equal((await store.read('modern')).attempt_count, 2, 'raw IDs remain monotonic');
  const backup = applied.report_path.replace(/report\.json$/, 'modern.state.before.json');
  assert.equal(await readFile(backup, 'utf8'), original);
  const corrected = await readFile(store.path('modern'), 'utf8');
  const again = await repairQuotaAttempts(runs, { apply: true });
  assert.equal(again.attempts.length, 0); assert.equal(again.already_excluded.length, 2);
  assert.equal(await readFile(store.path('modern'), 'utf8'), corrected);
});
