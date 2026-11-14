import { randomUUID } from 'node:crypto';
import { readdir, writeFile } from 'node:fs/promises';
import { join, resolve, relative, sep } from 'node:path';
import { save, readJson, onRecordSaved } from './runner-state.mjs';
import { verificationMode } from './verification-mode.mjs';
import { historyState, observeContext, appendEvent, validHistory } from './attempt-history.mjs';
import { selectWork } from './work-policy.mjs';

export const JOB_SCHEMA = 2;
export class JobPersistenceError extends Error {}
export const remoteStatuses = new Set(['SUBMITTING', 'SUBMISSION_UNKNOWN', 'PENDING', 'PUBLISHING',
  'PUBLISH_PENDING', 'PUBLISH_UNKNOWN', 'PUBLICATIONS_READY', 'PREPARED', 'COUNTEREXAMPLE']);
const completed = new Set(['ACCEPTED', 'SKETCH_ACCEPTED', 'DISPROVED']);
const writers = new Map(), executing = new Set();
const indexes = new Map();
function freezeRecord(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeRecord(child);
    Object.freeze(value);
  }
  return value;
}
onRecordSaved((path, bytes) => {
  for (const [runs, cache] of indexes) {
    const parts = relative(runs, path).split(sep);
    if (parts.length !== 2 || parts[1] !== 'state.json' || !/^[A-Za-z0-9_-]+$/.test(parts[0])) continue;
    const state = freezeRecord(JSON.parse(bytes));
    if (cache.jobs) cache.jobs.set(parts[0], state);
    else cache.changes.set(parts[0], state);
  }
});

// One writer per run directory, shared even by independently constructed stores.
export function transaction(runs, action) {
  const key = resolve(runs);
  const result = (writers.get(key) ?? Promise.resolve()).then(action);
  const settled = result.catch(() => {});
  writers.set(key, settled);
  void settled.then(() => { if (writers.get(key) === settled) writers.delete(key); });
  return result;
}

export async function readRecord(path) {
  return readJson(path);
}

export class JobStore {
  constructor(runs, { cacheIndex = false } = {}) {
    this.runs = resolve(runs);
    // Only the exclusive runner opts in. Dashboard/read-only stores stay fresh.
    if (cacheIndex && !indexes.has(this.runs)) indexes.set(this.runs, { changes: new Map() });
  }
  releaseIndex() { indexes.delete(this.runs); }
  path(id) {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('Invalid theorem job ID');
    return join(this.runs, id, 'state.json');
  }
  async read(id) {
    const state = await readRecord(this.path(id));
    if (state && state.theorem_id !== id) throw new Error('Saved state identity mismatch');
    if (state?.schema_version !== undefined) {
      if (![1, JOB_SCHEMA].includes(state.schema_version) || !Number.isSafeInteger(state.revision) || state.revision < 0 ||
          !Number.isSafeInteger(state.attempt_budget) || state.attempt_budget < 0 ||
          !Number.isSafeInteger(state.attempts_used_in_job) || state.attempts_used_in_job < 0 ||
          !state.job_id ||
          state.verification_mode !== undefined && !['local', 'server-only'].includes(state.verification_mode) ||
          !Number.isSafeInteger(state.attempt_count) || state.attempt_count < state.attempts_used_in_job ||
          !['ACTIVE', 'READY', 'DONE', 'UNRESOLVED', 'RETIRED', 'NEEDS_ATTENTION'].includes(state.job_status) ||
          !['PREPARE', 'CODEX', 'VALIDATE', 'SERVER'].includes(state.stage) ||
          !['QUEUED', 'RUNNING', 'HANDOFF_PENDING', 'DELAYED'].includes(state.dispatch_state) ||
          state.dispatch_state === 'HANDOFF_PENDING' && (!state.pending_outcome ||
            !['PREPARE', 'CODEX', 'VALIDATE', 'SERVER'].includes(state.pending_outcome.stage) ||
            !['QUEUED', 'DELAYED'].includes(state.pending_outcome.dispatch_state) ||
            typeof state.pending_outcome.operation !== 'string') ||
          state.next_poll_at !== undefined && !Number.isFinite(Date.parse(state.next_poll_at))) {
        throw new JobPersistenceError(`Invalid versioned job record: ${this.path(id)}`);
      }
    }
    if (state?.schema_version === JOB_SCHEMA && !validHistory(state)) {
      throw new JobPersistenceError(`Invalid structured job history: ${this.path(id)}`);
    }
    return state;
  }
  async index({ readOnly = false } = {}) {
    const cache = indexes.get(this.runs);
    const snapshot = jobs => readOnly ? new Map(jobs) : structuredClone(jobs);
    if (cache?.jobs) return snapshot(cache.jobs);
    if (cache?.loading) return snapshot(await cache.loading);
    const loading = this.loadIndex();
    if (!cache) return loading;
    cache.loading = loading.then(jobs => {
      for (const [id, state] of jobs) jobs.set(id, freezeRecord(state));
      for (const [id, state] of cache.changes) jobs.set(id, state);
      cache.changes.clear(); cache.jobs = jobs;
      return jobs;
    });
    try { return snapshot(await cache.loading); }
    finally { delete cache.loading; }
  }
  async loadIndex() {
    let entries;
    try { entries = await readdir(this.runs, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return new Map(); throw error; }
    const jobs = new Map();
    const candidates = entries.filter(entry => entry.isDirectory() && /^[A-Za-z0-9_-]+$/.test(entry.name));
    let next = 0;
    const results = await Promise.allSettled(Array.from({ length: 16 }, async () => {
      while (next < candidates.length) {
        const id = candidates[next++].name, state = await this.read(id);
        if (state) jobs.set(id, state);
      }
    }));
    const failed = results.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
    return jobs;
  }
  async #migrate(state) {
    if (!state || state.schema_version === JOB_SCHEMA) return state;
    const suffix = state.schema_version === undefined ? 'legacy' : `v${state.schema_version}`;
    // Backup must precede replacing the canonical record. Never guess a budget.
    try { await writeFile(`${this.path(state.theorem_id)}.${suffix}.json`, JSON.stringify(state, null, 2) + '\n', { flag: 'wx' }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    const count = state.attempt_count ?? state.attempt ?? 0;
    if (!Number.isSafeInteger(count) || count < 0) throw new Error('Invalid legacy attempt history');
    if (state.schema_version === undefined) Object.assign(state, { job_id: randomUUID(), revision: 0,
      attempt_budget: 0, attempts_used_in_job: 0, attempt_count: count, legacy_budget_unknown: true,
      attempts_by_model: state.attempts_by_model ?? (count ? { unknown: count } : {}),
      submissions: state.submissions ?? [],
      job_status: completed.has(state.status) ? 'DONE' : remoteStatuses.has(state.status) ? 'ACTIVE' : 'READY',
      stage: remoteStatuses.has(state.status) ? 'SERVER' : 'CODEX', dispatch_state: 'QUEUED' });
    Object.assign(state, historyState({ ...state, attempt_count: count }), { schema_version: JOB_SCHEMA });
    if (state.job_status === 'UNRESOLVED') state.job_status = remoteStatuses.has(state.status) ? 'ACTIVE' : 'READY';
    await save(this.path(state.theorem_id), state);
    return state;
  }
  async observeGraph(graph) {
    return transaction(this.runs, async () => {
      const nodes = new Map((graph.nodes ?? [graph.root, ...graph.leaves]).map(n => [n.theorem_id, n]));
      for (const [id, node] of nodes) {
        const old = await this.#migrate(await this.read(id));
        if (!old) continue;
        const next = observeContext(old, node, nodes, graph.snapshot_ref, graph.updated_at ?? new Date().toISOString());
        // Observation does not revoke the running action token. replace merges
        // append-only events, retaining the invocation's original awareness.
        if (JSON.stringify(next) !== JSON.stringify(old)) await save(this.path(id), next);
      }
    });
  }
  async ensure(id, { rootId = id, runId = randomUUID(), attempts = 0, graphVersion = 0, mathlibRev, model, verificationMode: mode } = {}) {
    return transaction(this.runs, async () => {
      const existing = await this.#migrate(await this.read(id));
      if (existing) return existing;
      const index = await this.index({ readOnly: true });
      const state = { schema_version: JOB_SCHEMA, theorem_id: id, job_id: randomUUID(), root_id: rootId, run_id: runId,
        revision: 0, job_status: 'ACTIVE', stage: 'PREPARE', dispatch_state: 'QUEUED', operation: 'prepare',
        history: [], context_id: 'initial', legacy_baseline: { attempts: 0, context_id: 'initial' },
        attempt_budget: attempts, attempts_used_in_job: 0, attempt_count: 0, attempts_by_model: {}, submissions: [], model_override: model ?? null,
        mathlib_rev: mathlibRev, graph_version_at_claim: graphVersion,
        verification_mode: verificationMode({ verificationMode: mode }),
        enqueue_sequence: Math.max(0, ...[...index.values()].map(job => job.enqueue_sequence ?? 0)) + 1,
        claimed_at: new Date().toISOString(), updated_at: new Date().toISOString() };
      await save(this.path(id), state);
      return state;
    });
  }
  // Eligibility check and durable creation are in the same serialized transaction.
  async claim(graph, options) {
    return transaction(this.runs, async () => {
      const index = await this.index();
      if (options.canClaim && !options.canClaim(index)) return null;
      const leaf = selectWork(graph, new Map([...index].map(([id, state]) => [id,
        options.excluded?.has(id) || executing.has(this.path(id)) ? { ...state, job_status: 'ACTIVE' } : state])), options);
      if (!leaf || graph.root.status !== 'Open' || graph.root.deprecated_at) return null;
      let state = await this.#migrate(index.get(leaf.theorem_id));
      const now = new Date().toISOString();
      if (state) {
        state = observeContext(state, leaf, new Map((graph.nodes ?? []).map(n => [n.theorem_id, n])), graph.snapshot_ref, now);
        const resume = !completed.has(state.status) && (state.candidate || state.artifact_manifest || remoteStatuses.has(state.status));
        if (resume && state.candidate && state.stage === 'CODEX') {
          state.stage = 'VALIDATE'; state.operation = 'validate';
        }
        if (!resume) {
          state.previous_candidate = state.candidate ?? state.previous_candidate;
          delete state.candidate; delete state.artifact_manifest; delete state.plan;
          delete state.submission_id; delete state.proof_type; delete state.verdict; delete state.next_poll_at;
          delete state.retirement_requested; delete state.pending_outcome;
          state.status = 'REPAIR_REQUIRED'; state.stage = 'PREPARE'; state.operation = 'prepare';
          if (state.target_fingerprint && state.relevant_snapshot.target !== state.target_fingerprint ||
              state.mathlib_rev && state.relevant_snapshot.environment !== state.mathlib_rev) {
            delete state.previous_candidate;
            state.target_fingerprint = state.relevant_snapshot.target;
            state.mathlib_rev = state.relevant_snapshot.environment;
          }
        }
        delete state.retirement_requested;
        state.job_status = 'ACTIVE'; state.dispatch_state = 'QUEUED'; state.revision++;
        state.root_id = graph.root.theorem_id; state.run_id = options.runId ?? randomUUID();
      } else {
        state = { ...historyState({}), schema_version: JOB_SCHEMA, theorem_id: leaf.theorem_id, job_id: randomUUID(),
          root_id: graph.root.theorem_id, run_id: options.runId ?? randomUUID(), revision: 0,
          job_status: 'ACTIVE', stage: 'PREPARE', dispatch_state: 'QUEUED', operation: 'prepare',
          attempt_budget: options.attempts ?? 0, attempts_used_in_job: 0, attempt_count: 0, attempts_by_model: {},
          submissions: [], model_override: options.model ?? null, verification_mode: verificationMode(options) };
        state = observeContext(state, leaf, new Map((graph.nodes ?? []).map(n => [n.theorem_id, n])), graph.snapshot_ref, now);
      }
      const { projected_state, job, ...selection } = leaf;
      state.selection = selection;
      state.graph_version_at_claim = graph.graph_version ?? 0;
      state.enqueue_sequence = Math.max(0, ...[...index.values()].map(j => j.enqueue_sequence ?? 0)) + 1;
      state.claimed_at = now; state.updated_at = now;
      await save(this.path(leaf.theorem_id), state);
      return { ...selection, job: state };
    });
  }

  async replace(state, expectedRevision, { allowRetirement = false } = {}) {
    return transaction(this.runs, async () => {
      const current = await this.read(state.theorem_id);
      if (!current || current.job_id !== state.job_id || current.revision !== expectedRevision ||
          ['RETIRED', 'DONE', 'UNRESOLVED', 'READY'].includes(current.job_status) || current.retirement_requested && !allowRetirement ||
          current.attempt_budget !== state.attempt_budget || current.model_override !== state.model_override ||
          current.verification_mode !== undefined && current.verification_mode !== state.verification_mode ||
          state.attempt_count < current.attempt_count || state.attempts_used_in_job < current.attempts_used_in_job) return false;
      const merged = { history: structuredClone(current.history ?? []) };
      for (const event of state.history ?? []) appendEvent(merged, event);
      const observed = current.relevant_snapshot ? { context_id: current.context_id, relevant_snapshot: current.relevant_snapshot } : {};
      const index = await this.index({ readOnly: true });
      const next = { ...state, ...observed, history: merged.history, retirement_requested: current.retirement_requested || state.retirement_requested,
        revision: expectedRevision + 1, updated_at: new Date().toISOString(),
        enqueue_sequence: Math.max(0, ...[...index.values()].map(job => job.enqueue_sequence ?? 0)) + 1 };
      if (!validHistory(next)) throw new JobPersistenceError('Invalid monotonic attempt history');
      await save(this.path(state.theorem_id), next);
      Object.assign(state, next);
      return true;
    });
  }
  async requestRetirement(id) {
    return transaction(this.runs, async () => {
      const state = await this.read(id);
      if (state?.job_status !== 'ACTIVE' || state.retirement_requested) return;
      // A request does not invalidate the current action token: its immutable
      // output and issued-request journals must still be committed on drain.
      state.retirement_requested = true;
      state.updated_at = new Date().toISOString();
      await save(this.path(id), state);
    });
  }
  async retire(id) {
    return transaction(this.runs, async () => {
      const state = await this.read(id);
      if (!state || state.job_status !== 'ACTIVE' ||
          ['SUBMITTING', 'SUBMISSION_UNKNOWN', 'PENDING', 'PUBLISHING', 'PUBLISH_UNKNOWN', 'PUBLISH_PENDING'].includes(state.status)) return null;
      Object.assign(state, { job_status: 'RETIRED', retirement_requested: true, dispatch_state: 'QUEUED',
        revision: state.revision + 1, updated_at: new Date().toISOString() });
      delete state.pending_outcome; delete state.next_poll_at;
      await save(this.path(id), state); return state;
    });
  }
  async completeAction(jobId, revision, outcome) {
    const index = await this.index();
    const job = [...index.values()].find(row => row.job_id === jobId);
    return job ? this.replace({ ...job, ...outcome, job_id: job.job_id, theorem_id: job.theorem_id }, revision) : false;
  }
  async execute(id, action) {
    const key = this.path(id);
    if (executing.has(key)) throw new Error(`Theorem job already running: ${id}`);
    executing.add(key);
    try { return await action(); } finally { executing.delete(key); }
  }
}
