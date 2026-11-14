import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { JobStore, JobPersistenceError, remoteStatuses } from './job-store.mjs';
import { PublicationStore } from './publication-store.mjs';
import { createJobStages } from './job-stages.mjs';
import { createRemoteActions } from './remote-actions.mjs';
import { serverOnly, verificationMode } from './verification-mode.mjs';
import { idOf, enc, digest, json, save, exists, targetFingerprint, readJson, writeIfChanged } from './runner-state.mjs';
import { appendEvent, reduceHistory, failureFor, operationFor } from './attempt-history.mjs';
import { transientReadError } from './api-errors.mjs';
import { CodexQuota, CodexQuotaError, isCodexQuotaError } from './codex-quota.mjs';
import { snapshotMissionResearch } from './mission-research.mjs';
import { attemptModel, incompleteEvidence } from './model-policy.mjs';
import { workerContext } from './worker-context.mjs';
import { selectPrompt } from './prompt-experiment.mjs';
import { recoveryPolicy } from './recovery-policy.mjs';
import { progress } from './runner-state.mjs';
import { ProofStoragePaused } from './proof-storage-recovery.mjs';
import { AgentsStopped } from './agent-control.mjs';

const done = new Set(['ACCEPTED', 'SKETCH_ACCEPTED', 'DISPROVED']);
const uncertain = new Set(['SUBMITTING', 'SUBMISSION_UNKNOWN', 'PENDING', 'PUBLISHING', 'PUBLISH_UNKNOWN', 'PUBLISH_PENDING']);
export class RetiredJob extends Error {}

// Serial coordinator. Each awaited action has a durable stage and revision;
// artifacts commit before references, and external journals commit before POSTs.
export async function runSerialJob(client, target, context, environment, options, hooks, dependencies) {
  const store = new JobStore(options.runs), id = idOf(target), dir = join(options.runs, id);
  return store.execute(id, async () => {
    await mkdir(dir, { recursive: true });
    const state = await store.ensure(id, { attempts: options.attempts, rootId: options.rootId ?? context.scope?.root,
      runId: options.runId, mathlibRev: target.mathlib_rev, model: options.model, verificationMode: verificationMode(options) });
    // A restart retains the original job's verification mode as well as budget.
    state.verification_mode ??= verificationMode(options);
    options = { ...options, verificationMode: state.verification_mode };
    const recovery = recoveryPolicy(options), now = hooks.now ?? Date.now;
    let workspace, knownDependencies, readyAttempt = 0;
    if (uncertain.has(state.status)) {
      const snapshot = await readJson(join(dir, 'context.json'));
      // Issued journals refer to the original declaration/environment even if
      // the current platform statement changed while the request was pending.
      if (snapshot?.target && idOf(snapshot.target) === id) {
        target = snapshot.target; environment = snapshot.environment ?? environment; context = snapshot;
      }
    }
    const statePath = store.path(id);
    const quota = hooks.quota ?? new CodexQuota(options.runs, {
      readLimits: hooks.readCodexRateLimits ?? dependencies.readCodexRateLimits, signal: options.signal,
    });
    if (!hooks.quota) await quota.load();
    if (state.codex_quota_wait && !quota.state) await quota.block(state.codex_quota_wait);
    async function persist() {
      try {
        if (!await store.replace(state, state.revision, { allowRetirement: !!hooks.dispatch })) throw new JobPersistenceError('Stale theorem action completion ignored');
      } catch (error) { throw new JobPersistenceError(`Cannot persist theorem action: ${error.message}`, { cause: error }); }
      options.signal?.throwIfAborted();
      await hooks.changed?.(state);
    }
    async function transition(stage, operation, dispatch = 'QUEUED') {
      if (serverOnly(options) && stage === 'SERVER') await detachWorkspace();
      if (hooks.dispatch && dispatch !== 'RUNNING') {
        state.pending_outcome = { stage, operation, dispatch_state: dispatch,
          next_poll_at: dispatch === 'DELAYED' ? state.next_poll_at : undefined };
        state.dispatch_state = 'HANDOFF_PENDING';
        await persist();
        await hooks.dispatch(state, persist);
        return;
      }
      Object.assign(state, { stage, operation, dispatch_state: dispatch });
      await persist();
    }
    const dispatch = async () => {
      if (hooks.dispatch) await hooks.dispatch(state, persist);
    };
    async function waitForQuota() {
      if (quota.waiting && state.dispatch_state === 'RUNNING' && state.attempt_id) {
        // Another worker can exhaust the quota after this attempt was saved but
        // before it made a request. Preserve that identity across shutdown too.
        state.codex_quota_wait ??= { message: quota.state.reason, operation: state.operation,
          attempt_id: state.attempt_id, paused_at: new Date().toISOString() };
        state.dispatch_state = 'QUEUED'; await persist();
      }
      if (hooks.dispatch) {
        if (quota.waiting) await transition('CODEX', state.operation);
        return;
      }
      while (quota.waiting) {
        options.signal?.throwIfAborted();
        await quota.check();
        if (quota.waiting) await delay(Math.max(1, Math.min(30000, quota.nextCheckAt - Date.now())), undefined, { signal: options.signal });
      }
    }
    async function parkStorageDispatch() {
      // Reuse the saved-attempt continuation marker used by operator pauses.
      state.operator_dispatch_wait = true;
      await transition('CODEX', state.operation);
    }
    async function parkStoppedAgent() {
      const suffix = randomUUID();
      const log = join(dir, `codex-${state.attempt_count}${state.operation === 'format_repair' ? '-repair' : ''}.log`);
      if (await exists(log)) await copyFile(log, join(dir, `codex-operator-stop-${suffix}.log`));
      const partial = join(dir, `solution-${state.attempt_count}.lean`);
      if (state.operation !== 'format_repair' && await exists(partial)) {
        const source = await readFile(partial, 'utf8'), path = join(dir, `solution-operator-partial-${suffix}.lean`);
        await writeFile(path, source);
        state.codex_partial = { path, source_hash: digest(source), module: `Solutions.Sol_${id.replaceAll('-', '_')}` };
      }
      await parkStorageDispatch();
    }
    async function parkQuota(error) {
      // Commit a queued operation before parking the shared queue. A restart at
      // either write recovers the wait rather than consuming another attempt.
      const suffix = randomUUID();
      const log = error.log ?? join(dir, `codex-${state.attempt_count}${state.operation === 'format_repair' ? '-repair' : ''}.log`);
      if (await exists(log)) await copyFile(log, join(dir, `quota-${state.attempt_count}-${suffix}.log`));
      if (state.operation !== 'format_repair') {
        const partial = join(dir, `solution-${state.attempt_count}.lean`);
        if (await exists(partial)) {
          const source = await readFile(partial, 'utf8');
          const path = join(dir, `quota-partial-${suffix}.lean`);
          await writeFile(path, source);
          state.codex_partial = { path, source_hash: digest(source), module: `Solutions.Sol_${id.replaceAll('-', '_')}` };
        }
      }
      state.codex_quota_wait = { message: error.message, resets_at: error.resets_at, thread_id: error.thread_id,
        paused_at: new Date().toISOString(), operation: state.operation, attempt_id: state.attempt_id };
      state.dispatch_state = 'QUEUED';
      await persist();
      try { await quota.block(error); }
      catch (failure) { throw new JobPersistenceError(`Cannot persist Codex quota pause: ${failure.message}`, { cause: failure }); }
      if (hooks.dispatch) await transition('CODEX', state.operation);
      else await waitForQuota();
    }
    async function outcome(result, failure) {
      if (!state.attempt_id) return;
      const start = state.history.find(e => e.attempt_id === state.attempt_id && e.result === 'started');
      // Legacy outcomes remain explicitly unknown rather than invented starts.
      if (!start) return;
      appendEvent(state, { event_id: `${state.attempt_id}:outcome`, event_type: 'attempt',
        root_id: start.root_id, run_id: start.run_id,
        attempt: start.attempt, attempt_id: start.attempt_id, context_id: start.context_id, result, failure,
        prompt_experiment: start.prompt_experiment,
        candidate_kind: state.artifact_manifest?.kind ?? state.candidate_kind, submission_id: state.submission_id,
        reduction_id: result === 'sketch_accepted' ? state.submission_id : undefined,
        artifacts: { candidate: state.candidate, answer_path: join(dir, `answer-${start.attempt}.json`),
          solution_path: state.artifact_manifest?.snapshot ?? join(dir, `solution-${start.attempt}.lean`),
          explanation_path: state.artifact_manifest?.explanation_path, artifact_manifest: state.artifact_manifest ? join(dir, `artifacts-${start.attempt}.json`) : undefined } });
    }
    async function finish(status) {
      await new PublicationStore(options.runs).releaseUnused(state.job_id);
      if (done.has(status)) await outcome(status === 'SKETCH_ACCEPTED' ? 'sketch_accepted'
        : status === 'DISPROVED' || state.proof_type === 'disprove' ? 'disproof_accepted' : 'proof_accepted');
      else if (status.startsWith('SKIPPED')) await outcome('incomplete', failureFor({ origin: 'live_target', code: status }));
      state.status = status;
      state.job_status = done.has(status) || status.startsWith('SKIPPED') ? 'DONE' : 'READY';
      state.dispatch_state = 'QUEUED'; delete state.next_poll_at;
      delete state.pending_outcome;
      if (done.has(status) || status.startsWith('SKIPPED')) delete state.proof_storage_retry;
      await persist();
      if (!state.proof_storage_retry) hooks.proofStorageRecovery?.clear(state);
      return status;
    }
    async function retry(feedback, category, result = 'rejected', stagnation) {
      delete state.proof_storage_retry;
      delete state.codex_quota_wait; delete state.codex_partial;
      await new PublicationStore(options.runs).releaseUnused(state.job_id);
      const diagnostic = join(dir, `failure-${state.attempt_count}.json`);
      await save(diagnostic, { feedback, verdict: state.verdict, submission_error: state.submission_error });
      const origin = state.stage === 'SERVER' ? state.operation === 'publish' ? 'publication' : 'server_verification'
        : state.stage === 'VALIDATE' ? 'local_validation' : 'model';
      await outcome(result, { ...failureFor({ origin, code: state.verdict?.status ?? state.submission_error?.status,
        category: category ?? (state.proof_type === 'disprove' ? 'counterexample_uncertified' : undefined), diagnostic_path: diagnostic }),
        ...(stagnation ? { stagnation } : {}) });
      state.feedback = feedback; state.status = 'REPAIR_REQUIRED';
      // Mathematical outcomes return directly to scored selection. The shared
      // Sol permit bounds expensive retries; infrastructure recovery owns backoff.
      delete state.retry_after; delete state.recovery_failure;
      state.previous_candidate = state.candidate ?? state.previous_candidate;
      delete state.candidate; delete state.artifact_manifest; delete state.plan;
      delete state.submission_id; delete state.next_poll_at; delete state.verdict; delete state.proof_type;
      delete state.format_repair_input;
      state.stage = 'PREPARE'; state.operation = 'prepare';
      return finish('READY');
    }
    if (done.has(state.status)) return state.job_status === 'DONE' ? state.status : finish(state.status);
    if (state.job_status === 'NEEDS_ATTENTION') state.job_status = uncertain.has(state.status) ? 'ACTIVE' : 'READY';
    if (state.job_status !== 'ACTIVE') return state.status ?? 'UNRESOLVED';
    state.submissions ??= [];
    if (state.mathlib_rev && state.mathlib_rev !== target.mathlib_rev && !uncertain.has(state.status)) {
      state.feedback = 'The target or Lean environment changed; reassess the earlier counterexample against the current statement.';
      return finish('READY');
    }
    if (state.target_fingerprint && state.target_fingerprint !== targetFingerprint(target) && !uncertain.has(state.status)) {
      state.feedback = 'Target changed; rerun discovery and review the saved job.'; return finish('READY');
    }
    state.mathlib_rev = target.mathlib_rev; state.target_fingerprint ??= targetFingerprint(target);
    const environmentFingerprint = digest(json(environment));
    if (state.environment_fingerprint && state.environment_fingerprint !== environmentFingerprint && !uncertain.has(state.status)) {
      await store.observeGraph({ root: target, leaves: [], nodes: [{ ...target,
        reductions: context.decompositions?.decompositions ?? state.selection?.reductions ?? target.reductions,
        environment_fingerprint: environmentFingerprint }] });
      const observed = await store.read(id);
      state.history = observed.history; state.context_id = observed.context_id; state.relevant_snapshot = observed.relevant_snapshot;
    }
    state.environment_fingerprint = environmentFingerprint;
    await save(join(dir, 'context.json'), { ...context, target, environment });
    const remote = createRemoteActions({ client, target, state, statePath, options, hooks: { ...hooks, persist } });
    async function remoteResult(result) {
      if (result.type === 'RECOVERED') {
        state.submission_id = result.submissionId; state.status = 'PENDING';
        if (!state.submissions.includes(result.submissionId)) state.submissions.push(result.submissionId);
        await transition('SERVER', 'poll_submission'); return null;
      }
      if (result.type === 'TARGET_CHANGED') return retry('Target changed during remote recovery; reassess the current declaration.', 'target_changed');
      if (result.type === 'CANDIDATE_INVALIDATED') return retry(result.message, 'dependency_changed');
      if (result.type === 'TARGET_RESOLVED') return finish('SKIPPED (Proved)');
      if (result.type === 'TARGET_OBSOLETE') return finish('SKIPPED (No longer needed)');
      if (result.type === 'TARGET_DISPROVED') return finish('SKIPPED (Disproved)');
      if (result.type === 'WAIT') {
        await transition('SERVER', 'reconcile_submission', 'DELAYED');
        return hooks.dispatch ? null : 'SUBMISSION_UNKNOWN';
      }
      if (done.has(result.status)) return finish(result.status);
      if (result.status === 'PENDING') {
        await transition('SERVER', state.proof_storage_retry?.submission_id === state.submission_id ? 'retry_storage' : 'poll_submission', 'DELAYED');
        return hooks.dispatch ? null : 'PENDING';
      }
      return retry(json(state.verdict));
    }
    // A killed invocation consumes its saved attempt. Never rerun its number.
    if (state.stage === 'CODEX' && state.dispatch_state === 'RUNNING') {
      // The artifact rename may have committed just before the state reference.
      // Recover that boundary before classifying the invocation as interrupted.
      const path = join(dir, `candidate-${state.attempt_count}${state.operation === 'format_repair' ? '-formatted' : ''}.json`);
      const candidate = await readJson(path);
      if (candidate && candidate.attempt === state.attempt_count &&
          (!candidate.attempt_id || candidate.attempt_id === state.attempt_id)) {
        if (candidate.source !== null && digest(candidate.source) !== candidate.source_hash) throw new JobPersistenceError('Saved candidate artifact changed');
        state.candidate = { path, source_hash: candidate.source_hash, attempt: candidate.attempt,
          explanation_path: candidate.explanation_path };
        await transition('VALIDATE', 'validate');
      } else {
        const stopped = await retry(`Interrupted ${state.operation} invocation (saved #${state.attempt_count}); this attempt was consumed.\n${state.feedback ?? ''}`, 'interrupted', 'interrupted');
        if (stopped) return stopped;
      }
    }
    if (!hooks.dispatch && ['SUBMITTING', 'SUBMISSION_UNKNOWN'].includes(state.status)) {
      await transition('SERVER', 'reconcile_submission', 'RUNNING');
      const stopped = await remoteResult(await remote.recoverSubmission());
      if (stopped) return stopped;
    }
    if (!hooks.dispatch && state.status === 'PENDING') {
      await transition('SERVER', 'poll_submission', 'RUNNING');
      const stopped = await remoteResult(await remote.pollSubmission()); if (stopped) return stopped;
    } else if (!hooks.dispatch && state.stage === 'SERVER' &&
        (state.submission_id && state.verdict || ['DISPROOF_REJECTED', 'REJECTED'].includes(state.status))) {
      const stopped = await retry(json(state.verdict ?? state.submission_error)); if (stopped) return stopped;
    }
    async function detachWorkspace() {
      if (!workspace) return;
      if (hooks.releaseWorkspace) await hooks.releaseWorkspace(workspace, options);
      else if (!hooks.workspace) await dependencies.releaseWorkspace(workspace, options);
      workspace = undefined; knownDependencies = undefined; readyAttempt = 0;
      delete state.workspace_id;
    }
    const assertModelSlot = () => {
      if (state.stage !== 'CODEX' || state.dispatch_state !== 'RUNNING') throw new JobPersistenceError('Model invocation outside a running Codex action');
      if (hooks.dispatch && !hooks.assertModelSlot) throw new JobPersistenceError('Missing Codex dispatch slot assertion');
      hooks.assertModelSlot?.();
      if (quota.waiting) throw new CodexQuotaError('Codex invocation deferred while the shared quota is exhausted');
    };
    const stages = createJobStages({ client, target, context, environment,
      options: { ...options, assertModelSlot }, dir, hooks: { ...hooks, assertModelSlot }, ...dependencies });
    async function prepare() {
      if (workspace) return;
      // Workspace reconstruction must not erase the saved logical stage.
      const savedStage = state.resume_after_prepare?.stage ?? state.stage;
      const savedOperation = state.resume_after_prepare?.operation ?? state.operation;
      if (hooks.dispatch) {
        state.resume_after_prepare = { stage: savedStage, operation: savedOperation };
        await transition('PREPARE', 'reconstruct');
        await dispatch();
      }
      state.preparation_running = true; await persist();
      ({ workspace, knownDependencies } = await stages.prepare());
      knownDependencies.push(...state.published_dependencies ?? []);
      if (state.previous_candidate) {
        let previous;
        try { previous = JSON.parse(await readFile(state.previous_candidate.path, 'utf8')); }
        catch (error) {
          if (error.code !== 'ENOENT') throw new JobPersistenceError(`Cannot read saved repair candidate: ${error.message}`);
          state.unavailable_candidates ??= [];
          state.unavailable_candidates.push(state.previous_candidate);
          state.feedback = `Previous candidate file is missing; reconstruct the proof from the current statement and diagnostics.\n${state.feedback ?? ''}`;
          delete state.previous_candidate; await persist();
        }
        if (previous) {
          if (previous.source_hash !== state.previous_candidate.source_hash ||
              previous.source !== null && digest(previous.source) !== previous.source_hash) throw new JobPersistenceError('Saved repair candidate changed');
          if (previous.source !== null) await restore(previous.candidate, previous.source);
        }
      }
      if (state.codex_partial) {
        const source = await readFile(state.codex_partial.path, 'utf8');
        if (digest(source) !== state.codex_partial.source_hash) throw new JobPersistenceError('Saved quota partial proof changed');
        await restore({ module: state.codex_partial.module }, source);
      }
      state.workspace_id = workspace; state.preparation_running = false;
      if (hooks.dispatch && (savedStage === 'PREPARE' || savedStage === 'CODEX' && savedOperation !== 'format_repair')) {
        await (hooks.preflight ?? dependencies.prepareAgentEnvironment)(target, workspace, dir,
          { ...options, environmentAttempt: state.attempt_count + 1 });
        readyAttempt = state.attempt_count + 1;
      }
      delete state.resume_after_prepare;
      await transition(savedStage === 'PREPARE' ? 'CODEX' : savedStage, savedStage === 'PREPARE' ? 'implement' : savedOperation);
    }
    async function readiness() {
      if (!hooks.dispatch || readyAttempt === state.attempt_count + 1) return;
      const operation = state.operation;
      state.resume_after_prepare = { stage: 'CODEX', operation };
      await transition('PREPARE', 'readiness');
      await dispatch();
      await (hooks.preflight ?? dependencies.prepareAgentEnvironment)(target, workspace, dir,
        { ...options, environmentAttempt: state.attempt_count + 1 });
      readyAttempt = state.attempt_count + 1;
      delete state.resume_after_prepare;
      await transition('CODEX', operation);
    }
    async function restore(candidate, source) {
      if (!/^Solutions\.[A-Za-z_][A-Za-z0-9_]*$/.test(candidate.module)) throw new Error('Invalid saved solution module');
      candidate.solution = join(workspace, candidate.module.replaceAll('.', '/') + '.lean');
      await writeIfChanged(candidate.solution, source);
      if (state.sketch?.module === candidate.module) state.sketch.solution = candidate.solution;
      if (state.counterexample?.module === candidate.module) state.counterexample.solution = candidate.solution;
      await persist();
    }
    async function saveCandidate(candidate, attempt, suffix = '') {
      let source = null;
      if (candidate.solution) {
        try { source = await readFile(candidate.solution, 'utf8'); }
        catch (error) {
          // An honest incomplete answer need not contain a Lean artifact.
          // Preserve its mathematical outcome so backoff/escalation can see it.
          if (error.code !== 'ENOENT' || candidate.ready !== false || candidate.kind === 'counterexample') throw error;
        }
      }
      const path = join(dir, `candidate-${attempt}${suffix}.json`);
      // Save prose separately so compact handoffs survive large Lean snapshots.
      // Commit both artifacts before publishing their durable state reference.
      const explanationPath = typeof candidate.explanation === 'string'
        ? join(dir, `candidate-${attempt}${suffix}-explanation.md`) : undefined;
      if (explanationPath) await writeFile(explanationPath, candidate.explanation);
      const record = { candidate, source, source_hash: source === null ? null : digest(source), attempt, attempt_id: state.attempt_id,
        prompt_experiment: state.prompt_experiment, explanation_path: explanationPath };
      await save(path, record);
      state.candidate = { path, source_hash: record.source_hash, attempt, explanation_path: explanationPath };
      state.candidate_kind = candidate.kind ?? 'proof';
      await transition('VALIDATE', 'validate');
    }
    async function loadCandidate() {
      const saved = JSON.parse(await readFile(state.candidate.path, 'utf8'));
      state.candidate_kind = saved.candidate.kind ?? 'proof';
      if (saved.source_hash !== state.candidate.source_hash || saved.source !== null && digest(saved.source) !== saved.source_hash) {
        throw new JobPersistenceError('Saved candidate artifact changed');
      }
      if (saved.source !== null) await restore(saved.candidate, saved.source);
      return saved;
    }
    try {
      // Restarted artifacts must pass the fresh workspace/dependency checks
      // before an as-yet unissued upload. Pending/unknown POSTs bypass this path.
      if (!serverOnly(options) && state.stage === 'SERVER' && state.operation === 'submit' && state.artifact_manifest && !uncertain.has(state.status)) {
        const artifact = state.artifact_manifest;
        if (digest(artifact.source) !== artifact.source_hash || digest(artifact.explanation) !== artifact.explanation_hash ||
            digest(await readFile(artifact.snapshot, 'utf8')) !== artifact.source_hash) {
          throw new JobPersistenceError('Saved validated artifact changed');
        }
        if (state.plan?.kind === 'sketch') await transition('VALIDATE', 'validate_published');
        else await transition('VALIDATE', 'validate');
      }
      // Legacy remote evidence may be recovered, but never grants model budget.
      if (state.legacy_budget_unknown && remoteStatuses.has(state.status) && !state.candidate && !state.artifact_manifest) {
        await prepare();
        if (state.status === 'COUNTEREXAMPLE') {
          const saved = state.counterexample, source = await readFile(saved.snapshot, 'utf8');
          if (saved.target_hash !== targetFingerprint(target) || digest(source) !== saved.source_hash) {
            state.feedback = 'The target or Lean environment changed; reassess the earlier counterexample against the current statement.';
            return finish('READY');
          }
          await restore(saved, source);
          await saveCandidate({ ...saved, kind: 'counterexample', ready: false, children: [], definitions: [], explanation: state.feedback }, saved.attempt);
        } else if (state.sketch) {
          await restore(state.sketch, state.sketch.source);
          await saveCandidate(state.sketch, state.sketch.attempt);
        } else throw new Error('Missing saved decomposition for pending publication');
      }
      for (;;) {
        options.signal?.throwIfAborted();
        if (state.stage === 'PREPARE') { await prepare(); continue; }
        if (state.stage === 'CODEX') {
          if (state.operation === 'format_repair' && state.format_repair_input) {
            await prepare(); await dispatch();
            await waitForQuota();
            await hooks.beforeModel?.();
            await transition('CODEX', 'format_repair', 'RUNNING');
            if (state.retirement_requested) throw new RetiredJob('Retired before formatting invocation');
            const probeToken = quota.probeToken;
            try {
              const input = state.format_repair_input;
              await restore(input.candidate, input.source);
              await hooks.awaitModelDispatch?.(state, persist);
              const repaired = await stages.invokeModel({ workspace, attempt: input.attempt, operation: 'format_repair', ...input });
              await quota.succeeded(probeToken);
              delete state.codex_quota_wait;
              delete state.format_repair_input;
              await saveCandidate(repaired.candidate, input.attempt, '-formatted');
            } catch (error) {
              if (options.signal?.aborted || error instanceof JobPersistenceError || error instanceof RetiredJob) throw error;
              if (error instanceof AgentsStopped) { await parkStoppedAgent(); continue; }
              if (error instanceof ProofStoragePaused) { await parkStorageDispatch(); continue; }
              if (isCodexQuotaError(error)) { await parkQuota(error); continue; }
              await quota.inconclusive(probeToken, error);
              delete state.format_repair_input;
              const stopped = await retry(error.message, error.failure?.category ?? 'artifact_error'); if (stopped) return stopped;
            }
            continue;
          }
          await prepare();
          await readiness(); await dispatch();
          await waitForQuota();
          const resuming = !!(state.codex_quota_wait || state.operator_dispatch_wait);
          const attempt = state.attempt_count + (resuming ? 0 : 1), jobAttempt = state.attempts_used_in_job + 1;
          if (!hooks.dispatch) await (hooks.preflight ?? dependencies.prepareAgentEnvironment)(target, workspace, dir, { ...options, environmentAttempt: attempt });
          const fresh = await client.request(`theorems/${enc(id)}`);
          if (fresh.status !== 'Open' || fresh.deprecated_at) return finish(`SKIPPED (${fresh.status})`);
          if (targetFingerprint(fresh) !== targetFingerprint(target)) throw new Error('Target changed; rerun discovery');
          if (await hooks.beforeModel?.() === false) return finish('READY');
          // A quota pause preserves the attempt and partial work, but model
          // selection still belongs to the current run configuration.
          const profile = attemptModel(attempt, options, state);
          const { model, reasoningEffort } = profile;
          const operation = resuming ? state.operation : state.selection?.operation ?? operationFor(state);
          const contextPath = join(dir, `attempt-context-${attempt}.json`);
          const workerContextPath = join(dir, `worker-context-${attempt}.json`);
          if (!resuming) {
            const promptExperiment = selectPrompt({ ...options, promptVariant: hooks.promptVariant?.() ?? options.promptVariant });
            const counts = reduceHistory(state);
            const reductions = context.decompositions?.decompositions ?? state.selection?.reductions ?? [];
            const dependencyEvidence = [];
            for (const child of reductions.flatMap(r => r.children ?? [])) {
              const childId = child.theorem_id ?? child.definition_id;
              const saved = child.theorem_id ? await store.read(childId) : null;
              dependencyEvidence.push({ ...child, state_path: child.theorem_id ? store.path(childId) : undefined,
                certificate: saved?.counterexample, verdict: saved?.verdict, artifacts: saved?.artifact_manifest,
                evidence_status: saved?.status === 'DISPROVED' ? 'server_accepted' : saved?.counterexample ? 'historical_local_certificate' : 'live_status_only' });
            }
            const acceptedReductions = [];
            if (operation === 'reconsider_reduction') for (const reduction of reductions.filter(r => r.submission_id != null)) {
              const path = join(dir, `reduction-${enc(reduction.submission_id)}.json`);
              let saved = await readJson(path);
              if (!saved) {
                const solution = await client.request(`submissions/${enc(reduction.submission_id)}/solution`);
                saved = { reduction, solution }; await save(path, saved);
              }
              acceptedReductions.push({ submission_id: reduction.submission_id, path });
            }
            // Fetch a bounded source set in the runner, before the proof invocation.
            // Sources are immutable per submission; failures remain advisory gaps.
            const previousSubmissionSources = [];
            for (const submission of (context.previous_submissions ?? [])
              .filter(row => ['ACCEPTED', 'SKETCH_ACCEPTED'].includes(row.status) && !row.deprecated_at).slice(0, 3)) {
              const submissionId = submission.id ?? submission.submission_id;
              if (!submissionId) continue;
              const existing = acceptedReductions.find(row => row.submission_id === submissionId);
              if (existing) { previousSubmissionSources.push(existing); continue; }
              const path = join(dir, `submission-${enc(submissionId)}.json`);
              try {
                let saved = await readJson(path);
                if (saved?.submission_id !== submissionId || saved.mathlib_rev !== environment.mathlib_rev ||
                    typeof saved.solution?.content !== 'string') {
                  const solution = await client.request(`submissions/${enc(submissionId)}/solution`);
                  if (typeof solution?.content !== 'string') throw new Error('Submission source response has no Lean content');
                  saved = { submission_id: submissionId, mathlib_rev: environment.mathlib_rev, solution };
                  await save(path, saved);
                }
                previousSubmissionSources.push({ submission_id: submissionId, path });
              } catch (error) {
                options.signal?.throwIfAborted();
                previousSubmissionSources.push({ submission_id: submissionId, error: String(error.message).slice(0, 1000) });
              }
            }
            let missionResearch = null;
            try {
              missionResearch = await snapshotMissionResearch(options.runs, state.root_id ?? options.rootId,
                options.missionResearchEpoch, join(dir, `research-${attempt}`));
            } catch (error) {
              options.signal?.throwIfAborted();
              progress(`[${id}] Mission research unavailable; continuing proof attempt: ${error.message}`);
            }
            const manifest = { ...context, target, environment, selection: state.selection, operation,
              prompt_experiment: promptExperiment,
              mission_research: missionResearch, escalation: profile.escalation,
              context_id: state.context_id, total_attempts: counts.totalAttempts, current_context_attempts: counts.attemptsInCurrentContext,
              legacy_baseline: state.legacy_baseline, history: state.history,
              previous_candidate: state.previous_candidate, accepted_sketch: state.sketch,
              accepted_reductions: acceptedReductions, previous_submission_sources: previousSubmissionSources,
              dependency_evidence: dependencyEvidence,
              published_dependencies: state.published_dependencies, publication_journals: state.publications,
              allowed_direct_proof_imports: (context.decompositions?.decompositions ?? []).flatMap(r => r.children ?? [])
                .filter(c => c.status === 'Proved' && !c.deprecated_at) };
            await save(contextPath, manifest);
            await save(workerContextPath, await workerContext(manifest, { dir, attempt, feedback: state.feedback, auditPath: contextPath }));
            Object.assign(state, { attempt_count: attempt, attempts_used_in_job: jobAttempt, attempt_id: randomUUID(), model,
              prompt_experiment: promptExperiment,
              reasoning_effort: reasoningEffort, model_profile: profile.modelProfile, escalation: profile.escalation,
              format_repair_used: false, operation, dispatch_state: 'RUNNING' });
            delete state.candidate_kind;
            state.attempts_by_model[model] = (state.attempts_by_model[model] ?? 0) + 1;
            appendEvent(state, { event_id: `${state.attempt_id}:started`, event_type: 'attempt', attempt,
              root_id: state.root_id ?? options.rootId, run_id: state.run_id ?? options.runId,
              attempt_id: state.attempt_id, result: 'started', context_id: manifest.context_id,
              prompt_experiment: promptExperiment, prompt_path: join(dir, `prompt-${attempt}.txt`),
              prompt_metadata_path: join(dir, `prompt-${attempt}.json`),
              model, reasoning_effort: reasoningEffort, model_profile: profile.modelProfile, escalation: profile.escalation, operation,
              reason: state.selection?.selection_reason, context_path: contextPath, worker_context_path: workerContextPath,
              target_fingerprint: state.target_fingerprint, environment_fingerprint: state.environment_fingerprint });
          } else Object.assign(state, { model, reasoning_effort: reasoningEffort,
            model_profile: profile.modelProfile, escalation: profile.escalation, dispatch_state: 'RUNNING' });
          if (profile.escalation) progress(`[${id}] Repeated incomplete arguments: ${profile.modelProfile} (${reasoningEffort}); reassessing proof/disproof routes after attempt ${profile.escalation.trigger_attempt}`);
          await persist();
          if (state.retirement_requested) throw new RetiredJob('Retired before model invocation');
          let probeToken = null;
          try {
            await waitForQuota();
            if (state.dispatch_state !== 'RUNNING') await transition('CODEX', state.operation, 'RUNNING');
            probeToken = quota.probeToken;
            const feedback = (state.feedback ?? '') + (state.codex_quota_wait ? '\nThe previous invocation stopped at a Codex quota limit. Continue the same attempt using the saved partial solution, if present.' : '');
            await hooks.awaitModelDispatch?.(state, persist);
            const { candidate } = await stages.invokeModel({ workspace, attempt, feedback, operation: state.operation,
              attemptOptions: { ...options, assertModelSlot, environmentReady: true,
                model, reasoningEffort, operation, escalation: profile.escalation, attemptContextPath: contextPath,
                promptExperiment: state.prompt_experiment,
                workerContextPath: await exists(workerContextPath) ? workerContextPath : undefined, repairPrevious: false } });
            await quota.succeeded(probeToken);
            delete state.codex_quota_wait; delete state.codex_partial;
            await saveCandidate(candidate, attempt);
          } catch (error) {
            if (options.signal?.aborted || error instanceof JobPersistenceError || error instanceof RetiredJob) throw error;
            if (error instanceof AgentsStopped) { await parkStoppedAgent(); continue; }
            if (error instanceof ProofStoragePaused) { await parkStorageDispatch(); continue; }
            if (isCodexQuotaError(error)) { await parkQuota(error); continue; }
            await quota.inconclusive(probeToken, error);
            // The exception already identifies the process/log. Keep the raw
            // transcript for targeted debugging rather than injecting it again.
            const stopped = await retry(error.message); if (stopped) return stopped;
          }
          continue;
        }
        if (state.stage === 'VALIDATE') {
          // A server-only sketch resumes this legacy handoff without acquiring
          // a workspace. Publication already checked fresh declaration details.
          if (serverOnly(options) && state.operation === 'validate_published') {
            state.status = 'PREPARED'; await transition('SERVER', 'submit'); continue;
          }
          await prepare();
          await dispatch();
          await transition('VALIDATE', state.operation, 'RUNNING');
          try {
            if (state.operation === 'validate_published') {
              const artifact = state.artifact_manifest;
              await restore(artifact.candidate, artifact.source);
              await stages.validatePublished({ workspace, knownDependencies, artifact, plan: state.plan });
              state.status = 'PREPARED'; await transition('SERVER', 'submit'); continue;
            }
            const saved = await loadCandidate();
            let outcome = await stages.validate({ workspace, knownDependencies, candidate: saved.candidate, attempt: saved.attempt,
              promptExperiment: saved.prompt_experiment });
            if (outcome.type === 'INCOMPLETE') {
              const evidence = incompleteEvidence(saved.candidate, saved.source_hash, state.model, saved.source);
              const stopped = await retry(outcome.feedback, 'incomplete_argument', 'incomplete', evidence);
              if (stopped) return stopped;
              continue;
            }
            if (outcome.type === 'SKIPPED') return finish(outcome.status);
            if (outcome.type === 'NEEDS_FORMAT_REPAIR') {
              if (state.format_repair_used) throw outcome.error;
              state.format_repair_used = true;
              state.format_repair_input = { candidate: outcome.candidate, source: outcome.source,
                feedback: outcome.feedback, attempt: saved.attempt };
              await transition('CODEX', 'format_repair'); continue;
            }
            state.artifact_manifest = structuredClone(outcome.artifact); state.plan = outcome.plan;
            if (outcome.artifact.kind === 'counterexample') {
              const artifact = outcome.artifact;
              state.status = 'COUNTEREXAMPLE'; state.counterexample = { attempt: artifact.attempt, target_hash: artifact.target_hash,
                source_hash: artifact.source_hash, explanation_hash: artifact.explanation_hash, snapshot: artifact.snapshot,
                explanation: artifact.explanation_path, solution: artifact.candidate.solution, module: artifact.candidate.module };
            } else if (outcome.plan.kind === 'sketch') {
              state.sketch = { ...outcome.artifact.candidate, attempt: saved.attempt, source: outcome.artifact.source };
              await save(join(dir, `decomposition-${saved.attempt}.json`), { children: outcome.plan.children, definitions: outcome.plan.definitions });
            }
            await transition('SERVER', outcome.plan?.kind === 'sketch' ? 'publish' : 'submit');
          } catch (error) {
            if (options.signal?.aborted || error instanceof JobPersistenceError || error instanceof RetiredJob) throw error;
            if (transientReadError(error)) throw error;
            const stopped = await retry(state.legacy_budget_unknown && state.status === 'COUNTEREXAMPLE'
              ? `Saved counterexample no longer verifies: ${error.message}` : error.message, error.failure?.category ?? 'artifact_error');
            if (stopped) return stopped;
          }
          continue;
        }
        if (state.stage === 'SERVER') {
          // Reconstruct before taking a server permit. Polls and reconciliation
          // need only their journals; they never build or invoke a model.
          if (!serverOnly(options) && state.operation === 'submit' && !uncertain.has(state.status)) await prepare();
          await dispatch();
          await transition('SERVER', state.operation, 'RUNNING');
          try {
            if (hooks.dispatch && ['SUBMITTING', 'SUBMISSION_UNKNOWN'].includes(state.status)) {
              const stopped = await remoteResult(await remote.recoverSubmission());
              if (stopped) return stopped; continue;
            }
            if (hooks.dispatch && (state.status === 'PENDING' || state.operation === 'poll_submission')) {
              const stopped = await remoteResult(await remote.pollSubmission());
              if (stopped) return stopped; continue;
            }
            if (hooks.dispatch && (state.submission_id && state.verdict || ['DISPROOF_REJECTED', 'REJECTED'].includes(state.status))) {
              const stopped = await retry(json(state.verdict ?? state.submission_error)); if (stopped) return stopped;
              continue;
            }
            if (state.operation === 'publish') {
              const published = await remote.publish(state.plan);
              if (published.type === 'TARGET_OBSOLETE') return remoteResult(published);
              if (published.type === 'REMOTE_RESULT') {
                await transition('SERVER', 'publish', 'DELAYED');
                if (hooks.dispatch) continue;
                return published.status;
              }
              state.published_dependencies = published.rows;
              if (serverOnly(options)) {
                state.status = 'PUBLICATIONS_READY'; await persist();
                await transition('SERVER', 'submit'); continue;
              }
              if (hooks.dispatch) knownDependencies?.push(...published.rows);
              else { await prepare(); knownDependencies.push(...published.rows); }
              state.status = 'PUBLICATIONS_READY'; await transition('VALIDATE', 'validate_published'); continue;
            }
            if (state.operation !== 'submit') throw new Error(`Invalid serial server operation: ${state.operation}`);
            if (!serverOnly(options)) await prepare();
            const artifact = state.artifact_manifest;
            if (digest(artifact.source) !== artifact.source_hash || digest(await readFile(artifact.snapshot, 'utf8')) !== artifact.source_hash ||
                digest(artifact.explanation) !== artifact.explanation_hash ||
                digest(await readFile(artifact.explanation_path, 'utf8')) !== artifact.explanation_hash) {
              throw new JobPersistenceError('Saved validated artifact changed');
            }
            if (!serverOnly(options)) await restore(artifact.candidate, artifact.source);
            const skipped = await stages.checkSubmission(artifact, state.published_dependencies, state.prompt_experiment); if (skipped) return finish(skipped.status);
            const stopped = await remoteResult(await remote.submit(artifact, artifact.kind === 'counterexample' ? 'disprove' : 'prove'));
            if (stopped) return stopped;
          } catch (error) {
            if (uncertain.has(state.status) || options.signal?.aborted || error instanceof JobPersistenceError || error instanceof RetiredJob) throw error;
            if ([401, 429].includes(error.status)) {
              state.next_poll_at = new Date(now() + recovery.initialDelayMs).toISOString();
              state.infrastructure_wait = error.message;
              state.status = state.artifact_manifest ? 'PUBLICATIONS_READY' : state.status;
              await transition('SERVER', state.operation, 'DELAYED');
              if (hooks.dispatch) continue;
              return 'API_WAIT';
            }
            if (transientReadError(error)) throw error;
            if (error.infrastructure) {
              state.infrastructure_wait = error.message;
              state.next_poll_at = new Date(Date.now() + (options.refreshInterval ?? 30) * 1000).toISOString();
              await transition('SERVER', state.operation, 'DELAYED');
              if (hooks.dispatch) continue;
              return 'PUBLISH_PENDING';
            }
            const stopped = await retry(state.submission_error ? json(state.submission_error) : error.message, error.failure?.category); if (stopped) return stopped;
          }
          continue;
        }
        throw new JobPersistenceError(`Invalid job stage: ${state.stage}`);
      }
    } catch (error) {
      if (options.signal?.aborted && state.stage === 'CODEX' && state.dispatch_state === 'RUNNING') {
        // The model/process supervisor has finished draining. A durable candidate
        // already handed to VALIDATE follows recovery instead of interruption.
        const diagnostic = join(dir, `failure-${state.attempt_count}.json`);
        await save(diagnostic, { feedback: error.message });
        await outcome('interrupted', failureFor({ origin: 'model', category: 'interrupted', diagnostic_path: diagnostic }));
        if (!await store.replace(state, state.revision, { allowRetirement: !!hooks.dispatch })) {
          throw new JobPersistenceError('Cannot persist interrupted invocation');
        }
      }
      throw error;
    } finally {
      await detachWorkspace();
    }
  });
}
