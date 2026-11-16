import { pipelineLimits } from './pipeline-config.mjs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { JobStore, JobPersistenceError, transaction } from './job-store.mjs';
import { PublicationStore } from './publication-store.mjs';
import { RetiredJob } from './serial-jobs.mjs';
import { WorkSelection, retryFrontierError, retryGraphRefreshError } from './work-selection.mjs';
import { save, sleep, progress } from './runner-state.mjs';
import { workFrontier, scoreWork, escalationBlocker } from './work-policy.mjs';
import { serverOnly, verificationMode } from './verification-mode.mjs';
import { attemptModel, modelProfile, isSolModel } from './model-policy.mjs';
import { CodexQuota, QUOTA_CHECK_INTERVAL, isCodexQuotaError } from './codex-quota.mjs';
import { codexSandboxRecovery } from './codex-sandbox-recovery.mjs';
import { MissionResearch } from './mission-research.mjs';
import { recoveryPolicy, rememberFailure } from './recovery-policy.mjs';
import { MissionCommands } from './mission-control-commands.mjs';
import { AgentsStopped } from './agent-control.mjs';
import { ProofStorageRecovery, ProofStoragePaused, proofStorageFailure, parkProofStorageFailure, storageFailureMatches } from './proof-storage-recovery.mjs';

const stages = ['PREPARE', 'CODEX', 'VALIDATE', 'SERVER'];
const issued = state => ['SUBMITTING', 'SUBMISSION_UNKNOWN', 'PENDING', 'PUBLISHING',
  'PUBLISH_UNKNOWN', 'PUBLISH_PENDING'].includes(state.status);
const sequence = (a, b) => (a.enqueue_sequence ?? 0) - (b.enqueue_sequence ?? 0);
const due = state => Date.parse(state.next_poll_at ?? '') || 0;

export function neededTheorems(graph) {
  return workFrontier(graph).needed;
}

export { pipelineLimits } from './pipeline-config.mjs';

// Four indexes over the canonical jobs, plus live continuations. A continuation
// parks at a handoff without owning a worker; it is never another runnable queue.
export class Pipeline {
  constructor(client, target, options, hooks = {}) {
    this.client = client; this.target = target; this.options = options; this.hooks = hooks;
    this.options.runtimeSettings = {};
    this.options.pipeline ??= {};
    this.limits = pipelineLimits(options.pipeline);
    if (options.model) this.limits.attemptModels = [options.model];
    this.store = new JobStore(options.runs, { cacheIndex: true }); this.selection = new WorkSelection(options);
    this.controls = new Map(); this.results = new Map(); this.runId = randomUUID();
    this.startedAt = new Date().toISOString();
    this.operator = new MissionCommands(this);
    this.agentInvocations = new Set();
    this.startupAttention = new Set();
    this.visits = 0; this.visited = new Set(); this.stopping = false;
    this.controller = new AbortController();
    this.signal = options.signal ? AbortSignal.any([options.signal, this.controller.signal]) : this.controller.signal;
    this.refreshAt = 0; this.refreshRetryAt = 0;
    this.refreshDelay = (options.refreshInterval ?? 30) * 1000;
    this.graphRefreshDelay = (options.graphRefreshInterval ?? 600) * 1000;
    this.lowWorkRefreshAt = 0; this.refreshPending = false;
    this.now = hooks.now ?? Date.now;
    this.recoveryPolicy = recoveryPolicy(options);
    this.research = new MissionResearch(options.runs, target.root, { every: this.limits.missionReviewEvery,
      model: this.limits.missionReviewModel, now: this.now });
    this.quota = new CodexQuota(options.runs, { readLimits: hooks.readCodexRateLimits, now: this.now, signal: this.signal });
    this.epoch = 0;
    this.wake = () => { this.epoch++; this.waker?.(); this.waker = null; };
    this.proofStorageRecovery = new ProofStorageRecovery(this.wake);
  }
  counts(index) {
    const active = [...index.values()].filter(s => s.job_status === 'ACTIVE');
    const queues = Object.fromEntries(stages.map(stage => [stage, { queued: 0, running: 0, reserved: 0, delayed: 0 }]));
    for (const control of this.controls.values()) if (control.running) queues[control.running].running++;
    if (this.reviewModelActive) queues.CODEX.running++;
    for (const state of active) {
      const running = this.controls.get(state.theorem_id)?.running;
      if (!running && state.dispatch_state !== 'HANDOFF_PENDING') {
        queues[state.stage].queued++;
        if (state.dispatch_state === 'DELAYED') queues[state.stage].delayed++;
      }
      if (state.stage === 'PREPARE' && state.dispatch_state !== 'HANDOFF_PENDING') queues.CODEX.reserved++;
    }
    const remote = active.filter(s => this.isRemote(s)).length;
    return { active: active.length, localActive: active.length - remote, remoteActive: remote, queues,
      handoffs: active.filter(s => s.dispatch_state === 'HANDOFF_PENDING').length,
      attention: [...index.values()].filter(s => s.job_status === 'NEEDS_ATTENTION').length };
  }
  get modelDispatchPaused() {
    return this.operator.state.dispatchPaused || this.operator.state.agentsStopped;
  }
  async invokeAgent(action, signal) {
    if (this.operator.state.agentsStopped) throw new AgentsStopped();
    const controller = new AbortController();
    const invocationSignal = AbortSignal.any([signal, controller.signal]);
    let finish;
    const invocation = { controller, stopped: new Promise(resolve => { finish = resolve; }) };
    this.agentInvocations.add(invocation);
    try {
      invocationSignal.throwIfAborted();
      const result = await action(invocationSignal);
      invocationSignal.throwIfAborted();
      return result;
    } catch (error) {
      if (controller.signal.aborted) throw controller.signal.reason;
      throw error;
    } finally { this.agentInvocations.delete(invocation); finish(); }
  }
  async stopAgents() {
    const invocations = [...this.agentInvocations];
    for (const invocation of invocations) invocation.controller.abort(new AgentsStopped());
    await Promise.all(invocations.map(invocation => invocation.stopped));
    this.wake();
  }
  isRemote(state) {
    return this.isServerOnlyJob(state) && state.stage === 'SERVER';
  }
  isVerdictPoll(state) {
    const since = Date.parse(state.submission_started_at ?? state.verdict?.created_at ?? '');
    return state.stage === 'SERVER' && state.status === 'PENDING' && state.operation === 'poll_submission' &&
      (!Number.isFinite(since) || this.now() - since < this.recoveryPolicy.pendingTimeoutMs);
  }
  dispatchModel(state) {
    return state.operation === 'format_repair' ? 'gpt-6-luna' :
      attemptModel(Math.max(1, (state.attempt_count ?? 0) + (state.codex_quota_wait || state.operator_dispatch_wait ? 0 : 1)), this.options, state).model;
  }
  solRunning(except) {
    return [...this.controls.entries()].filter(([id, c]) => id !== except && c.running === 'CODEX' && isSolModel(c.model)).length +
      Number(!!this.reviewModelActive && isSolModel(modelProfile(this.limits.missionReviewModel).model));
  }
  isServerOnlyJob(state) {
    return serverOnly({ verificationMode: state.verification_mode ?? verificationMode(this.options) });
  }
  fits(stage, index, incoming = 1, state) {
    const counts = this.counts(index);
    if (stage === 'SERVER' && (state ? this.isServerOnlyJob(state) : serverOnly(this.options))) {
      // Same-stage polls use an existing slot. Lowered restart limits drain
      // saved jobs; they must never strand already issued requests or repairs.
      return incoming === 0 || state && counts.active > this.limits.maxRemoteJobs || counts.remoteActive + incoming <= this.limits.maxRemoteJobs;
    }
    const q = counts.queues[stage];
    if (q.queued + q.reserved + incoming > this.limits.queues[stage].maxSize) return false;
    if (stage === 'PREPARE') {
      const codex = counts.queues.CODEX;
      if (codex.queued + codex.reserved + incoming > this.limits.queues.CODEX.maxSize) return false;
    }
    return true;
  }
  logQueueMove(state, from, index) {
    if (from === state.stage) return;
    const counts = this.counts(index);
    const queues = stages.map(stage => {
      const q = counts.queues[stage];
      return `${stage}=${q.queued + q.running} (${q.queued} queued, ${q.running} running, ${q.delayed} delayed, ${q.reserved} reserved)`;
    }).join('; ');
    progress(`[${state.theorem_id}] queue ${from} -> ${state.stage} (${state.operation}); ${queues}; handoffs=${counts.handoffs}`);
  }
  canAdmit(index) {
    const counts = this.counts(index);
    return !this.stopping && !this.operator.state.admissionPaused && !this.proofStorageRecovery.waiting && !this.signal.aborted && !this.client.recovery?.state?.waiting &&
      counts.localActive < this.limits.maxActiveJobs &&
      // Reserve a remote slot for each admitted local job. This prevents a
      // full remote pool and outgoing local handoffs from blocking repairs.
      (!serverOnly(this.options) || counts.active < this.limits.maxRemoteJobs) &&
      stages.every(s => serverOnly(this.options) && s === 'SERVER' || counts.queues[s].queued + counts.queues[s].reserved <= this.limits.queues[s].maxSize) &&
      this.fits('PREPARE', index);
  }
  async requestRefresh(reason) {
    // Defer invalidation until discovery actually starts. Jobs may keep using
    // the committed snapshot while outcomes accumulate behind the throttle.
    this.refreshPending = true; this.refreshReason = reason; this.wake();
  }
  lowWork(index) {
    return this.selection.graph?.root.status === 'Open' &&
      !this.counts(index).active && !this.selection.updates.some(e => e.pending) &&
      !scoreWork(this.selection.graph, index, this.now(), this.options).some(s => !this.controls.has(s.theorem_id));
  }
  graphDue(index) {
    if (this.refreshRetryAt) return this.refreshRetryAt;
    if (!this.selection.graph || this.selection.requestedGeneration !== this.selection.committedGeneration) return this.now();
    // An unchanged small/empty frontier still polls with a delay; it must not
    // turn the low-work exception into an unbounded discovery loop.
    return Math.min(this.refreshAt, this.lowWork(index)
      ? this.refreshPending ? this.now() : this.lowWorkRefreshAt : Infinity);
  }
  async checkpoint(status = 'RUNNING', error) {
    const index = await this.store.index({ readOnly: true }), counts = this.counts(index);
    const waiting = [...index.values()].filter(s => s.job_status === 'ACTIVE' && !this.controls.get(s.theorem_id)?.running);
    const environmentWait = [...index.values()].find(s => s.job_status === 'ACTIVE' && s.stage === 'PREPARE' &&
      /Codex environment is not ready/.test(s.infrastructure_wait ?? ''));
    const needed = this.selection.graph ? neededTheorems(this.selection.graph) : new Set([this.target.root]);
    const retrying = [...index.values()].filter(s => needed.has(s.theorem_id) && s.job_status === 'READY' &&
      s.recovery_failure && s.recovery_failure.message !== 'incomplete_argument' && Date.parse(s.retry_after ?? '') > this.now())
      .sort((a, b) => Date.parse(a.retry_after) - Date.parse(b.retry_after));
    const nextRetry = retrying[0];
    const operatorPauses = [
      this.operator.state.admissionPaused && 'New theorem admission paused by operator',
      this.operator.state.dispatchPaused && 'Codex dispatch paused by operator',
      this.operator.state.agentsStopped && 'Agents stopped by operator',
    ].filter(Boolean).join('; ');
    const waitingReason = operatorPauses
      ? operatorPauses + (this.proofStorageRecovery.waiting ? '; proof storage recovery also active' : '')
      : this.pauseReason === 'local active-job capacity full' && !counts.queues.CODEX.running && environmentWait
        ? `Waiting for Codex environment recovery: ${environmentWait.infrastructure_wait}`
        : !counts.active && nextRetry
          ? `Waiting to retry ${nextRetry.recovery_failure.stage ?? 'job'} after failure at ${nextRetry.retry_after}: ${nextRetry.recovery_failure.message}`
          : this.pauseReason;
    const summary = { target: this.target, run_id: this.runId, started_at: this.startedAt,
      runner_pid: process.pid, config_path: this.options.configPath, operator: this.operator.snapshot(),
      live_workers: [...this.controls.entries()].filter(([, c]) => c.running).map(([theorem_id, c]) => ({ theorem_id, stage: c.running, model: c.model,
        preparation: c.running === 'PREPARE' ? c.preparation : undefined })),
      root_confirmed: this.selection.rootConfirmed, status, completed: status === 'COMPLETE',
      root_status: this.selection.graph?.root.status, visits: this.visits, results: [...this.results.values()],
      ready_work: this.selection.graph ? scoreWork(this.selection.graph, index, this.now(), this.options).map(({ projected_state, ...work }) => work) : [],
      pending_external_actions: [...index.values()].filter(issued).map(s => ({ theorem_id: s.theorem_id, status: s.status, submission_id: s.submission_id })),
      waiting_for_dependencies: [...index.values()].filter(s => s.status === 'SKETCH_ACCEPTED' && s.job_status === 'DONE').map(s => s.theorem_id),
      pipeline: counts, limits: this.limits, codex_permits_used: counts.queues.CODEX.running,
      server_actions_running: [...this.controls.values()].filter(c => c.running === 'SERVER' && !c.polling).length,
      verdict_polls_running: [...this.controls.values()].filter(c => c.running === 'SERVER' && c.polling).length,
      verdict_poll_capacity: Math.max(1, this.limits.apiConcurrency - this.limits.queues.SERVER.concurrency - 1),
      sol_permits_used: this.solRunning(), sol_permits_available: Math.max(0, 1 - this.solRunning()),
      sol_waiting: [...index.values()].filter(s => s.job_status === 'ACTIVE' && s.stage === 'CODEX' &&
        !this.controls.get(s.theorem_id)?.running && isSolModel(this.dispatchModel(s))).map(s => s.theorem_id),
      codex_quota: this.quota.state,
      codex_sandbox_recovery: codexSandboxRecovery.state,
      api_recovery: this.client.recovery?.state ?? null,
      proof_storage_recovery: this.proofStorageRecovery.state,
      mission_research: { reviewing: !!this.reviewing, model_running: !!this.reviewModelActive,
        observed_nodes: this.research.state?.observed_ids.length ?? 0,
        reviewed_nodes: this.research.state?.reviewed_count ?? 0, latest: this.research.state?.latest ?? null,
        invocations: this.research.state?.review_invocations ?? 0, completed_reviews: this.research.state?.completed_reviews ?? 0,
        last_error: this.research.state?.last_error ?? this.researchError ?? null },
      codex_permits_available: Math.max(0, this.limits.queues.CODEX.concurrency - counts.queues.CODEX.running),
      graph_generation: this.selection.committedGeneration, graph_requested_generation: this.selection.requestedGeneration,
      graph_refresh_pending: this.refreshPending, graph_next_refresh_at: new Date(this.graphDue(index)).toISOString(),
      graph_reconciling: !!this.refreshing, graph_updates_pending: this.selection.updates.filter(e => e.pending).length,
      oldest_wait: waiting.map(s => s.updated_at).filter(Boolean).sort()[0],
      attempts_by_model: [...index.values()].reduce((totals, s) => {
        for (const [model, n] of Object.entries(s.attempts_by_model ?? {})) totals[model] = (totals[model] ?? 0) + n;
        return totals;
      }, {}), attention_jobs: [...index.values()].filter(s => s.job_status === 'NEEDS_ATTENTION'),
      waiting_reason: waitingReason, updated_at: new Date(this.now()).toISOString() };
    if (status !== 'RUNNING') summary.finished_at = summary.updated_at;
    if (error) summary.error = error.message;
    await save(join(this.options.runs, 'last-run.json'), summary);
    const label = stages.map(stage => {
      const q = counts.queues[stage], cap = this.limits.queues[stage];
      return `${stage.toLowerCase()} ${q.running}/${cap.concurrency} running, ${q.queued}+${q.reserved}/${cap.maxSize} waiting+reserved${q.delayed ? ` (${q.delayed} delayed)` : ''}`;
    }).join('; ');
    const report = `${status}: local jobs ${counts.localActive}/${this.limits.maxActiveJobs}, remote jobs ${counts.remoteActive}/${this.limits.maxRemoteJobs}; ${label}; handoffs ${counts.handoffs}; attention ${counts.attention}${waitingReason ? `; ${waitingReason}` : ''}`;
    // Same-stage remote polling briefly toggles running/delayed/handoff counts.
    // Keep those exact counters in checkpoints, but print summaries when work
    // actually moves or a local worker changes, plus the waiting heartbeat.
    const reportKey = JSON.stringify([status, counts.active, stages.map(stage => [
      [...index.values()].filter(s => s.job_status === 'ACTIVE' && s.stage === stage).length,
      stage === 'SERVER' ? null : counts.queues[stage].running,
    ]), counts.attention, this.quota.waiting ? 'waiting for Codex quota' : waitingReason]);
    if (reportKey !== this.lastReportKey || !this.quota.waiting && this.now() - this.lastReportAt >= 30000) {
      progress(report); this.lastReportKey = reportKey; this.lastReportAt = this.now();
    }
    await this.hooks.onCheckpoint?.(summary);
    return summary;
  }
  dispatch(control, state, persist) {
    this.signal.throwIfAborted();
    if (control.running && !state.pending_outcome) return Promise.resolve();
    control.running = null;
    delete control.preparation;
    return new Promise((resolve, reject) => {
      control.waiting = { state, persist, resolve, reject }; this.wake();
    });
  }
  start(state) {
    const id = state.theorem_id;
    const controller = new AbortController();
    const control = { running: null, waiting: null, controller };
    this.controls.set(id, control);
    const persist = async () => {
      if (!await this.store.replace(state, state.revision, { allowRetirement: true })) throw new JobPersistenceError('Stale pipeline dispatch');
    };
    const dispatch = (job, writer) => this.dispatch(control, job, writer);
    const checkNeeded = async () => {
      const current = await this.store.read(id);
      if (current.retirement_requested) throw new RetiredJob('No longer needed by selected root');
      this.signal.throwIfAborted();
    };
    control.promise = (async () => {
      await dispatch(state, persist);
      if (!this.visited.has(id)) { this.visited.add(id); this.visits++; }
      const selection = state.selection;
      progress(`[${id}/${state.job_id}/${state.stage}] starting or resuming job` + (selection
        ? `: ${selection.theorem_name}; ${selection.task_kind}; ${selection.operation}; score ${selection.score}; closability ${selection.closability}; attempts ${selection.totalAttempts}, current context ${selection.attemptsInCurrentContext}; ${selection.selection_reason}; context ${selection.context_id}` : ''));
      return this.hooks.runJob(state, {
        dispatch, signal: AbortSignal.any([this.signal, controller.signal]), runId: this.runId, quota: this.quota,
        workspaceProgress: status => {
          if (control.running !== 'PREPARE' || this.controls.get(id) !== control) return;
          control.preparation = { ...status };
          this.wake();
        },
        invokeAgent: action => this.invokeAgent(action, AbortSignal.any([this.signal, controller.signal])),
        proofStorageRecovery: this.proofStorageRecovery, readOnlyPoll: () => !!control.polling,
        promptVariant: () => this.limits.promptVariant,
        changed: async job => {
          if (await this.selection.recordOutcome(job, this.target.root)) {
            this.graphChanged = true; this.rootCheckAt = 0;
          }
          if (job.job_status === 'READY' && /Target changed/i.test(job.feedback ?? '')) {
            await this.selection.recordOutcome({ ...job, job_status: 'DONE', status: `SKIPPED (target changed ${job.revision})` }, this.target.root);
          }
          this.wake();
        },
        beforeModel: async () => {
          await checkNeeded();
          const index = await this.store.index({ readOnly: true }), current = index.get(id);
          const model = this.dispatchModel(current);
          if (isSolModel(model) && this.solRunning(id)) return false;
          control.model = model;
          const profile = attemptModel(Math.max(1, current.attempt_count + (current.codex_quota_wait || current.operator_dispatch_wait ? 0 : 1)), this.options, current);
          if (current.operation === 'format_repair') return;
          if (!profile.escalation?.automatic || !this.selection.graph) return;
          const reason = escalationBlocker(this.selection.graph, index, id, this.now(), this.options);
          if (reason) { progress(`[${id}] Deferring automatic escalation: ${reason}`); return false; }
        }, beforeRemoteWrite: checkNeeded,
        awaitModelDispatch: async (job, persist) => {
          // A dispatched stage can still be preparing an invocation packet.
          // If the operator paused in the meantime, release its worker and
          // resume the same attempt only after the queue is explicitly reopened.
          while (this.modelDispatchPaused || this.proofStorageRecovery.waiting) {
            job.operator_dispatch_wait = true;
            await persist();
            control.running = null;
            await this.dispatch(control, job, persist);
          }
          if (job.operator_dispatch_wait) { delete job.operator_dispatch_wait; await persist(); }
        },
        assertModelSlot: model => {
          if (this.operator.state.agentsStopped) throw new AgentsStopped();
          if (this.proofStorageRecovery.waiting) throw new ProofStoragePaused();
          // Capacity reductions drain existing owners; admission enforces the
          // new limit. A running owner keeps its slot until it finishes.
          if (control.running !== 'CODEX' || this.controls.get(id) !== control) {
            throw new JobPersistenceError(`Model invocation for ${id} does not own a Codex dispatch slot`);
          }
          if (isSolModel(model ?? control.model) && (!isSolModel(control.model) || this.solRunning() > 1)) {
            throw new JobPersistenceError(`Model invocation for ${id} does not own the exclusive Sol slot`);
          }
          this.signal.throwIfAborted();
        },
      });
    })().then(status => {
      this.results.set(id, { theorem_id: id, status });
    }).catch(async error => {
      if (error instanceof RetiredJob) {
        const retired = await this.retire(id);
        if (!retired) {
          const job = await this.store.read(id);
          if (job?.job_status === 'ACTIVE' && issued(job)) {
            // A retirement race can leave a live remote journal. Give other
            // jobs the server worker instead of immediately retrying this one.
            job.dispatch_state = 'DELAYED';
            job.next_poll_at = new Date(this.now() + this.recoveryPolicy.initialDelayMs).toISOString();
            job.infrastructure_wait = error.message;
            if (!await this.store.replace(job, job.revision, { allowRetirement: true })) throw new JobPersistenceError('Cannot park retiring remote job');
          }
        }
      } else if (!this.signal.aborted) {
        if (error instanceof JobPersistenceError) { this.failure = error; }
        else {
          const job = await this.store.read(id);
          const diagnostic = { stage: job?.stage ?? control.running, operation: job?.operation,
            ...(error.code ? { code: error.code } : {}) };
          this.results.set(id, { theorem_id: id, status: this.hooks.isEnvironmentError?.(error) ? 'ENVIRONMENT_WAIT' : 'ERROR', error: error.message });
          if (job?.job_status === 'ACTIVE') {
            if (this.hooks.isEnvironmentError?.(error) || retryFrontierError(error)) {
              // Readiness and read failures never consume a new model attempt.
              job.dispatch_state = 'DELAYED'; job.next_poll_at = new Date(this.now() + this.refreshDelay).toISOString();
              job.infrastructure_wait = error.message;
              this.visited.delete(id); this.visits--;
            } else if (issued(job)) {
              job.dispatch_state = 'DELAYED';
              job.next_poll_at = rememberFailure(job, error.message, this.now(), this.recoveryPolicy);
              Object.assign(job.recovery_failure, diagnostic);
              job.infrastructure_wait = error.message;
            } else {
              // Preserve the error for the next selected repair, releasing all
              // admission slots instead of permanently excluding the theorem.
              rememberFailure(job, error.message, this.now(), this.recoveryPolicy);
              Object.assign(job.recovery_failure, diagnostic);
              job.recovery_failure.origin = 'job_error';
              job.feedback = `Previous job failed: ${error.message}\n${job.feedback ?? ''}`;
              job.previous_candidate = job.candidate ?? job.previous_candidate;
              delete job.candidate; delete job.artifact_manifest; delete job.plan;
              delete job.pending_outcome; delete job.next_poll_at;
              job.status = 'REPAIR_REQUIRED'; job.stage = 'PREPARE'; job.operation = 'prepare';
              job.job_status = 'READY'; job.dispatch_state = 'QUEUED';
            }
            if (!await this.store.replace(job, job.revision, { allowRetirement: true })) throw new JobPersistenceError('Cannot park failed job');
          }
          const retryAt = job?.job_status === 'READY' ? job.retry_after : job?.next_poll_at;
          progress(`[${id}/${diagnostic.stage ?? 'job'}] ${diagnostic.operation ?? 'action'} failed${error.code ? ` (${error.code})` : ''}: ${error.message}` +
            (retryAt ? `; retry eligible at ${retryAt}` : '; inspect the saved job for recovery details'));
        }
      }
    }).catch(error => { this.failure = error; }).finally(() => {
      control.running = null; this.controls.delete(id); this.wake();
    });
  }
  async startIfCurrent(state) {
    // index() reads jobs asynchronously. A worker can finish and remove its
    // control during that scan, leaving an ACTIVE record in the snapshot.
    // Serialize the final read and control creation with job-state writers.
    return transaction(this.options.runs, async () => {
      const current = await this.store.read(state.theorem_id);
      if (current?.job_status !== 'ACTIVE' || current.job_id !== state.job_id || current.revision !== state.revision) {
        this.wake(); return false;
      }
      if (!this.controls.has(state.theorem_id)) this.start(current);
      return true;
    });
  }
  async retire(id) {
    const job = await this.store.retire(id);
    if (!job) return;
    await new PublicationStore(this.options.runs).releaseUnused(job.job_id);
    this.results.set(id, { theorem_id: id, status: 'RETIRED' });
    return job;
  }
  async reconcileRelevance() {
    const graph = this.selection.graph;
    if (!graph) return;
    const needed = neededTheorems(graph);
    for (const job of (await this.store.index({ readOnly: true })).values()) {
      if (job.job_status !== 'ACTIVE') continue;
      if (graph.root.status !== 'Open' || graph.root.deprecated_at || !needed.has(job.theorem_id)) {
        await this.store.requestRetirement(job.theorem_id);
        const control = this.controls.get(job.theorem_id);
        // A refuted sketch can make a sibling irrelevant while its model is
        // still running. Stop that invocation; issued remote work keeps its journal.
        if (graph.root.status === 'Open' && control?.running === 'CODEX' && !issued(job)) {
          control.controller?.abort(new RetiredJob('No longer needed by selected root'));
        }
        if (!control?.running && !issued(job)) {
          await this.retire(job.theorem_id);
          control?.waiting?.reject(new RetiredJob('Retired queued work'));
          if (control) control.waiting = null;
        }
      }
    }
  }
  assertReviewSlot() {
    if (this.operator.state.agentsStopped) throw new AgentsStopped();
    if (this.proofStorageRecovery.waiting) throw new ProofStoragePaused();
    if (!this.reviewModelActive) throw new JobPersistenceError('Mission review does not own a Codex slot');
    if (isSolModel(modelProfile(this.limits.missionReviewModel).model) && this.solRunning() > 1) {
      throw new JobPersistenceError('Mission review does not own the exclusive Sol slot');
    }
    this.reviewSignal.throwIfAborted();
  }
  async maybeReview() {
    if (this.modelDispatchPaused || this.proofStorageRecovery.waiting || this.reviewing || this.researchError || !this.hooks.reviewMission || !this.research.due || this.quota.waiting ||
        this.refreshing || this.selection.requestedGeneration !== this.selection.committedGeneration ||
        this.selection.graph?.root.status !== 'Open') return;
    const running = [...this.controls.values()].filter(c => c.running === 'CODEX').length;
    if (running >= this.limits.queues.CODEX.concurrency || this.quota.paused && running > 0) return;
    if (isSolModel(modelProfile(this.limits.missionReviewModel).model) && this.solRunning()) return;
    let request;
    try { request = await this.research.begin(this.selection.graph, this.target, await this.store.index({ readOnly: true })); }
    catch (error) { this.researchError = error.message; progress(`Mission research unavailable: ${error.message}`); return; }
    if (!request || this.modelDispatchPaused || this.proofStorageRecovery.waiting || this.refreshing || this.selection.graph.root.status !== 'Open') return;
    this.reviewController = new AbortController();
    this.reviewEpoch = request.epoch;
    this.reviewSignal = AbortSignal.any([this.signal, this.reviewController.signal]);
    this.reviewModelActive = true;
    progress(`Mission research: reviewing ${request.observed_count} observed theorem nodes with ${request.model}`);
    this.reviewing = (async () => {
      const token = this.quota.probeToken;
      try {
        if (!await this.research.startInvocation(request) || this.modelDispatchPaused || this.proofStorageRecovery.waiting) return;
        this.assertReviewSlot();
        const result = await this.invokeAgent(signal => this.hooks.reviewMission(request, { signal,
          assertModelSlot: () => this.assertReviewSlot() }), this.reviewSignal);
        await this.quota.succeeded(token);
        const published = await this.research.publish(request, result, { signal: this.reviewSignal,
          download: this.hooks.downloadResearchResource });
        if (published) progress(`Mission research: saved review ${request.id} for later proof attempts`);
      } catch (error) {
        if (!this.reviewSignal.aborted && !(error instanceof AgentsStopped)) {
          const quota = isCodexQuotaError(error);
          if (quota) await this.quota.block(error);
          else await this.quota.inconclusive(token, error);
          await this.research.failed(request, error, { quota: quota || error instanceof ProofStoragePaused });
          progress(`Mission research deferred: ${error.message}`);
        }
      } finally { this.reviewModelActive = false; }
    })().catch(error => {
      if (error instanceof JobPersistenceError) this.failure = error;
      else this.researchError = error.message;
    }).finally(() => { this.reviewing = null; this.reviewController = null; this.wake(); });
  }
  async persistWaiting(control, ready) {
    try { await ready.persist(); return true; }
    catch (error) {
      const current = await this.store.read(ready.state.theorem_id);
      if (error instanceof RetiredJob && control.controller?.signal.aborted &&
          current?.job_id === ready.state.job_id && current.retirement_requested && !issued(current)) {
        control.running = null;
        if (control.waiting === ready) control.waiting = null;
        ready.reject(error);
        return false;
      }
      // A graph refresh may retire queued work during either routing or
      // dispatch. Preserve the newer retirement instead of failing the run.
      if (!(error instanceof JobPersistenceError) || current?.job_id !== ready.state.job_id ||
          current.job_status !== 'RETIRED' || !current.retirement_requested ||
          current.revision <= ready.state.revision || issued(current)) throw error;
      control.running = null;
      if (control.waiting === ready) control.waiting = null;
      ready.reject(new RetiredJob('Retired before dispatch'));
      return false;
    }
  }
  async routeAndDispatch() {
    let index = await this.store.index({ readOnly: true });
    for (const state of index.values()) {
      if (state.job_status === 'ACTIVE' && state.dispatch_state === 'HANDOFF_PENDING' && !this.controls.has(state.theorem_id)) await this.startIfCurrent(state);
    }
    // Handoffs are routed oldest first, before any new admission.
    const waiting = [...this.controls.values()].filter(c => c.waiting)
      .sort((a, b) => sequence(a.waiting.state, b.waiting.state));
    for (const control of waiting) {
      // Earlier handoffs yield to graph refreshes, which can clear a later
      // control's waiter after the list above was captured.
      const ready = control.waiting;
      if (!ready) continue;
      const { state } = ready;
      const current = index.get(state.theorem_id);
      if (current?.job_status !== 'ACTIVE') { ready.reject(new RetiredJob('Job retired')); control.waiting = null; continue; }
      state.retirement_requested = current.retirement_requested;
      if (state.retirement_requested && !issued(state)) {
        ready.reject(new RetiredJob('Retired handoff')); control.waiting = null; continue;
      }
      const outcome = state.pending_outcome;
      if (!outcome || !this.fits(outcome.stage, index,
        this.isServerOnlyJob(current) && outcome.stage === 'SERVER' && current.stage === 'SERVER' ? 0 : 1, current)) continue;
      if (this.isRemote(current) && outcome.stage !== 'SERVER' && this.counts(index).localActive >= this.limits.maxActiveJobs) continue;
      const from = state.stage;
      Object.assign(state, outcome); delete state.pending_outcome;
      if (!await this.persistWaiting(control, ready)) continue;
      index = await this.store.index({ readOnly: true });
      this.logQueueMove(state, from, index);
    }
    await this.maybeReview();
    index = await this.store.index({ readOnly: true });
    for (const stage of stages) {
      // One coordinator fans out due, read-only verdict checks. Uploads,
      // publication and reconciliation retain their separate action bound.
      const pollCapacity = Math.max(1, this.limits.apiConcurrency - this.limits.queues.SERVER.concurrency - 1);
      for (let dispatched = 0; dispatched < (stage === 'SERVER' ? pollCapacity + this.limits.queues.SERVER.concurrency : this.limits.queues[stage].concurrency); dispatched++) {
        const running = [...this.controls.values()].filter(c => c.running === stage && (stage !== 'SERVER' || !c.polling)).length + Number(stage === 'CODEX' && !!this.reviewModelActive);
        const polls = [...this.controls.values()].filter(c => c.running === 'SERVER' && c.polling).length;
        if (stage === 'CODEX' && (this.modelDispatchPaused || this.proofStorageRecovery.waiting || this.quota.waiting || this.quota.paused && running > 0)) continue;
        if (stage !== 'SERVER' && running >= this.limits.queues[stage].concurrency) break;
        const entries = [...index.values()].filter(s => s.job_status === 'ACTIVE' && s.stage === stage &&
          s.dispatch_state !== 'HANDOFF_PENDING' && !this.controls.get(s.theorem_id)?.running && due(s) <= this.now() &&
          (stage !== 'SERVER' || (this.isVerdictPoll(s) ? polls < pollCapacity : running < this.limits.queues.SERVER.concurrency)))
          .sort(stage === 'SERVER' ? (a, b) => due(a) - due(b) || sequence(a, b) : sequence);
        // A waiting Sol job must not prevent Luna work from using spare workers.
        // Reserve the Sol slot before resolving dispatch, including restored jobs
        // and explicitly configured Sol models, not just automatic rescues.
        const state = stage === 'CODEX' ? entries.find(s => !isSolModel(this.dispatchModel(s)) || !this.solRunning()) : entries[0];
        if (!state) break;
        if (!this.controls.has(state.theorem_id) && !await this.startIfCurrent(state)) continue;
        const control = this.controls.get(state.theorem_id);
        if (!control?.waiting) continue;
        const ready = control.waiting;
        // A worker can yield a new handoff after the index was read. Only route
        // that handoff through the capacity check above; never resume its old stage.
        if (ready.state.pending_outcome || ready.state.stage !== stage || due(ready.state) > this.now()) {
          this.wake(); continue;
        }
        control.running = stage;
        control.polling = this.isVerdictPoll(ready.state);
        control.model = stage === 'CODEX' ? this.dispatchModel(ready.state) : undefined;
        delete ready.state.infrastructure_wait;
        const waitMs = Math.max(0, this.now() - Math.max(Date.parse(ready.state.updated_at), due(ready.state)));
        ready.state.stage_wait_ms ??= {};
        ready.state.stage_wait_ms[stage] = (ready.state.stage_wait_ms[stage] ?? 0) + waitMs;
        if (!await this.persistWaiting(control, ready)) continue;
        if (stage === 'CODEX' && (this.modelDispatchPaused || this.proofStorageRecovery.waiting)) {
          control.running = null;
          continue;
        }
        control.waiting = null;
        progress(`[${state.theorem_id}/${stage}] dispatch ${state.operation}`);
        ready.resolve();
        index = await this.store.index({ readOnly: true });
      }
    }
  }
  handleGraphRefreshError(error) {
    if (!retryGraphRefreshError(error)) { this.failure = error; return; }
    this.refreshRetryAt = this.now() + this.refreshDelay;
    this.graphRetryReason = `Graph refresh failed: ${error.message}; retrying in ${this.refreshDelay / 1000}s`;
    this.pauseReason = this.graphRetryReason;
    progress(this.graphRetryReason);
  }
  updateGraph() {
    if (this.updatingGraph || !this.selection.graph || !this.selection.updates.some(e => e.pending && e.next_check_at <= this.now())) return;
    this.updatingGraph = this.selection.refreshUpdates(this.client, { now: this.now, retryMs: this.refreshDelay, signal: this.signal })
      .then(() => { this.graphChanged = true; })
      .catch(error => { if (!this.signal.aborted) this.failure = error; })
      .finally(() => { this.updatingGraph = null; this.wake(); });
  }
  checkRoot(index) {
    if (this.rootChecking || this.now() < (this.rootCheckAt ?? 0) || !this.selection.graph ||
        this.selection.rootConfirmed && this.selection.graph.root.status !== 'Open' ||
        this.selection.graph.root.status === 'Open' && (this.counts(index).active ||
          this.selection.updates.some(e => e.pending) || scoreWork(this.selection.graph, index, this.now(), this.options).length)) return;
    this.rootCheckAt = this.now() + this.refreshDelay;
    this.rootChecking = this.client.request(`theorems/${encodeURIComponent(this.target.root)}`)
      .then(root => this.selection.confirmRoot(root))
      .then(() => { this.graphChanged = true; })
      .catch(error => { if (!this.signal.aborted && !retryGraphRefreshError(error)) this.failure = error; })
      .finally(() => { this.rootChecking = null; this.wake(); });
  }
  async refresh() {
    if (this.refreshing || this.now() < this.refreshRetryAt) return;
    this.refreshPending = false;
    this.refreshing = (async () => {
      await this.selection.requestGraphRefresh(this.refreshReason ?? 'scheduled graph refresh', { background: !!this.selection.graph });
      return this.selection.buildGraph(this.client, this.target.root, this.hooks.frontier);
    })()
      .then(async graph => {
        // Every successful update postpones the next periodic scan, including
        // event-driven updates and extra passes requested during discovery.
        this.refreshRetryAt = 0; this.graphRetryReason = null; this.refreshAt = this.now() + this.graphRefreshDelay;
        this.lowWorkRefreshAt = this.now() + Math.min(this.refreshDelay, this.graphRefreshDelay);
        if (graph.root.deprecated_at || !['Open', 'Proved', 'Disproved'].includes(graph.root.status)) {
          throw new Error(`Target root is ${graph.root.status}${graph.root.deprecated_at ? ' and deprecated' : ''}; the requested target is not proved`);
        }
        if (!this.recovered) {
          for (const job of (await this.store.index({ readOnly: true })).values()) {
            const state = await this.store.ensure(job.theorem_id, { attempts: this.options.attempts });
            if (state.job_status === 'NEEDS_ATTENTION' && issued(state)) this.startupAttention.add(state.theorem_id);
            else if (state.job_status === 'NEEDS_ATTENTION') {
              state.job_status = 'READY'; state.dispatch_state = 'QUEUED';
              delete state.pending_outcome; delete state.next_poll_at;
              if (!await this.store.replace(state, state.revision, { allowRetirement: true })) throw new JobPersistenceError('Cannot reopen legacy attention job');
            }
          }
          await this.restoreProofStorageRecovery();
          this.recovered = true;
        }
        const needed = neededTheorems(graph);
        graph.leaves = graph.leaves.filter(s => needed.has(s.theorem_id)).toSorted((a, b) =>
          (b.closability ?? 0) - (a.closability ?? 0) ||
          (a.theorem_name ?? a.theorem_id).localeCompare(b.theorem_name ?? b.theorem_id) || a.theorem_id.localeCompare(b.theorem_id));
        await this.reconcileRelevance();
        try { await this.research.observe(graph); }
        catch (error) { this.researchError = error.message; progress(`Mission research disabled for this run: ${error.message}`); }
        if (graph.root.status !== 'Open' || this.reviewEpoch && this.reviewEpoch !== this.research.state?.epoch) {
          this.reviewController?.abort(new Error('Selected root no longer needs this research'));
        }
      }).catch(error => this.handleGraphRefreshError(error))
      .finally(() => { this.refreshing = null; this.wake(); });
  }
  async restoreProofStorageRecovery() {
    const index = await this.store.index({ readOnly: true });
    this.proofStorageRecovery.restore(index);
    // Older runners timed out before receiving the storage-error response.
    // Adopt recent server records before opening model dispatch on restart.
    const unknown = [...index.values()].filter(s => s.job_status === 'ACTIVE' &&
      ['SUBMITTING', 'SUBMISSION_UNKNOWN'].includes(s.status));
    const history = unknown.length ? await this.client.request('submissions?page=1') : null;
    if (history && !Array.isArray(history.submissions)) throw new Error('Invalid submission history');
    for (const job of index.values()) {
      if (job.job_status !== 'ACTIVE') continue;
      const verdict = proofStorageFailure(job.verdict) ? job.verdict
        : unknown.includes(job) ? history.submissions.find(row => storageFailureMatches(row, job)) : null;
      if (!verdict || job.proof_storage_retry) continue;
      const state = await this.store.read(job.theorem_id);
      state.submission_id = verdict.id ?? state.submission_id;
      state.submissions ??= [];
      if (state.submission_id && !state.submissions.includes(state.submission_id)) state.submissions.push(state.submission_id);
      const operation = state.remote_operations?.at(-1);
      if (operation) { operation.submission_id = state.submission_id; operation.status = 'ERROR'; }
      state.verdict = verdict;
      parkProofStorageFailure(state, verdict, this.options, this.now());
      state.stage = 'SERVER'; state.operation = 'retry_storage'; state.dispatch_state = 'DELAYED';
      delete state.pending_outcome;
      this.proofStorageRecovery.block(state);
      if (!await this.store.replace(state, state.revision, { allowRetirement: true })) {
        throw new JobPersistenceError('Cannot restore proof storage recovery');
      }
    }
  }
  async idle(milliseconds) {
    let timer;
    const awakened = new Promise(resolve => { this.waker = resolve; });
    const abort = () => this.wake();
    this.signal.addEventListener('abort', abort, { once: true });
    try {
      const delay = this.hooks.wait ? this.hooks.wait(milliseconds) : new Promise(resolve => { timer = setTimeout(resolve, milliseconds); });
      await Promise.race([awakened, delay]);
    } finally { clearTimeout(timer); this.signal.removeEventListener('abort', abort); this.waker = null; }
  }
  async recoverAttention() {
    for (const id of this.startupAttention) {
      const index = await this.store.index({ readOnly: true }), saved = index.get(id), state = saved && structuredClone(saved);
      if (state?.job_status !== 'NEEDS_ATTENTION') { this.startupAttention.delete(id); continue; }
      if ((this.isServerOnlyJob(state) ? this.counts(index).active >= this.limits.maxRemoteJobs
        : this.counts(index).localActive >= this.limits.maxActiveJobs) || !this.fits('SERVER', index, 1, state)) return;
      const from = state.stage;
      state.job_status = 'ACTIVE'; state.stage = 'SERVER'; state.dispatch_state = 'QUEUED';
      delete state.pending_outcome; delete state.next_poll_at;
      if (!await this.store.replace(state, state.revision, { allowRetirement: true })) throw new JobPersistenceError('Cannot resume parked remote job');
      this.logQueueMove(state, from, await this.store.index({ readOnly: true }));
      this.startupAttention.delete(id);
    }
  }
  async drain(error) {
    this.stopping = true; this.controller.abort(error);
    for (const control of this.controls.values()) {
      control.waiting?.reject(error); control.waiting = null;
    }
    await Promise.allSettled([...this.controls.values()].map(c => c.promise));
    await this.refreshing;
    await this.updatingGraph;
    await this.rootChecking;
    await this.selection.graphWriter;
    await this.quotaChecking;
    await this.reviewing;
    await this.operator.writer;
  }
  async run() {
    try {
      await this.operator.load();
      await this.hooks.onControlReady?.(this);
      await this.quota.load();
      // Recover a crash between the job's quota handoff and the shared pause.
      if (!this.quota.state) {
        const waiting = [...(await this.store.index({ readOnly: true })).values()].find(s => s.job_status === 'ACTIVE' && s.codex_quota_wait);
        if (waiting) await this.quota.block(waiting.codex_quota_wait);
      }
      await this.requestRefresh('startup');
      for (;;) {
        const epoch = this.epoch;
        this.signal.throwIfAborted();
        if (this.failure) throw this.failure;
        if (!this.quotaChecking && this.now() >= this.quota.nextCheckAt) {
          this.quotaChecking = this.quota.check().catch(error => {
            if (!this.signal.aborted) this.failure = new JobPersistenceError(`Cannot save Codex quota state: ${error.message}`, { cause: error });
          }).finally(() => { this.quotaChecking = null; this.wake(); });
        }
        // During a quota wait, finish event-driven graph updates needed to drain
        // work and fill the agent queue. Periodic discovery and graph-error
        // retries cannot help a full, blocked queue, so leave them for recovery.
        const graphIndex = this.selection.graph ? await this.store.index({ readOnly: true }) : new Map();
        const needsGraph = this.now() >= this.graphDue(graphIndex) &&
          (!this.quota.waiting || this.refreshPending || !this.selection.graph);
        if (!this.refreshing && needsGraph && (!this.quota.waiting || !this.refreshRetryAt)) await this.refresh();
        if (this.refreshing && (!this.selection.graph || !this.recovered || this.selection.graph.root.status !== 'Open')) {
          await this.refreshing; continue;
        }
        if (this.selection.graph) {
          this.updateGraph();
          if (this.graphChanged) {
            this.graphChanged = false;
            await this.reconcileRelevance();
            try { await this.research.observe(this.selection.graph); }
            catch (error) { this.researchError = error.message; }
            if (this.selection.graph.root.status !== 'Open' || this.reviewEpoch && this.reviewEpoch !== this.research.state?.epoch) {
              this.reviewController?.abort(new Error('Selected root no longer needs this research'));
            }
          }
          const disproved = this.selection.graph.root.status === 'Disproved' && !this.refreshing &&
            this.selection.rootConfirmed && this.selection.requestedGeneration === this.selection.committedGeneration;
          if (disproved) {
            // Stop before recovery or dispatch: issued requests keep their durable
            // journals, but a false root must not wait for their verdicts forever.
            await this.drain(new Error('Selected root theorem is disproved'));
            await this.reconcileRelevance();
            if (this.failure) throw this.failure;
            this.pauseReason = 'target disproved; proof search stopped; issued request records preserved';
            return await this.checkpoint('DISPROVED');
          }
          await this.recoverAttention();
          await this.routeAndDispatch();
          const index = await this.store.index({ readOnly: true });
          const root = this.selection.graph.root;
          const fresh = !this.refreshing && this.selection.requestedGeneration === this.selection.committedGeneration;
          this.checkRoot(index);
          if (root.status === 'Proved' && this.selection.rootConfirmed && fresh && !this.controls.size && !this.counts(index).active) {
            await this.rootChecking; await this.updatingGraph; await this.selection.graphWriter;
            if (this.failure) throw this.failure;
            this.signal.throwIfAborted();
            if (this.selection.graph.root.status !== 'Proved' || !this.selection.rootConfirmed) continue;
            await this.reviewing;
            return await this.checkpoint(this.counts(index).attention ? 'NEEDS_ATTENTION' : 'COMPLETE');
          }
          if (this.selection.canSelect && root.status === 'Open' && this.canAdmit(index)) {
            let leaf;
            try { leaf = await this.selection.getWork({ runId: this.runId, signal: this.signal,
              verificationMode: verificationMode(this.options), allowCommitted: true,
              canClaim: rows => this.canAdmit(rows), excluded: new Set(this.controls.keys()) }); }
            catch (error) {
              // A server outcome can dirty the graph between the freshness check
              // and the claim. getWork then performs its own required refresh.
              this.handleGraphRefreshError(error); continue;
            }
            if (leaf) { await this.routeAndDispatch(); continue; }
          }
          this.pauseReason = !this.selection.canSelect ? this.graphRetryReason ?? 'waiting for fresh graph' :
            this.counts(index).localActive >= this.limits.maxActiveJobs ? 'local active-job capacity full' :
              serverOnly(this.options) && this.counts(index).active >= this.limits.maxRemoteJobs ? 'remote capacity reserved or full' :
              this.counts(index).handoffs ? 'waiting to route saved handoffs' : this.counts(index).active ? 'active jobs or remote waiting' :
                'waiting for new leaves or graph propagation';
          if (fresh && [...index.values()].some(s => s.job_status === 'ACTIVE' && s.dispatch_state === 'DELAYED' && s.infrastructure_wait)) {
            this.pauseReason = 'waiting for Lean/Codex environment or context recovery';
          }
          if (this.quota.paused) this.pauseReason = this.quota.describe();
          if (this.client.recovery?.state?.waiting) this.pauseReason = 'waiting for shared API recovery';
          if (this.proofStorageRecovery.waiting) this.pauseReason = 'Codex paused: retrying saved proofs until server storage recovers';
          if (!this.controls.size && !this.counts(index).active && this.counts(index).attention && fresh) return await this.checkpoint('NEEDS_ATTENTION');
        }
        await this.checkpoint();
        const index = await this.store.index({ readOnly: true });
        // A handoff can wake us during the final async read. Check afterwards
        // so the coordinator does not sleep through work that is already ready.
        if (epoch !== this.epoch) continue;
        const deadlines = [...index.values()].flatMap(s => {
          const deadline = s.job_status === 'READY' ? Date.parse(s.retry_after ?? '') :
            s.job_status === 'ACTIVE' && !this.controls.get(s.theorem_id)?.running ? due(s) : 0;
          return deadline > this.now() ? [deadline] : [];
        });
        const graphDue = this.quota.waiting ? Infinity : this.refreshing ? this.now() + 60000 : this.graphDue(index);
        const updateDue = this.updatingGraph ? Infinity : Math.min(Infinity, ...this.selection.updates.filter(e => e.pending).map(e => e.next_check_at));
        const quotaDue = this.quotaChecking ? Infinity : this.quota.nextCheckAt;
        // Managed UI runners publish observations during long calls and waits.
        // Headless runners retain their quiet wait schedule; provider reads
        // still follow their independent graph, retry and quota deadlines.
        const waitMs = Math.max(1, Math.min(this.monitorInterval ?? (this.quota.waiting ? QUOTA_CHECK_INTERVAL : 30000),
          graphDue - this.now(), updateDue - this.now(), quotaDue - this.now(), ...deadlines.map(d => d - this.now())));
        await this.idle(waitMs);
      }
    } catch (error) {
      await this.drain(error);
      await this.checkpoint(this.options.signal?.aborted ? 'INTERRUPTED' : 'ERROR', error);
      throw error;
    } finally {
      this.store.releaseIndex();
    }
  }
}
