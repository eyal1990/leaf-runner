import { join } from 'node:path';
import { progress, save } from './runner-state.mjs';

const setupFailure = /setup refresh had errors|runtime read\/execute validation failed|open ACL target.*os error 32/i;

export class CodexSandboxRecovery {
  constructor({ now = Date.now } = {}) {
    this.now = now; this.modes = new Map(); this.lastChecks = new Map(); this.state = null;
  }
  mode(options) {
    const policy = options.windowsSandboxRecovery ?? options.pipeline?.windowsSandboxRecovery ?? 'protected';
    return policy === 'allow-unelevated' ? this.modes.get(options.codex ?? 'codex') : undefined;
  }
  async recover({ options, output, probe, dir, mode }) {
    if (!setupFailure.test(output)) return false;
    options.signal?.throwIfAborted();
    const key = options.codex ?? 'codex';
    if (this.now() - (this.lastChecks.get(key) ?? -Infinity) < 60000) return false;
    this.lastChecks.set(key, this.now());
    const policy = options.windowsSandboxRecovery ?? options.pipeline?.windowsSandboxRecovery ?? 'protected';
    const selection = options.windowsSandbox ?? options['windows-sandbox'] ?? 'auto';
    const allowed = policy === 'allow-unelevated' && selection === 'auto' && mode === 'elevated';
    const log = join(dir, 'environment-codex-recovery-unelevated.log');
    this.state = { status: allowed ? 'CHECKING' : 'WAITING', code: 'WINDOWS_SANDBOX_SETUP_FAILED',
      checked_at: new Date(this.now()).toISOString(), sandbox_mode: mode,
      reason: allowed ? 'Protected Windows sandbox setup failed; checking the operator-enabled unelevated fallback'
        : 'Windows sandbox setup failed; automatic unelevated fallback is disabled or an explicit sandbox mode is pinned',
      source_error: output.slice(-10000), log: allowed ? log : undefined };
    const persist = () => options.runs ? save(join(options.runs, 'codex-sandbox-recovery.json'), this.state) : Promise.resolve();
    await persist();
    if (!allowed) return false;
    progress(`${this.state.reason} (weaker network isolation)`);
    try {
      await probe(options.codex ?? 'codex', log, 'unelevated');
      options.signal?.throwIfAborted();
    } catch (error) {
      options.signal?.throwIfAborted();
      this.state = { ...this.state, status: 'WAITING', error: error.message,
        reason: 'Windows sandbox recovery probe failed; waiting and retrying automatically without starting a proof attempt' };
      await persist(); return false;
    }
    this.state = { ...this.state, status: 'RECOVERED', sandbox_mode: 'unelevated',
      recovered_at: new Date(this.now()).toISOString(),
      reason: 'Full readiness passed with the operator-enabled unelevated sandbox; weaker network isolation' };
    // Never advertise or reuse the fallback until readiness and persistence pass.
    await persist(); this.modes.set(key, 'unelevated');
    progress('Codex sandbox recovered; subsequent readiness, proof, formatting and research calls use unelevated');
    return true;
  }
}

export const codexSandboxRecovery = new CodexSandboxRecovery();
