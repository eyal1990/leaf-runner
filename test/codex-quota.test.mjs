import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexQuota, CodexQuotaError, codexQuotaFailure, readCodexRateLimits, QUOTA_CHECK_INTERVAL as HOUR } from '../codex-quota.mjs';

async function fixture(t) {
  const runs = await mkdtemp(join(tmpdir(), 'prove2me-quota-'));
  t.after(() => rm(runs, { recursive: true, force: true }));
  t.mock.method(console, 'log', () => {});
  return runs;
}
const response = (used, reset, extra = {}) => ({ ordinaryUsageAllowed: used < 100,
  rateLimits: { primary: { usedPercent: used, resetsAt: reset / 1000 }, secondary: null }, ...extra });

test('quota detection accepts error events while excluding auth, transient 429s, model prose and tool output', async t => {
  const runs = await fixture(t), log = join(runs, 'codex.log'), original = new Error('exited with 1');
  for (const event of [
    { type: 'item.completed', item: { text: "You've hit your usage limit" } },
    { type: 'error', message: 'HTTP 429: rate limit reached; retry in 1s' },
    { type: 'turn.failed', error: { message: 'Unauthorized: please log in' } },
  ]) {
    await writeFile(log, JSON.stringify(event));
    assert.equal(await codexQuotaFailure(original, log), original);
  }
  for (const detail of [
    { message: "You've hit your usage limit. Try again tomorrow." },
    { message: 'You’ve hit your usage limit. Try again at 1:31 PM.' },
    { code: 'usage_limit_reached', message: 'Unavailable', resets_at: 1900000000 },
    { codexErrorInfo: 'UsageLimitExceeded', message: 'Unavailable' },
  ]) {
    await writeFile(log, JSON.stringify({ type: 'thread.started', thread_id: 'session' }) + '\n' +
      JSON.stringify({ type: 'turn.failed', error: detail }));
    const error = await codexQuotaFailure(original, log);
    assert.ok(error instanceof CodexQuotaError); assert.equal(error.thread_id, 'session');
  }
  await writeFile(log, 'ERROR: You have reached your usage limit.');
  assert.ok(await codexQuotaFailure(original, log) instanceof CodexQuotaError);
  await writeFile(log, 'ERROR: You’ve hit your usage limit.\ntokens used\n33,704\n');
  assert.ok(await codexQuotaFailure(original, log) instanceof CodexQuotaError);
  await writeFile(log, JSON.stringify({ type: 'error', message: 'You’ve hit your usage limit.' }) + '\n' +
    JSON.stringify({ type: 'turn.completed', usage: {} }));
  assert.equal(await codexQuotaFailure(original, log), original, 'a successful later turn is not a quota failure');
});

test('hourly reads detect an early reset, and one successful probe reopens the queue', async t => {
  const runs = await fixture(t); let now = 1800000000000, reads = 0, reset = false;
  const quota = new CodexQuota(runs, { now: () => now, readLimits: async () => {
    reads++; return response(reset ? 0 : 100, now + 7 * 24 * HOUR);
  } });
  await quota.load(); await quota.block(new CodexQuotaError('weekly limit'));
  assert.equal(quota.nextCheckAt, now, 'read the reset timestamp immediately');
  await quota.check(); assert.equal(reads, 1); assert.equal(quota.nextCheckAt, now + HOUR);
  now += HOUR - 1; await quota.check(); assert.equal(reads, 1);
  reset = true; now++; await quota.check(); assert.equal(reads, 2);
  assert.equal(quota.state.status, 'PROBING');
  await quota.succeeded(null); assert.equal(quota.paused, true, 'a pre-limit invocation cannot reopen the queue');
  await quota.succeeded(quota.probeToken); assert.equal(quota.paused, false);
  assert.equal(JSON.parse(await readFile(quota.path, 'utf8')).status, 'OPEN');
});

test('the later exhausted window controls the reset, while hourly checks remain scheduled', async t => {
  const runs = await fixture(t); let now = 1800000000000;
  const short = now + 10 * 60000, weekly = now + 30 * 60000;
  const quota = new CodexQuota(runs, { now: () => now, readLimits: async () => ({
    ordinaryUsageAllowed: false,
    rateLimits: { primary: { usedPercent: 100, resetsAt: short / 1000 }, secondary: { usedPercent: 100, resetsAt: weekly / 1000 } },
  }) });
  await quota.block(new CodexQuotaError('limits')); await quota.check();
  assert.equal(quota.state.resets_at, weekly); assert.equal(quota.nextCheckAt, weekly + 30000);
  now = weekly + 30000; await quota.check();
  assert.equal(quota.nextCheckAt, now + HOUR, 'expired timestamps do not cause a busy retry loop');
});

test('weekly exhaustion is reported separately from the five-hour allowance', async t => {
  const runs = await fixture(t), now = 1800000000000;
  const quota = new CodexQuota(runs, { now: () => now, readLimits: async () => ({ ordinaryUsageAllowed: false,
    rateLimits: { primary: { usedPercent: 37, windowDurationMins: 300, resetsAt: (now + HOUR) / 1000 },
      secondary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: (now + 24 * HOUR) / 1000 } },
  }) });
  await quota.block(new CodexQuotaError('usage limit')); await quota.check();
  assert.match(quota.describe(), /five-hour 37%; weekly 100% \(exhausted\)/);
  assert.equal(quota.state.windows.primary.exhausted, false);
  assert.equal(quota.state.windows.secondary.exhausted, true);
  assert.equal(JSON.parse(await readFile(quota.path, 'utf8')).windows.secondary.used_percent, 100);
});

test('unknown permission and failed reads cannot unlock all workers; failures retry hourly', async t => {
  const runs = await fixture(t); let now = 1800000000000, fail = true;
  const quota = new CodexQuota(runs, { now: () => now, readLimits: async () => {
    if (fail) throw new Error('offline');
    return response(0, now, { ordinaryUsageAllowed: null });
  } });
  await quota.block(new CodexQuotaError('limit')); await quota.check();
  assert.equal(quota.waiting, true); assert.equal(quota.nextCheckAt, now + HOUR);
  fail = false; now += HOUR; await quota.check();
  assert.equal(quota.state.status, 'PROBING', 'unknown permission permits only one actual recovery check');
  await quota.inconclusive(quota.probeToken, new Error('network error'));
  assert.equal(quota.waiting, true); assert.equal(quota.nextCheckAt, now + HOUR);
});

test('unknown permission cannot immediately retry a just-rejected invocation even if percentages look low', async t => {
  const runs = await fixture(t); let now = 1800000000000;
  const quota = new CodexQuota(runs, { now: () => now,
    readLimits: async () => response(0, now, { ordinaryUsageAllowed: null }) });
  await quota.block(new CodexQuotaError('You’ve hit your usage limit.'));
  await quota.check();
  assert.equal(quota.waiting, true); assert.equal(quota.probeToken, null);
  now += HOUR; await quota.check();
  assert.equal(quota.state.status, 'PROBING');
});

test('restart immediately rechecks a saved pause and recovers before its previous deadline', async t => {
  const runs = await fixture(t); const now = 1800000000000;
  const quota = new CodexQuota(runs, { now: () => now, readLimits: async () => response(100, now + 7 * 24 * HOUR) });
  await quota.block(new CodexQuotaError('limit')); await quota.check();
  assert.equal(quota.nextCheckAt, now + HOUR);
  let reads = 0;
  const restarted = new CodexQuota(runs, { now: () => now + 1000, readLimits: async () => {
    reads++; return response(0, now + HOUR);
  } });
  await restarted.load();
  assert.equal(restarted.waiting, true);
  assert.equal(restarted.nextCheckAt, now + 1000);
  await restarted.check(); assert.equal(reads, 1);
  assert.equal(restarted.state.status, 'PROBING');
  await restarted.succeeded(restarted.probeToken);
  assert.equal(restarted.paused, false);
});

test('restart keeps dispatch paused when fresh limits are exhausted or unavailable', async t => {
  const runs = await fixture(t); const now = 1800000000000;
  const quota = new CodexQuota(runs, { now: () => now });
  await quota.block(new CodexQuotaError('limit'));
  quota.state.next_check_at = now + HOUR; await quota.persist();
  for (const fail of [false, true]) {
    let reads = 0;
    const restarted = new CodexQuota(runs, { now: () => now + 1000, readLimits: async () => {
      reads++;
      if (fail) throw new Error('offline');
      return response(100, now + 7 * 24 * HOUR);
    } });
    await restarted.load(); await restarted.check();
    assert.equal(reads, 1); assert.equal(restarted.waiting, true);
    assert.equal(restarted.nextCheckAt, now + 1000 + HOUR);
    assert.equal(restarted.state.last_check_error, fail ? 'offline' : null);
    await restarted.check(); assert.equal(reads, 1, 'normal polling resumes after the startup check');
  }
});

test('restart rechecks a crashed recovery probe and leaves an open queue open', async t => {
  const runs = await fixture(t); const now = 1800000000000;
  const quota = new CodexQuota(runs, { now: () => now, readLimits: async () => response(0, now) });
  await quota.block(new CodexQuotaError('limit')); await quota.check();
  assert.equal(quota.state.status, 'PROBING');
  const restarted = new CodexQuota(runs, { now: () => now + 1000, readLimits: async () => response(0, now) });
  await restarted.load();
  assert.equal(restarted.waiting, true); assert.equal(restarted.nextCheckAt, now + 1000);
  await restarted.check(); await restarted.succeeded(restarted.probeToken);
  await restarted.load();
  assert.equal(restarted.paused, false); assert.equal(restarted.nextCheckAt, Infinity);
});

test('a newer quota failure wins over an in-flight availability read and stale probe completion', async t => {
  const runs = await fixture(t); let release;
  const quota = new CodexQuota(runs, { readLimits: () => new Promise(resolve => { release = resolve; }) });
  await quota.block(new CodexQuotaError('first'));
  const checking = quota.check();
  await quota.block(new CodexQuotaError('newer'));
  release(response(0, Date.now())); await checking;
  assert.equal(quota.waiting, true); assert.equal(quota.state.reason, 'newer');
});

test('App Server quota reader uses initialization and account read only, and drains its child', async t => {
  const runs = await fixture(t), script = join(runs, 'fake-server.mjs'), calls = join(runs, 'calls.jsonl');
  await writeFile(script, `
    import { createInterface } from 'node:readline';
    import { appendFileSync } from 'node:fs';
    createInterface({ input: process.stdin }).on('line', line => {
      const m = JSON.parse(line); appendFileSync(${JSON.stringify(calls)}, line + '\\n');
      if (m.method === 'initialize') console.log(JSON.stringify({ id: m.id, result: {} }));
      else if (m.method === 'account/rateLimits/read') console.log(JSON.stringify({ id: m.id, result: { rateLimits: {}, ordinaryUsageAllowed: true } }));
      else if (m.method !== 'initialized') process.exit(2);
    });
  `);
  const value = await readCodexRateLimits({}, { executable: async () => [process.execPath, script], env: process.env });
  assert.equal(value.ordinaryUsageAllowed, true);
  const methods = (await readFile(calls, 'utf8')).trim().split('\n').map(line => JSON.parse(line).method);
  assert.deepEqual(methods, ['initialize', 'initialized', 'account/rateLimits/read']);
});

test('App Server availability reads can time out and be cancelled', async t => {
  const runs = await fixture(t), script = join(runs, 'silent.mjs');
  await writeFile(script, 'process.stdin.resume(); setInterval(() => {}, 1000);');
  const dependencies = { executable: async () => [process.execPath, script], env: process.env, timeout: 100 };
  await assert.rejects(readCodexRateLimits({}, dependencies), /timed out/);
  const controller = new AbortController();
  const reading = readCodexRateLimits({ signal: controller.signal }, { ...dependencies, timeout: 10000 });
  setTimeout(() => controller.abort(new Error('stop quota check')), 100);
  await assert.rejects(reading, /stop quota check/);
});
