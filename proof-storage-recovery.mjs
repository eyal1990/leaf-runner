import { recoveryPolicy, retryDelay } from './recovery-policy.mjs';

export const proofStorageFailure = verdict => verdict?.status === 'ERROR' &&
  /^Could not enqueue the submission:\s*could not store the proof file:/i.test(verdict.error_message ?? '');

export class ProofStoragePaused extends Error {
  constructor() { super('Codex dispatch deferred until proof storage recovers'); }
}

// The job marker is the durable source of truth. The shared latch closes
// synchronously, before asynchronous job writes can yield to model dispatch.
export class ProofStorageRecovery {
  constructor(changed = () => {}) { this.jobs = new Map(); this.changed = changed; }
  get waiting() { return this.jobs.size > 0; }
  get state() { return { waiting: this.waiting, jobs: [...this.jobs.values()] }; }
  block(job) {
    this.jobs.set(job.theorem_id, { theorem_id: job.theorem_id, ...job.proof_storage_retry });
    this.changed();
  }
  clear(job) {
    if (this.jobs.delete(job.theorem_id)) this.changed();
  }
  restore(index) {
    for (const job of index.values()) if (job.job_status === 'ACTIVE' && job.proof_storage_retry) this.block(job);
  }
}

export function parkProofStorageFailure(state, verdict, options, now = Date.now()) {
  const previous = state.proof_storage_retry;
  const failures = (previous?.failures ?? 0) + Number(previous?.submission_id !== state.submission_id);
  const next = previous?.submission_id === state.submission_id ? previous.next_retry_at
    : new Date(now + retryDelay(failures, recoveryPolicy(options))).toISOString();
  state.proof_storage_retry = { failures, submission_id: state.submission_id,
    source_hash: state.source_hash, error_message: verdict.error_message, next_retry_at: next };
  // Remain issued remote work. This must never enter mathematical repair or
  // consume another attempt, even if the current attempt budget is exhausted.
  state.status = 'PENDING'; state.next_poll_at = next;
  state.infrastructure_wait = verdict.error_message;
}

export function storageFailureMatches(row, state) {
  return proofStorageFailure(row) && row.theorem_id === state.theorem_id &&
    (row.proof_type == null || row.proof_type === (state.proof_type ?? 'prove')) &&
    Number.isFinite(Date.parse(state.submission_started_at)) &&
    Date.parse(row.created_at) >= Date.parse(state.submission_started_at);
}
