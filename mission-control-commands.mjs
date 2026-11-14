import { join } from 'node:path';
import { readJson, save } from './runner-state.mjs';
import { validatePromptVariant } from './prompt-experiment.mjs';
import { runtimeSettings, applyRuntimeSettings } from './runtime-settings.mjs';
import { updateRunnerConfig } from './runner-config-store.mjs';

// Listen before credentials/target discovery, so a supervisor shutdown also
// cancels startup and never leaves an unattached runner resolving in the dark.
export function connectRunnerControl(controller) {
  let pipeline;
  const send = message => { if (process.connected) process.send(message); };
  const message = value => {
    if (value?.type === 'stop') { controller.abort(new Error('Operator stopped and saved runner')); return; }
    if (value?.type !== 'command') return;
    const operation = pipeline ? pipeline.operator.execute(value.command)
      : Promise.reject(new Error('Coordinator is still starting. Refresh and try again.'));
    operation.then(receipt => send({ type: 'receipt', id: value.command.id, receipt }),
      error => send({ type: 'receipt', id: value.command.id, error: error.message }));
  };
  const disconnected = () => controller.abort(new Error('Mission Control supervisor disconnected'));
  const heartbeat = process.send ? setInterval(() => send({ type: 'heartbeat', at: new Date().toISOString() }), 5000).unref() : null;
  if (process.send) { process.on('message', message); process.on('disconnect', disconnected); }
  return {
    target: target => send({ type: 'target', target }),
    failure: error => send({ type: 'failure', error: error.message }),
    ready: coordinator => {
      pipeline = coordinator;
      if (process.connected) pipeline.monitorInterval = 5000;
      send({ type: 'ready', runId: pipeline.runId, limits: pipeline.limits });
    },
    close: () => {
      clearInterval(heartbeat); process.off('message', message); process.off('disconnect', disconnected);
      if (process.connected) process.disconnect();
    },
  };
}

// Only the coordinator writes this record. Operator pauses are independent of
// quota recovery and survive stopping and restarting the same root.
export class MissionCommands {
  constructor(pipeline) {
    this.pipeline = pipeline;
    this.path = join(pipeline.options.runs, 'mission-control', 'controls', `${encodeURIComponent(pipeline.target.root)}.json`);
    this.state = { revision: 0, admissionPaused: false, dispatchPaused: false, agentsStopped: false, receipts: [] };
    this.writer = Promise.resolve();
  }
  async load() {
    const state = await readJson(this.path);
    if (state && (!Number.isSafeInteger(state.revision) || state.revision < 0 || typeof state.admissionPaused !== 'boolean' ||
      typeof state.dispatchPaused !== 'boolean' || (state.agentsStopped !== undefined && typeof state.agentsStopped !== 'boolean') ||
      !Array.isArray(state.receipts))) throw new Error('Invalid saved operator control state; refusing to drop an operator pause');
    // Legacy mission settings are history, never startup overrides. Only pause
    // gates, revisions and receipts survive a new run; its config wins.
    const { promptVariant, runtimeSettings: legacySettings, ...controls } = state ?? this.state;
    this.state = { agentsStopped: false, ...controls };
  }
  execute(command) {
    const result = this.writer.then(() => this.apply(command));
    this.writer = result.catch(() => {});
    return result;
  }
  async apply(command) {
    const p = this.pipeline;
    const previous = this.state.receipts.find(row => row.id === command.id);
    if (previous) {
      if (previous.action !== command.action) throw new Error('Command ID belongs to another action');
      return previous;
    }
    if (command.runId !== p.runId || command.revision !== this.state.revision) throw new Error('Runner changed. Refresh before applying this action.');
    if (p.signal.aborted || p.stopping) throw new Error('Runner is stopping');
    const next = structuredClone(this.state);
    let changedSettings, changedPrompt;
    switch (command.action) {
      case 'pause-admission': next.admissionPaused = true; break;
      case 'resume-admission': next.admissionPaused = false; break;
      case 'pause-dispatch': next.dispatchPaused = true; break;
      case 'resume-dispatch': next.dispatchPaused = false; break;
      case 'stop-agents': next.agentsStopped = true; break;
      case 'resume-agents': next.agentsStopped = false; break;
      case 'check-quota-now':
        if (!p.quota.waiting) throw new Error('Codex is not waiting for quota recovery');
        break;
      case 'set-prompt-variant': changedPrompt = validatePromptVariant(command.promptVariant); break;
      case 'set-runtime-settings':
        changedSettings = runtimeSettings(command.settings, p.limits);
        if (Object.hasOwn(command, 'promptVariant')) changedPrompt = validatePromptVariant(command.promptVariant);
        break;
      default: throw new Error('Unsupported runner command');
    }
    if (changedSettings || changedPrompt !== undefined) {
      // Only submitted fields change; unrelated file edits wait for restart.
      await updateRunnerConfig(p.options.configPath, {
        ...(changedSettings ? command.settings : {}),
        ...(changedPrompt !== undefined ? { promptVariant: changedPrompt } : {}),
      }, { revision: command.configRevision });
    }
    const receipt = { id: command.id, action: command.action, status: 'APPLIED',
      runId: p.runId, revision: next.revision + 1, appliedAt: new Date().toISOString() };
    next.revision++;
    next.receipts = [...next.receipts, receipt].slice(-1000);
    const previousState = this.state;
    // Close a pause gate before yielding to disk I/O. Resume opens only after
    // persistence. Concurrent dispatch cannot slip through an acknowledged pause.
    this.state = { ...this.state, admissionPaused: this.state.admissionPaused || next.admissionPaused,
      dispatchPaused: this.state.dispatchPaused || next.dispatchPaused,
      agentsStopped: this.state.agentsStopped || next.agentsStopped };
    try { await save(this.path, next); }
    catch (error) { this.state = previousState; throw error; }
    this.state = next;
    if (command.action === 'stop-agents') await p.stopAgents();
    if (command.action === 'check-quota-now' && p.quota.waiting) {
      p.quota.state.next_check_at = p.now();
      await p.quota.persist();
    }
    if (changedPrompt !== undefined) p.limits.promptVariant = changedPrompt;
    if (changedSettings) applyRuntimeSettings(p, changedSettings);
    p.wake();
    return changedSettings || changedPrompt !== undefined ? { ...receipt, limits: structuredClone(p.limits) } : receipt;
  }
  snapshot() {
    const { receipts, ...state } = this.state;
    return state;
  }
}
