import { ApiError } from './api-errors.mjs';
import { idOf, enc, digest, json, sleep, save, targetFingerprint, progress } from './runner-state.mjs';
import { moduleFor, leanEqual, leanTokens, imports, CHILD_FIELDS, DEFINITION_FIELDS } from './lean-artifacts.mjs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PublicationStore, publicationEntries } from './publication-store.mjs';
import { recoveryPolicy, retryDelay } from './recovery-policy.mjs';
import { JobPersistenceError } from './job-store.mjs';
import { proofStorageFailure, parkProofStorageFailure, storageFailureMatches } from './proof-storage-recovery.mjs';

const publicationFailure = (message, category) => Object.assign(new Error(message), {
  failure: { origin: 'publication', category } });

export async function poll(client, submissionId, seconds, interval = 20000) {
  const end = Date.now() + seconds * 1000;
  for (;;) {
    const verdict = await client.request(`verify?submission_id=${enc(submissionId)}`);
    if (typeof verdict.status !== 'string') throw new Error('Invalid verdict');
    if (verdict.status !== 'PENDING') return verdict;
    if (Date.now() >= end) return verdict;
    await sleep(Math.min(interval, Math.max(1, end - Date.now())));
    if (Date.now() >= end) return verdict;
  }
}

export async function pollPublish(client, jobId, seconds, interval = 5000) {
  const end = Date.now() + seconds * 1000;
  for (;;) {
    const job = await client.request(`publish-jobs/${enc(jobId)}`);
    if (!['PENDING', 'COMPILING', 'PUBLISHED', 'FAILED', 'ERROR'].includes(job.status)) throw new Error('Invalid publish job status');
    if (!['PENDING', 'COMPILING'].includes(job.status) || Date.now() >= end) return job;
    await sleep(Math.min(interval, Math.max(1, end - Date.now())));
  }
}

function artifactMatches(row, artifact, target) {
  return row.mathlib_rev === target.mathlib_rev && !row.deprecated_at &&
    moduleFor(row) === moduleFor({ ...artifact, status: artifact.definition ? 'Definition' : 'Open' }) &&
    (artifact.definition
      ? row.status === 'Definition' && leanEqual(row.definition, artifact.definition)
      : ['Open', 'Proved'].includes(row.status) && leanEqual(row.formal_statement, artifact.formal_statement) && leanEqual(row.preamble, artifact.preamble));
}

// Journal each creation before its POST. Reconcile before a timed replacement;
// retain both operation records because the server can still complete the first.
export async function publishArtifacts(client, plan, target, state, statePath, options, hooks = {}) {
  const rows = [], publications = state.publications ??= {};
  const policy = recoveryPolicy(options), now = hooks.now ?? Date.now;
  const entries = publicationEntries(plan, target);
  const reservations = new PublicationStore(options.runs ?? dirname(dirname(statePath)));
  const owner = state.job_id ?? state.theorem_id;
  let shared;
  const persist = async () => {
    await reservations.record(entries, owner, publications);
    await (hooks.persist ?? (() => save(statePath, state)))();
  };
  const existing = new Map();
  async function checkedDetail(artifact, id) {
    const row = await client.request(`theorems/${enc(id)}`);
    if (row.status === 'Disproved') {
      throw publicationFailure(`Published dependency is Disproved: ${artifact.theorem_name ?? artifact.definition_name}`, 'publication_conflict');
    }
    if (idOf(row) !== id || !artifactMatches(row, artifact, target)) {
      throw publicationFailure(`Published dependency changed or does not match: ${artifact.theorem_name ?? artifact.definition_name}`, 'publication_conflict');
    }
    return row;
  }
  shared = await reservations.reserve(entries, owner);
  let namesChecked = false;
  async function preflightNames() {
    if (namesChecked) return;
    // Check all still-unissued names before creating any of them. Wait until
    // the preceding remote compilation finishes: polling an issued job cannot
    // create anything and does not need another round of catalog discovery.
    for (const [index, artifact] of plan.ordered.entries()) {
      const record = publications[entries[index].key] ?? shared.get(entries[index].key)?.journal;
      if (record?.theorem_id || record?.job_id && record.status !== 'ERROR') continue;
      const name = artifact.theorem_name ?? artifact.definition_name;
      const statusFilter = artifact.definition ? '&status=Definition' : '';
      const candidates = await client.pages(`theorems?env=${enc(target.mathlib_rev)}${statusFilter}&theorem_name=${enc(name)}`, 'theorems');
      const matches = candidates.filter(row => (row.theorem_name ?? row.definition_name) === name);
      if (matches.length > 1) throw publicationFailure(`Ambiguous existing dependency: ${name}`, 'publication_conflict');
      if (matches.length) existing.set(name, await checkedDetail(artifact, idOf(matches[0])));
    }
    namesChecked = true;
  }
  let waiting = false;
  const failures = [];
  artifacts: for (const artifact of plan.ordered) {
    try {
      const kind = artifact.definition ? 'definition' : 'problem';
      const fields = kind === 'definition' ? DEFINITION_FIELDS : CHILD_FIELDS;
      const payload = Object.fromEntries(fields.map(field => [field, artifact[field]]));
      if (target.source) payload.source = target.source;
      if (target.tags) payload.tags = target.tags;
      const name = artifact.theorem_name ?? artifact.definition_name;
      // Identity is the mathematical artifact, independent of changing titles/tags/source metadata.
      const key = digest(json({ name, kind, env: target.mathlib_rev,
        code: leanTokens(artifact.definition ?? `${artifact.preamble}\n${artifact.formal_statement}`) }));
      let record = publications[key];
      if (!record && Object.values(publications).some(row => !row.job_id && ['PUBLISHING', 'UNKNOWN'].includes(row.status))) {
        waiting = true; continue;
      }
      // Issue independent siblings in the same scheduler turn, while preserving
      // publication barriers for imports of proposed definitions.
      const blocked = imports(artifact.definition ?? artifact.preamble).some(module => {
        const dependency = plan.ordered.find(row => moduleFor({ ...row, status: row.definition ? 'Definition' : 'Open' }) === module);
        if (!dependency) return false;
        const entry = entries[plan.ordered.indexOf(dependency)];
        return !(publications[entry.key] ?? shared.get(entry.key)?.journal)?.theorem_id;
      });
      if (blocked) { if (!failures.length && !state.retirement_requested) waiting = true; continue; }
      if (failures.length && !record?.job_id && !record?.theorem_id) continue;
      const reservation = shared.get(key);
      const sharedJournal = reservation.journal;
      if (sharedJournal && (!record || !record.theorem_id && sharedJournal.theorem_id ||
          !record.job_id && sharedJournal.job_id ||
          (sharedJournal.operations?.length ?? 0) > (record.operations?.length ?? 0))) {
        record = publications[key] = structuredClone(sharedJournal);
      }
      // Reuse a late successful publication before creating a replacement.
      for (const previousId of record?.previous_jobs ?? []) {
        if (!previousId || record.previous_job_statuses?.[previousId] &&
            !['PENDING', 'COMPILING'].includes(record.previous_job_statuses[previousId])) continue;
        let previous;
        try { previous = await client.request(`publish-jobs/${enc(previousId)}`); }
        catch (error) {
          if (error.status !== 404) throw error;
          (record.previous_job_statuses ??= {})[previousId] = 'MISSING'; continue;
        }
        (record.previous_job_statuses ??= {})[previousId] = previous.status;
        if (previous.status === 'PUBLISHED' && previous.theorem_id) {
          const row = await checkedDetail(artifact, previous.theorem_id);
          record.theorem_id = idOf(row); record.status = 'PUBLISHED'; await persist(); break;
        }
      }
      const detail = id => checkedDetail(artifact, id);
      // Already confirmed declarations only need fresh details when the whole
      // publication set is ready for validation, not on every sibling poll.
      if (record?.theorem_id) { rows.push(() => detail(record.theorem_id)); continue; }
      // Obsolete jobs drain issued requests, but never start another artifact.
      // Leaving PUBLISH_PENDING here and throwing before the next POST used to
      // make retirement restart the same job forever, starving other verdicts.
      if (state.retirement_requested && !record?.job_id && !['PUBLISHING', 'UNKNOWN'].includes(record?.status)) continue;
      if (!state.retirement_requested && (!record?.job_id || record.status === 'ERROR')) await preflightNames();
      // Reuse identical catalog declarations; conflicting names must be repaired, not overwritten.
      if (existing.has(name)) {
        const row = existing.get(name);
        publications[key] = { ...record, payload, status: 'PUBLISHED', theorem_id: idOf(row) };
        await persist(); rows.push(() => row); continue;
      }
      if (!record && reservation.owner !== owner) {
        state.status = 'PUBLISH_PENDING';
        state.next_poll_at = new Date(Date.now() + (options.publishPollInterval ?? 5000)).toISOString();
        await persist(); waiting = true; continue;
      }
      if (record && !record.job_id && ['PUBLISHING', 'UNKNOWN'].includes(record.status)) {
        const jobs = await client.pages(`publish-jobs?kind=${kind}`, 'jobs');
        const matchingJobs = jobs.filter(job => (job.theorem_name ?? job.definition_name) === name &&
          !(record.previous_jobs ?? []).includes(job.id ?? job.job_id) &&
          (job.visibility === 'private') === (record.private ?? target.visibility !== 'public') &&
          (kind === 'problem' ? leanEqual(job.formal_statement, artifact.formal_statement) && leanEqual(job.definitions, artifact.preamble)
            : leanEqual(job.definitions ?? job.definition, artifact.definition)));
        if (matchingJobs.length) record.job_id = matchingJobs[0].id ?? matchingJobs[0].job_id;
        if (!record.job_id) {
          record.reconcile_started_at ??= record.started_at ?? new Date(now()).toISOString();
          record.reconcile_checks = (record.reconcile_checks ?? 0) + 1;
          if (now() - Date.parse(record.reconcile_started_at) < policy.reconcileAfterMs) {
            record.status = 'UNKNOWN'; state.status = 'PUBLISH_UNKNOWN';
            state.next_poll_at = new Date(Math.min(now() + retryDelay(record.reconcile_checks, policy),
              Date.parse(record.reconcile_started_at) + policy.reconcileAfterMs)).toISOString();
            await persist(); waiting = true; continue artifacts;
          }
          record.status = 'ERROR';
          record.recovery_reason = 'unreconciled_publication';
          await persist();
          progress(`[${idOf(target)}] Recovery publication for ${name}; duplicate possible`);
        }
        await persist();
      }
      if (record?.status === 'REJECTED' && [401, 429].includes(record.error_status)) { record.status = 'ERROR'; await persist(); }
      if (state.retirement_requested && (!record || ['ERROR', 'REJECTED'].includes(record.status))) continue;
      if (record?.status === 'REJECTED') throw publicationFailure(`Dependency publication rejected for ${name}: ${record.error}`, 'publication_conflict');
      if (!record || record.status === 'ERROR') {
        await hooks.beforeRemoteWrite?.();
        const previousJobs = record ? [...new Set([...(record.previous_jobs ?? []), record.job_id].filter(Boolean))] : [];
        const previousStatuses = record?.previous_job_statuses;
        const operations = record?.operations ?? [];
        if (record && !operations.length) operations.push({ operation_id: randomUUID(), started_at: record.started_at,
          job_id: record.job_id, status: record.status, error: record.error });
        const operation = { operation_id: randomUUID(), started_at: new Date(now()).toISOString(), status: 'PUBLISHING',
          reason: record?.recovery_reason ?? (record ? 'retry_publication' : 'initial_publication') };
        operations.push(operation);
        record = publications[key] = { payload, status: 'PUBLISHING', started_at: operation.started_at,
          private: target.visibility !== 'public', previous_jobs: previousJobs,
          previous_job_statuses: previousStatuses, operations };
        if (!await reservations.begin(entries.find(entry => entry.key === key), owner, record)) {
          delete publications[key]; state.status = 'PUBLISH_PENDING';
          state.next_poll_at = new Date(Date.now() + (options.publishPollInterval ?? 5000)).toISOString();
          await (hooks.persist ?? (() => save(statePath, state)))(); waiting = true; continue;
        }
        state.status = 'PUBLISHING'; await persist();
        let response;
        try { await hooks.beforeRemoteWrite?.(); response = await client.publish(kind, payload, target); }
        catch (error) {
          record.status = error instanceof ApiError && error.status >= 400 && error.status < 500 ? 'REJECTED' : 'UNKNOWN';
          record.error = error.message;
          record.error_status = error.status;
          operation.status = record.status; operation.error = record.error;
          state.status = record.status === 'UNKNOWN' ? 'PUBLISH_UNKNOWN' : 'PUBLICATION_FAILED';
          state.feedback = `Dependency ${name}: ${error.message}`;
          await persist(); throw error;
        }
        record.job_id = response.job_id ?? response.jobs?.find(job => job.name === name)?.job_id;
        operation.job_id = record.job_id;
        if (typeof record.job_id !== 'string' || !record.job_id) {
          if (response.errors?.length) {
            record.status = 'REJECTED'; record.error = json(response.errors); state.status = 'PUBLICATION_FAILED';
            state.feedback = `Dependency ${name}: ${record.error}`;
          } else { record.status = 'UNKNOWN'; state.status = 'PUBLISH_UNKNOWN'; }
          operation.status = record.status;
          await persist(); throw new Error(`Dependency publication returned no job ID for ${name}${record.error ? `: ${record.error}` : ''}`);
        }
        record.status = 'PENDING'; operation.status = 'PENDING'; await persist();
        progress(`[${idOf(target)}] Publication queued: ${name}; job ${record.job_id}`);
      }
      let job;
      try { job = await (hooks.pollPublish ?? ((client, id) => client.request(`publish-jobs/${enc(id)}`)))(client, record.job_id, options.pollTimeout); }
      catch (error) {
        if (error.status !== 404) throw error;
        record.previous_jobs = [...new Set([...(record.previous_jobs ?? []), record.job_id])];
        (record.previous_job_statuses ??= {})[record.job_id] = 'MISSING';
        delete record.job_id; record.status = 'UNKNOWN';
        record.reconcile_started_at = record.started_at ?? new Date(now()).toISOString();
        state.status = 'PUBLISH_UNKNOWN'; state.next_poll_at = new Date(now() + policy.initialDelayMs).toISOString();
        await persist(); waiting = true; continue;
      }
      if (!['PENDING', 'COMPILING', 'PUBLISHED', 'FAILED', 'ERROR'].includes(job.status)) throw new Error('Invalid publish job status');
      const previousStatus = record.status;
      record.status = job.status;
      const operation = record.operations?.findLast(op => op.job_id === record.job_id);
      if (operation) { operation.status = job.status; operation.checked_at = new Date(now()).toISOString(); operation.error = job.error_message; }
      if (['PENDING', 'COMPILING'].includes(job.status)) {
        record.started_at ??= job.created_at ?? new Date(now()).toISOString();
        if (now() - Date.parse(record.started_at) >= policy.pendingTimeoutMs) {
          record.previous_jobs = [...new Set([...(record.previous_jobs ?? []), record.job_id])];
          delete record.job_id;
          record.status = 'UNKNOWN'; record.reconcile_started_at = new Date(now()).toISOString();
          state.status = 'PUBLISH_UNKNOWN'; state.next_poll_at = new Date(now() + policy.initialDelayMs).toISOString();
          await persist(); waiting = true; continue;
        }
        if (job.status !== previousStatus) progress(`[${idOf(target)}] Publication ${job.status}: ${name}; job ${record.job_id}`);
        state.next_poll_at = new Date(Date.now() + (options.publishPollInterval ?? 5000)).toISOString();
        state.status = 'PUBLISH_PENDING'; await persist(); waiting = true; continue;
      }
      if (job.status !== 'PUBLISHED') {
        record.error = job.error_message ?? json(job); state.status = 'PUBLICATION_FAILED';
        state.feedback = `Dependency ${name} ${job.status}: ${record.error}`;
        await persist();
        const error = publicationFailure(`Dependency ${name} ${job.status}: ${record.error}`, 'publication_compile_error');
        error.infrastructure = job.status === 'ERROR';
        throw error;
      }
      if (typeof job.theorem_id !== 'string') throw new Error(`Published job has no theorem ID for ${name}`);
      // Publication finished even if the declaration has since become unusable.
      // Preserve that identity before a detail check can reject the reduction.
      record.theorem_id = job.theorem_id; await persist();
      let row;
      try { row = await detail(record.theorem_id); }
      catch (error) {
        if (error.failure?.category === 'publication_conflict' && entries.every(entry => {
          const journal = publications[entry.key] ?? shared.get(entry.key)?.journal;
          return !journal || ['PUBLISHED', 'FAILED', 'ERROR', 'REJECTED'].includes(journal.status);
        })) {
          state.status = 'PUBLICATIONS_READY'; await persist();
        }
        throw error;
      }
      rows.push(() => row);
      progress(`[${idOf(target)}] Publication confirmed: ${name}; theorem ${record.theorem_id}; job ${record.job_id}`);
    } catch (error) {
      options.signal?.throwIfAborted();
      if (error.failure?.origin !== 'publication') throw error;
      failures.push(error);
    }
  }
  if (waiting) {
    const unknown = Object.values(publications).some(row => !row.job_id && ['PUBLISHING', 'UNKNOWN'].includes(row.status));
    state.status = unknown ? 'PUBLISH_UNKNOWN' : 'PUBLISH_PENDING';
    // Reconciliation backoff remains authoritative for unknown POST outcomes.
    if (!unknown || !state.next_poll_at) state.next_poll_at = new Date(now() + (options.publishPollInterval ?? 5000)).toISOString();
    await persist(); return null;
  }
  // No current publication is in flight. Detail validation can now reject an
  // invalid reduction without parking it as an uncertain remote operation.
  state.status = 'PUBLICATIONS_READY'; await persist();
  if (failures.length) throw failures[0];
  return Promise.all(rows.map(read => read()));
}

async function recoverSubmission(client, targetId, hash, proofType = 'prove', excluded = [], state) {
  let seen = 0;
  for (let page = 1; ; page++) {
    const response = await client.request(`submissions?page=${page}`);
    if (!Array.isArray(response.submissions) || !Number.isSafeInteger(response.total)) throw new Error('Invalid submission history');
    // The current API omits proof_type from history and verdicts. Match exact
    // bytes and retain the locally journaled mode; check it when API metadata
    // does include it rather than treating an absent field as a proof.
    for (const row of response.submissions.filter(r => !excluded.includes(r.id) && r.theorem_id === targetId &&
        (r.proof_type == null || r.proof_type === proofType))) {
      // Storage failures have no stored solution to hash. Account-scoped
      // history, target, mode and the current upload's start identify them.
      if (state && storageFailureMatches(row, state)) return { id: row.id, verdict: row };
      if (proofStorageFailure(row)) continue;
      const { content } = await client.request(`submissions/${enc(row.id)}/solution`);
      if (typeof content === 'string' && digest(content) === hash) return { id: row.id };
    }
    seen += response.submissions.length;
    if (seen >= response.total) return null;
    if (!response.submissions.length) throw new Error('Incomplete submission history');
  }
}


// Serial remote boundary. Existing publication/submission journals remain authoritative.
export function createRemoteActions({ client, target, state, statePath, options, hooks = {} }) {
  const persist = hooks.persist ?? (() => save(statePath, state));
  const policy = recoveryPolicy(options), now = hooks.now ?? Date.now;
  const check = (id = state.submission_id) => (hooks.poll ?? ((client, id) => client.request(`verify?submission_id=${enc(id)}`)))(client, id, options.pollTimeout);
  function journal() {
    state.remote_operations ??= [];
    if (!state.remote_operations.length && state.submission_started_at) state.remote_operations.push({
      operation_id: randomUUID(), reason: 'legacy_upload', started_at: state.submission_started_at,
      source_hash: state.source_hash, target_hash: state.target_fingerprint,
      proof_type: state.proof_type ?? 'prove', submission_id: state.submission_id,
    });
    return state.remote_operations;
  }
  async function savedArtifact() {
    try {
      const artifact = state.artifact_manifest;
      if (!artifact || artifact.source_hash !== state.source_hash || digest(artifact.source) !== artifact.source_hash ||
          artifact.target_hash !== targetFingerprint(target) || digest(artifact.explanation) !== artifact.explanation_hash ||
          digest(await readFile(artifact.snapshot, 'utf8')) !== artifact.source_hash ||
          digest(await readFile(artifact.explanation_path, 'utf8')) !== artifact.explanation_hash) {
        throw new Error('saved immutable artifact is missing or changed');
      }
      return artifact;
    } catch (error) {
      throw new JobPersistenceError(`Cannot recover upload: saved immutable artifact is missing or changed (${error.message})`);
    }
  }
  async function resubmit(reason) {
    if (state.retirement_requested) return { type: 'TARGET_OBSOLETE' };
    const artifact = await savedArtifact();
    const live = await client.request(`theorems/${enc(idOf(target))}`);
    if (live.deprecated_at || targetFingerprint(live) !== targetFingerprint(target)) {
      // Do not submit bytes against a different declaration. The runner will
      // reselect the current target after committing this old operation's log.
      state.remote_recovery = { ...state.remote_recovery, reason: 'target_changed' };
      return { type: 'TARGET_CHANGED' };
    }
    if (live.status === 'Proved' && state.proof_type !== 'disprove') return { type: 'TARGET_RESOLVED' };
    if (live.status === 'Disproved') return { type: 'TARGET_DISPROVED' };
    for (const dependency of state.published_dependencies ?? []) {
      const row = await client.request(`theorems/${enc(idOf(dependency))}`);
      if (row.deprecated_at || row.mathlib_rev !== target.mathlib_rev ||
          !['Definition', 'Proved', ...(artifact.kind === 'sketch' ? ['Open'] : [])].includes(row.status)) {
        return { type: 'CANDIDATE_INVALIDATED', message: `Saved dependency ${idOf(dependency)} is no longer usable; reassess the reduction.` };
      }
    }
    progress(`[${idOf(target)}] Recovery resubmission (${reason}); original operation retained; duplicate possible`);
    return { type: 'REMOTE_RESULT', status: await submitVerified(artifact.source, artifact.explanation,
      artifact.attempt, state.proof_type ?? 'prove', reason) };
  }
  async function recordVerdict(verdict) {
    if (typeof verdict.status !== 'string') throw new Error('Invalid verdict');
    const previousVerdict = state.verdict?.status;
    state.verdict = verdict;
    const operation = journal().findLast(row => row.submission_id === state.submission_id);
    if (operation) { operation.status = verdict.status; operation.checked_at = new Date(now()).toISOString(); }
    if (proofStorageFailure(verdict)) {
      parkProofStorageFailure(state, verdict, options, now());
      hooks.proofStorageRecovery?.block(state);
      await persist();
      progress(`[${idOf(target)}] Proof storage unavailable; Codex paused; retrying saved proof at ${state.next_poll_at}`);
      return 'PENDING';
    }
    state.status = verdict.status;
    if (state.proof_type === 'disprove' && verdict.status !== 'PENDING') {
      state.status = verdict.status === 'ACCEPTED' ? 'DISPROVED' : 'DISPROOF_REJECTED';
    }
    if (verdict.status === 'PENDING') state.next_poll_at = new Date(now() + (options.serverPollInterval ?? 20000)).toISOString();
    else delete state.next_poll_at;
    await persist();
    if (verdict.status !== 'PENDING' && state.proof_storage_retry) {
      delete state.proof_storage_retry; delete state.infrastructure_wait;
      await persist();
      hooks.proofStorageRecovery?.clear(state);
      progress(`[${idOf(target)}] Proof storage recovered: ${verdict.status}`);
    }
    if (verdict.status !== previousVerdict) progress(`[${idOf(target)}] Submission ${state.submission_id}: ${state.status}${state.status === 'DISPROOF_REJECTED' ? ` (${verdict.status}): ${verdict.error_message ?? ''}` : ''}`);
    return state.status;
  }
  async function submitVerified(source, explanation, attempt, proofType = 'prove', reason = 'initial_upload') {
    await hooks.beforeRemoteWrite?.();
    journal();
    const start = state.history?.find(e => e.event_type === 'attempt' && e.result === 'started' && e.attempt === attempt);
    const operation = { operation_id: randomUUID(), reason, started_at: new Date(now()).toISOString(),
      attempt_id: start?.attempt_id, prompt_experiment: start?.prompt_experiment,
      candidate_kind: state.artifact_manifest?.kind ?? state.candidate_kind,
      source_hash: digest(source), target_hash: targetFingerprint(target), proof_type: proofType, attempt, status: 'SUBMITTING' };
    state.remote_operations.push(operation);
    state.status = 'SUBMITTING'; state.source_hash = digest(source); state.attempt = attempt; state.proof_type = proofType;
    state.submission_started_at = operation.started_at;
    delete state.submission_id;
    delete state.remote_recovery;
    delete state.submission_error;
    delete state.verdict;
    await persist();
    let submission;
    try {
      await hooks.beforeRemoteWrite?.();
      submission = await client.submit(idOf(target), source, explanation, proofType);
      if (typeof submission?.submission_id !== 'string' || !submission.submission_id.trim()) {
        throw new Error('Submission response has no ID; rerun to recover it');
      }
    } catch (error) {
      const rejected = error instanceof ApiError && error.status >= 400 && error.status < 500;
      state.status = rejected ? 'REJECTED' : 'SUBMISSION_UNKNOWN';
      if (rejected && proofType === 'disprove') state.status = 'DISPROOF_REJECTED';
      let message = error.message;
      for (const secret of [client.key, client.token]) if (secret) message = message.replaceAll(secret, '[redacted]');
      state.submission_error = { name: error.name, message, status: error.status, cause_code: error.cause?.code, at: new Date().toISOString() };
      operation.status = state.status; operation.error = state.submission_error;
      await persist(); throw error;
    }
    operation.submission_id = submission.submission_id; operation.status = 'PENDING';
    state.submission_id = submission.submission_id; state.submissions ??= [];
    if (!state.submissions.includes(submission.submission_id)) state.submissions.push(submission.submission_id);
    state.status = 'PENDING';
    await persist();
    progress(`[${idOf(target)}] Submitted ${proofType === 'disprove' ? 'disproof ' : ''}${state.submission_id}; checking verdict`);
    return recordVerdict(await check());
  }

  return {
    async submit(artifact, proofType = 'prove') {
      if (artifact.source_hash !== digest(artifact.source) || artifact.explanation_hash !== digest(artifact.explanation) ||
          artifact.target_hash !== targetFingerprint(target)) throw new Error('Validated artifact identity changed before submission');
      return { type: 'REMOTE_RESULT', status: await submitVerified(artifact.source, artifact.explanation, artifact.attempt, proofType) };
    },
    async recoverSubmission() {
      journal();
      const recovered = await recoverSubmission(client, idOf(target), state.source_hash,
        state.proof_type ?? 'prove', state.unavailable_submission_ids ?? [], state);
      if (recovered) {
        const submissionId = recovered.id;
        const operation = state.remote_operations.at(-1);
        if (operation) { operation.submission_id = submissionId; operation.status = 'PENDING'; }
        delete state.remote_recovery; await persist();
        if (recovered.verdict) {
          state.submission_id = submissionId;
          state.submissions ??= [];
          if (!state.submissions.includes(submissionId)) state.submissions.push(submissionId);
          return { type: 'REMOTE_RESULT', status: await recordVerdict(recovered.verdict) };
        }
        return { type: 'RECOVERED', submissionId };
      }
      const recovery = state.remote_recovery ??= { started_at: state.submission_started_at ?? new Date(now()).toISOString(), checks: 0 };
      recovery.checks++; recovery.last_checked_at = new Date(now()).toISOString();
      if (now() - Date.parse(recovery.started_at) >= policy.reconcileAfterMs) return resubmit('unreconciled_upload');
      state.status = 'SUBMISSION_UNKNOWN';
      state.next_poll_at = new Date(Math.min(now() + retryDelay(recovery.checks, policy),
        Date.parse(recovery.started_at) + policy.reconcileAfterMs)).toISOString();
      await persist(); return { type: 'WAIT' };
    },
    async pollSubmission() {
      journal();
      if (state.proof_storage_retry?.submission_id === state.submission_id) {
        if (hooks.readOnlyPoll?.() || now() < Date.parse(state.proof_storage_retry.next_retry_at)) {
          state.next_poll_at = state.proof_storage_retry.next_retry_at;
          await persist(); return { type: 'REMOTE_RESULT', status: 'PENDING' };
        }
        return resubmit('proof_storage_failure');
      }
      // A superseded upload can finish after its replacement. A successful
      // verdict on the same immutable artifact wins over a pending replacement.
      for (const operation of state.remote_operations) {
        if (!operation.submission_id || operation.submission_id === state.submission_id ||
            operation.source_hash !== state.source_hash || operation.target_hash !== targetFingerprint(target) ||
            operation.proof_type !== (state.proof_type ?? 'prove') || operation.status && operation.status !== 'PENDING') continue;
        let previous;
        try { previous = await check(operation.submission_id); }
        catch (error) { if (error.status !== 404) throw error; operation.status = 'MISSING'; continue; }
        operation.status = previous.status;
        if (['ACCEPTED', 'SKETCH_ACCEPTED'].includes(previous.status)) {
          state.submission_id = operation.submission_id;
          return { type: 'REMOTE_RESULT', status: await recordVerdict(previous) };
        }
      }
      let verdict;
      try { verdict = await check(); }
      catch (error) {
        if (error.status !== 404) throw error;
        state.unavailable_submission_ids = [...new Set([...(state.unavailable_submission_ids ?? []), state.submission_id])];
        state.status = 'SUBMISSION_UNKNOWN'; await persist();
        if (hooks.readOnlyPoll?.()) {
          state.next_poll_at = new Date(now()).toISOString(); await persist();
          return { type: 'WAIT' };
        }
        return this.recoverSubmission();
      }
      if (verdict.status === 'PENDING') {
        const since = Date.parse(state.submission_started_at ?? verdict.created_at ?? '');
        if (Number.isFinite(since) && now() - since >= policy.pendingTimeoutMs) {
          await recordVerdict(verdict);
          if (hooks.readOnlyPoll?.()) return { type: 'REMOTE_RESULT', status: 'PENDING' };
          const recovered = await recoverSubmission(client, idOf(target), state.source_hash,
            state.proof_type ?? 'prove', state.submissions ?? [state.submission_id]);
          if (recovered) {
            state.remote_operations.push({ operation_id: randomUUID(), reason: 'history_recovery',
              source_hash: state.source_hash, target_hash: targetFingerprint(target), proof_type: state.proof_type ?? 'prove',
              submission_id: recovered.id, started_at: new Date(now()).toISOString(), status: 'PENDING' });
            state.submission_id = recovered.id;
            if (!state.submissions.includes(recovered.id)) state.submissions.push(recovered.id);
            state.submission_started_at = new Date(now()).toISOString();
            await persist(); return { type: 'REMOTE_RESULT', status: await recordVerdict(await check()) };
          }
          return resubmit('stale_pending_submission');
        }
      }
      return { type: 'REMOTE_RESULT', status: await recordVerdict(verdict) };
    },
    async publish(plan) {
      const rows = await publishArtifacts(client, plan, target, state, statePath, options, hooks);
      if (rows && state.retirement_requested) return { type: 'TARGET_OBSOLETE' };
      return rows ? { type: 'PUBLICATIONS_READY', rows } : { type: 'REMOTE_RESULT', status: 'PUBLISH_PENDING' };
    },
  };
}
