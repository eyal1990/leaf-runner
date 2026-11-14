import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { readJson, save } from './runner-state.mjs';
import { recoveryPolicy, retryDelay } from './recovery-policy.mjs';
import { ApiError, transientReadError } from './api-errors.mjs';
import { JobPersistenceError } from './job-store.mjs';

// One shared gate per client. Only the probe touches the API during an outage;
// mathematical jobs and their attempt counters are unaffected.
export class ApiRecovery {
  constructor(client, options = {}) {
    this.client = client; this.policy = recoveryPolicy(options);
    this.path = options.runs && join(options.runs, 'api-recovery.json');
    this.now = options.now ?? Date.now;
    this.wait = options.wait ?? ((ms, signal) => delay(ms, undefined, { signal }));
    this.loadCredentials = options.loadCredentials;
    this.state = null;
    this.generation = 0;
    this.loaded = this.path ? readJson(this.path).then(state => {
      if (state && (typeof state.waiting !== 'boolean' || !Number.isSafeInteger(state.failures) ||
          state.failures < 0 || state.waiting && !Number.isFinite(state.next_check_at))) {
        throw new JobPersistenceError('Invalid shared API recovery record');
      }
      this.state = state;
    }).catch(error => { throw new JobPersistenceError(`Cannot load shared API recovery: ${error.message}`); }) : Promise.resolve();
  }
  async persist() {
    try { if (this.path) await save(this.path, this.state); }
    catch (error) { throw new JobPersistenceError(`Cannot persist shared API recovery: ${error.message}`); }
  }
  async block(error) {
    if (this.state?.waiting) return;
    const count = (this.state?.failures ?? 0) + 1;
    const blocked = { waiting: true, failures: count, status: error.status ?? error.name,
      next_check_at: this.now() + Math.max(error.retryAfterMs ?? 0, retryDelay(count, this.policy)) };
    this.state = blocked;
    await this.persist();
    this.client.report(`API recovery: shared wait (${blocked.status}); next check ${new Date(blocked.next_check_at).toISOString()}`);
  }
  async gate() {
    await this.loaded;
    if (!this.state?.waiting) return;
    if (!this.probing) {
      this.probing = (async () => {
        while (this.state?.waiting) {
          this.client.signal?.throwIfAborted();
          // Short cancellable waits also notice a replacement credentials file.
          while (this.state.next_check_at > this.now()) {
            await this.wait(Math.min(30000, this.state.next_check_at - this.now()), this.client.signal);
            if (this.loadCredentials) {
              const key = await this.loadCredentials();
              if (key && key !== this.client.key) { this.client.key = key; this.client.token = null; break; }
            }
          }
          try {
            if (this.loadCredentials) {
              const key = await this.loadCredentials();
              if (key && key !== this.client.key) { this.client.key = key; this.client.token = null; }
            }
            this.client.expiry = 0;
            await this.client.requestOnce('environments');
            this.state = { waiting: false, failures: 0, recovered_at: new Date(this.now()).toISOString() };
            this.generation++;
            await this.persist(); this.client.report('API recovery: service available; resuming saved operations');
          } catch (error) {
            this.client.signal?.throwIfAborted();
            if (!(error instanceof ApiError) && !transientReadError(error)) throw error;
            this.state.waiting = false; await this.block(error);
          }
        }
      })().finally(() => { this.probing = null; });
    }
    await this.probing;
  }
  async request(path, options) {
    for (;;) {
      options.signal?.throwIfAborted();
      // Cancelling an advisory lookup must not cancel another job's shared
      // recovery probe, or leave a proof invocation waiting for that probe.
      let abort;
      try {
        if (options.signal) await Promise.race([this.gate(), new Promise((_, reject) => {
          abort = () => reject(options.signal.reason);
          options.signal.addEventListener('abort', abort, { once: true });
          if (options.signal.aborted) abort();
        })]);
        else await this.gate();
      } finally { if (abort) options.signal.removeEventListener('abort', abort); }
      options.signal?.throwIfAborted();
      const generation = this.generation;
      try { return await this.client.requestOnce(path, options); }
      catch (error) {
        options.signal?.throwIfAborted();
        this.client.signal?.throwIfAborted();
        if (generation !== this.generation && ((options.method ?? 'GET').toUpperCase() === 'GET' ||
            error instanceof ApiError && [401, 403, 429].includes(error.status))) continue;
        if (error instanceof ApiError && error.status === 403) {
          if (new URL(path, 'https://prove2.me/api/v1/').pathname === '/api/v1/environments') {
            await this.block(error); continue;
          }
          // A healthy account probe distinguishes one inaccessible declaration
          // from an account-wide permission/authentication failure.
          try { await this.client.requestOnce('environments'); error.resourceAccess = true; }
          catch (probe) {
            if (!(probe instanceof ApiError) && !transientReadError(probe)) throw probe;
            await this.block(probe);
          }
          if (error.resourceAccess) throw error;
        } else if (error instanceof ApiError && [401, 429, 500, 502, 503, 504].includes(error.status) || transientReadError(error)) {
          await this.block(error);
        } else throw error;
        // Known HTTP rejections may be retried with the same body. Lost POST
        // responses belong to the durable reconciliation path, never this gate.
        if ((options.method ?? 'GET').toUpperCase() !== 'GET' &&
            !(error instanceof ApiError && [401, 403, 429].includes(error.status))) throw error;
      }
    }
  }
}
