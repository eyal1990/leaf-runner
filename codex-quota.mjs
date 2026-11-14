import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { save, readJson, progress } from './runner-state.mjs';
import { JobPersistenceError } from './job-store.mjs';

export const QUOTA_CHECK_INTERVAL = 60 * 60 * 1000;
const RESET_GRACE = 30 * 1000;
const quotaCode = value => typeof value === 'string' &&
  /^(usage_limit_exceeded|usage_limit_reached|UsageLimitExceeded|usageLimitExceeded|insufficient_quota)$/.test(value);
const quotaMessage = value => typeof value === 'string' &&
  /\b(?:you(?:'ve| have) (?:hit|reached) your usage limit|usage limit (?:has been )?(?:reached|exceeded)|weekly (?:usage )?limit (?:reached|exceeded)|(?:5|five)[ -]hour (?:usage )?limit (?:reached|exceeded))\b/i
    .test(value.replace(/[\u2018\u2019\u02bc\uff07]/g, "'"));

export class CodexQuotaError extends Error {
  constructor(message, details = {}) { super(message); this.name = 'CodexQuotaError'; this.code = 'CODEX_QUOTA'; Object.assign(this, details); }
}
export const isCodexQuotaError = error => error instanceof CodexQuotaError || error?.code === 'CODEX_QUOTA';

// Inspect only error events, never model prose or tool output mentioning limits.
export async function codexQuotaFailure(error, log) {
  if (isCodexQuotaError(error)) return error;
  let content;
  try { content = await readFile(log, 'utf8'); }
  catch (failure) { if (failure.code === 'ENOENT') return error; throw failure; }
  return quotaFailureFromLog(content, log) ?? error;
}

export function quotaFailureFromLog(content, log) {
  let threadId, failure = null;
  for (const line of content.split(/\r?\n/)) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type === 'thread.started') threadId = event.thread_id;
    if (event.type === 'turn.completed') { failure = null; continue; }
    if (!['error', 'turn.failed'].includes(event.type)) continue;
    const detail = event.error ?? event;
    if (event.type === 'turn.failed') failure = null;
    if (quotaCode(detail.code) || quotaCode(detail.type) || quotaCode(detail.codexErrorInfo) || quotaMessage(detail.message)) {
      failure = new CodexQuotaError(detail.message ?? 'Codex usage quota exhausted', {
        thread_id: threadId, resets_at: detail.resets_at ?? detail.resetsAt, log,
      });
    }
  }
  // Older executable overrides can emit plain terminal errors instead of JSONL.
  // The older text CLI prints a token-count footer after its terminal error.
  const lastLine = content.trim().replace(/\r?\ntokens used\r?\n[\d,]+\s*$/, '').trim().split(/\r?\n/).at(-1);
  if (/^(?:ERROR:|Error:)\s*/.test(lastLine)) {
    return quotaMessage(lastLine) ? new CodexQuotaError(lastLine, { thread_id: threadId, log }) : null;
  }
  return failure;
}

// A short-lived, read-only App Server connection. No thread, turn, credit
// redemption, or model request is created. Never expose auth data or stderr.
export async function readCodexRateLimits(options, { executable, env, spawnProcess = spawn, timeout = 30000 }) {
  const prefix = await executable(options.codex ?? 'codex');
  options.signal?.throwIfAborted();
  const child = spawnProcess(prefix[0], [...prefix.slice(1), 'app-server'], {
    env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines = createInterface({ input: child.stdout });
  child.stderr.resume();
  let timer, abort, closed = false;
  const exited = new Promise(resolve => child.once('close', () => { closed = true; resolve(); }));
  try {
    return await new Promise((resolve, reject) => {
      const send = value => child.stdin.write(JSON.stringify(value) + '\n');
      abort = () => reject(options.signal.reason ?? new Error('Codex quota check cancelled'));
      options.signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => reject(new Error('Codex quota check timed out')), timeout);
      child.once('error', reject);
      child.once('close', () => reject(new Error('Codex quota check exited before responding')));
      child.stdin.on('error', reject);
      lines.on('line', line => {
        let message;
        try { message = JSON.parse(line); } catch { return; }
        if (![1, 2].includes(message.id)) return;
        if (message.error) { reject(new Error(`Codex quota read failed (RPC ${message.error.code ?? 'error'})`)); return; }
        if (message.id === 1) {
          send({ method: 'initialized', params: {} });
          send({ id: 2, method: 'account/rateLimits/read', params: {} });
        } else resolve(message.result);
      });
      send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'prove2me_runner', version: '1.0.0' } } });
      if (options.signal?.aborted) abort();
    });
  } finally {
    clearTimeout(timer); options.signal?.removeEventListener('abort', abort); lines.close();
    child.stdin.destroy();
    if (!closed && process.platform === 'win32' && child.pid) {
      // The pinned Windows CLI is a Node launcher with a native child. Terminate
      // only this connection's tree, as with the proof command supervisor.
      await new Promise(resolve => {
        const killer = spawnProcess(join(process.env.SystemRoot ?? 'C:/Windows', 'System32/taskkill.exe'),
          ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.once('error', () => { child.kill(); resolve(); });
        killer.once('exit', () => { child.kill(); resolve(); });
      });
    } else if (!closed) child.kill();
    await exited;
  }
}

function resetTime(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value * 1000;
  return typeof value === 'string' ? Date.parse(value) || null : null;
}
export function quotaSnapshot(response) {
  if (!response || typeof response !== 'object' || !response.rateLimits) throw new Error('Codex quota response is unavailable');
  // The codex bucket is shared by ordinary proof calls; retain the legacy view
  // for older CLIs. Other model-specific buckets must not block this bucket.
  const bucket = response.rateLimitsByLimitId?.codex ?? response.rateLimits;
  const windows = [bucket.primary, bucket.secondary].filter(Boolean);
  const exhausted = windows.filter(w => w.usedPercent >= 100);
  const resets = exhausted.map(w => resetTime(w.resetsAt)).filter(Boolean);
  const blocked = response.ordinaryUsageAllowed === false || bucket.spendControlReached === true ||
    !!bucket.rateLimitReachedType || exhausted.length > 0;
  return { blocked, resetsAt: resets.length ? Math.max(...resets) : null,
    windows: Object.fromEntries(['primary', 'secondary'].filter(key => bucket[key]).map(key => [key, {
      used_percent: bucket[key].usedPercent, window_minutes: bucket[key].windowDurationMins,
      resets_at: resetTime(bucket[key].resetsAt), exhausted: bucket[key].usedPercent >= 100,
    }])),
    // Null/absent permission is unknown, including when percentages look low.
    allowed: response.ordinaryUsageAllowed === true && !blocked };
}

export class CodexQuota {
  constructor(runs, { readLimits, now = Date.now, signal } = {}) {
    this.path = join(runs, 'codex-quota.json'); this.readLimits = readLimits;
    this.now = now; this.signal = signal; this.state = null; this.version = 0;
  }
  async load() {
    this.state = await readJson(this.path);
    if (this.state && (!['WAITING', 'PROBING', 'OPEN'].includes(this.state.status) ||
        !Number.isFinite(this.state.next_check_at))) throw new Error('Invalid saved Codex quota state');
    // A restart may follow an early quota reset. Recheck every saved pause now,
    // keeping dispatch blocked until fresh limits permit a single recovery probe.
    if (this.paused) {
      this.state.status = 'WAITING'; this.state.next_check_at = Math.min(this.state.next_check_at, this.now());
    }
  }
  get paused() { return !!this.state && this.state.status !== 'OPEN'; }
  get waiting() { return this.state?.status === 'WAITING'; }
  get nextCheckAt() { return this.waiting ? this.state.next_check_at : Infinity; }
  get probeToken() { return this.state?.status === 'PROBING' ? this.version : null; }
  async persist() {
    try { await save(this.path, this.state); }
    catch (error) { throw new JobPersistenceError(`Cannot persist Codex quota state: ${error.message}`, { cause: error }); }
  }
  schedule(reset) {
    const now = this.now();
    return Math.min(now + QUOTA_CHECK_INTERVAL, reset && reset + RESET_GRACE > now ? reset + RESET_GRACE : Infinity);
  }
  async block(error) {
    this.version++;
    const first = !this.state || this.state.status === 'OPEN';
    const reset = resetTime(error.resets_at);
    const next = this.schedule(reset);
    this.state = { status: 'WAITING', paused_at: !first && this.state?.paused_at || new Date(this.now()).toISOString(),
      reason: error.message, resets_at: reset, next_check_at: first ? this.now() : Math.min(this.nextCheckAt, next),
      probe_not_before: this.now() + QUOTA_CHECK_INTERVAL,
      last_check_error: null };
    await this.persist();
    progress(this.describe());
  }
  describe() {
    if (!this.paused) return '';
    const usage = Object.values(this.state.windows ?? {}).flatMap(window => {
      const name = window.window_minutes === 300 ? 'five-hour' : window.window_minutes === 10080 ? 'weekly' : null;
      return name ? [`${name} ${window.used_percent}%${window.exhausted ? ' (exhausted)' : ''}`] : [];
    }).join('; ');
    return this.waiting ? `Codex quota exhausted; next availability check ${new Date(this.state.next_check_at).toISOString()} (checks at least hourly)${usage ? `; ${usage}` : ''}`
      : 'Codex quota recovery: allowing one saved invocation before reopening the queue';
  }
  async check() {
    if (!this.waiting || this.now() < this.nextCheckAt) return;
    const version = this.version;
    let snapshot, failure;
    try {
      if (!this.readLimits) throw new Error('Codex quota reader is unavailable');
      snapshot = quotaSnapshot(await this.readLimits());
    } catch (error) { this.signal?.throwIfAborted(); failure = error; }
    // A concurrent invocation may have reported a newer limit during the read.
    if (version !== this.version) return;
    const now = this.now();
    this.state.last_checked_at = new Date(now).toISOString();
    this.state.last_check_error = failure?.message ?? null;
    if (snapshot) this.state.windows = snapshot.windows;
    if (snapshot && !snapshot.blocked && (snapshot.allowed || now >= (this.state.probe_not_before ?? 0))) {
      // Even an explicit recovery starts one invocation first. Unknown permission
      // is tested by that pending operation, never inferred from percentages.
      this.state.status = 'PROBING';
      this.state.next_check_at = now + QUOTA_CHECK_INTERVAL;
    } else {
      this.state.resets_at = snapshot?.resetsAt ?? this.state.resets_at;
      this.state.next_check_at = this.schedule(this.state.resets_at);
    }
    await this.persist();
    progress(`Codex quota checked: ${this.describe()}${failure ? `; ${failure.message}` : ''}`);
  }
  async inconclusive(token, error) {
    if (token === null || token !== this.version || this.state?.status !== 'PROBING') return;
    this.version++; this.state.status = 'WAITING';
    this.state.last_check_error = error.message;
    this.state.next_check_at = this.now() + QUOTA_CHECK_INTERVAL;
    await this.persist();
  }
  async succeeded(token) {
    if (token === null || token !== this.version || this.state?.status !== 'PROBING') return;
    this.version++; this.state = { status: 'OPEN', next_check_at: 0, resumed_at: new Date(this.now()).toISOString() };
    await this.persist(); progress('Codex quota recovered; resuming queued jobs');
  }
}
