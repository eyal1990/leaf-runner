import { createServer } from 'node:http';
import { fork, spawn } from 'node:child_process';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { closeSync, openSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, save } from './runner-state.mjs';
import { MissionCommands } from './mission-control-commands.mjs';
import { validatePromptVariant } from './prompt-experiment.mjs';
import { pipelineLimits } from './pipeline.mjs';
import { DEFAULT_CONFIG_PATH, readRunnerConfig, updateRunnerConfig } from './runner-config-store.mjs';
import { readCodexRateLimits, quotaSnapshot } from './codex-quota.mjs';
import { buildMissionView, readJobs, artifactList, readArtifact, safeId, redact } from './mission-control-data.mjs';
import { DEFAULT_CREDENTIALS_PATH, credentialStatus, saveApiKey, loadApiKey } from './credentials-store.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const now = () => new Date().toISOString();
const statusError = (message, status = 400) => Object.assign(new Error(message), { status });
const publicMission = mission => Object.fromEntries(Object.entries(mission).filter(([key]) => !['argv', 'nextArgv'].includes(key)));
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const shortHash = value => createHash('sha256').update(value).digest('hex').slice(0, 20);
const credentialError = message => /ENOENT.*credentials.*\.json|Prove2\.me API key required|Fill in api_key|authentication failed|HTTP (401|403)\b/i.test(message ?? '');
function option(argv, flag) {
  let value;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === flag) value = argv[++i];
    else if (argv[i].startsWith(flag + '=')) value = argv[i].slice(flag.length + 1);
  }
  return value;
}
function withoutOptions(argv, flags) {
  const result = [];
  for (let i = 0; i < argv.length; i++) {
    if (flags.includes(argv[i])) i++;
    else if (!flags.some(flag => argv[i].startsWith(flag + '='))) result.push(argv[i]);
  }
  return result;
}

export class MissionControl {
  constructor({ runs = join(ROOT, '.runs'), configPath = DEFAULT_CONFIG_PATH, credentialsPath = DEFAULT_CREDENTIALS_PATH, spawnRunner, sampleLimits, validateArgs, resolveTarget, samplerInterval = 60000 } = {}) {
    this.runs = runs; this.base = join(runs, 'mission-control');
    this.path = join(this.base, 'registry.json');
    this.configPath = resolve(configPath);
    this.credentialsPath = resolve(credentialsPath);
    this.registry = { revision: 0, missions: [] };
    this.spawnRunner = spawnRunner ?? (argv => fork(join(ROOT, 'prove2me.mjs'), ['--no-ui', ...argv], {
      cwd: ROOT, windowsHide: true, stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
    }));
    this.validateArgs = validateArgs ?? (async argv => (await import('./prove2me.mjs')).main(argv, { validateOnly: true }));
    this.resolveTarget = resolveTarget ?? (async (argv, key) => {
      const { Client, findTarget } = await import('./prove2me.mjs');
      const { query, selection } = await this.validateArgs(argv);
      // Use a fresh client: a token obtained with the previous key cannot be reused.
      const client = new Client(key);
      client.signal = AbortSignal.timeout(20000);
      return findTarget(client, query, selection);
    });
    this.sampleLimits = sampleLimits ?? (async () => {
      const { executable, childEnv } = await import('./prove2me.mjs');
      const active = this.registry.missions.find(m => m.id === this.active?.missionId);
      const validated = active ? await this.validateArgs(active.argv) : null;
      return readCodexRateLimits({ codex: validated?.options.codex }, { executable, env: childEnv() });
    });
    this.samplerInterval = samplerInterval;
    this.writer = Promise.resolve(); this.pending = new Map();
    this.secrets = Object.entries(process.env).filter(([key]) => /(?:API_KEY|TOKEN|SECRET|PASSWORD)$/.test(key)).map(([, value]) => value);
  }
  async init() {
    await mkdir(this.base, { recursive: true });
    this.registry = await readJson(this.path) ?? this.registry;
    this.account = await readJson(join(this.base, 'account.json'));
    // Credentials never enter the browser read model. Exact-value redaction
    // supplements structural filtering for diagnostics and artifact downloads.
    try { this.secrets.push(JSON.parse(await readFile(join(ROOT, 'credentials.json'), 'utf8')).api_key); } catch {}
    const previous = await readJson(join(this.runs, 'last-run.json'));
    if (previous?.target?.root && !this.registry.missions.some(m => m.target?.root === previous.target.root)) {
      this.registry.missions.push({ id: `saved-${shortHash(previous.target.root)}`, name: previous.target.name,
        target: previous.target, createdAt: previous.started_at ?? previous.updated_at, status: 'SAVED',
        argv: this.targetArgs(previous.target), startedAt: previous.started_at, summaryAt: previous.updated_at });
      await this.persist();
    }
    for (const mission of this.registry.missions) {
      if (['RUNNING', 'STARTING', 'STOPPING'].includes(mission.status)) mission.status = 'SAVED';
    }
    await this.persist(false);
    // Finish crash-interrupted inbox entries without replaying side effects.
    const commands = await readdir(join(this.base, 'commands')).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    for (const name of commands.filter(name => /^[A-Za-z0-9_-]+\.json$/.test(name))) {
      const path = join(this.base, 'commands', name), command = await readJson(path);
      if (command?.status !== 'PENDING') continue;
      const mission = this.registry.missions.find(m => m.id === command.missionId);
      const saved = mission?.target?.root ? await readJson(join(this.base, 'controls', `${encodeURIComponent(mission.target.root)}.json`)) : null;
      const applied = saved?.receipts?.find(receipt => receipt.id === command.id);
      await save(path, { ...command, status: applied ? 'APPLIED' : 'INTERRUPTED', result: applied ?? command.result,
        error: applied ? undefined : 'Supervisor stopped before final acknowledgement. Inspect saved mission status before issuing a new command.' });
    }
  }
  targetArgs(target) {
    const mission = target.mission?.id ?? target.mission?.mission_id;
    return mission ? ['--mission-id', mission, ...(target.kind === 'milestone' ? ['--milestone', target.id] : [])]
      : ['--mission', target.mission?.name ?? target.name];
  }
  runnerArgs(argv) {
    if (!option(argv, '--credentials') && this.credentialsPath !== DEFAULT_CREDENTIALS_PATH) argv = [...argv, '--credentials', this.credentialsPath];
    // Old UI-generated configs must not silently replace the project config.
    const configured = option(argv, '--config');
    if (configured) {
      const path = relative(join(this.base, 'configs'), resolve(configured));
      if (path && !path.startsWith('..') && !isAbsolute(path)) argv = withoutOptions(argv, ['--config']);
    }
    const path = option(argv, '--config');
    if (path && !isAbsolute(path)) return [...withoutOptions(argv, ['--config']), '--config', resolve(path)];
    if (!path && this.configPath !== DEFAULT_CONFIG_PATH) return [...argv, '--config', this.configPath];
    return [...argv];
  }
  credentialPath(mission) {
    return resolve(option(mission?.nextArgv ?? mission?.argv ?? [], '--credentials') ?? this.credentialsPath);
  }
  async credentials(mission) {
    const path = this.credentialPath(mission);
    const status = await credentialStatus(path);
    if (status.configured) this.secrets.push(await loadApiKey(path));
    this.secrets = [...new Set(this.secrets)];
    return status;
  }
  async saveCredentials({ missionId, apiKey }) {
    const mission = missionId ? this.findMission(missionId) : null;
    if (missionId && !mission) throw statusError('Mission not found', 404);
    if (process.env.PROVE2ME_API_KEY) throw statusError('PROVE2ME_API_KEY is set in the launcher environment and takes precedence. Update it there, then restart Mission Control.', 409);
    // Never put the submitted key in command receipts, registry entries or logs.
    if (typeof apiKey === 'string' && apiKey.trim()) this.secrets.push(apiKey.trim());
    await saveApiKey(this.credentialPath(mission), apiKey);
    const missionRefreshError = mission ? await this.refreshMission(mission) : null;
    return { configured: true, source: 'file', editable: true, ...(missionRefreshError ? { missionRefreshError } : {}) };
  }
  async refreshMission(mission) {
    // Retry discovery without starting proof work. Startup can fail before the
    // runner ever sends its target, leaving the raw query and ERROR in the UI.
    if (!['RUNNING', 'STARTING', 'STOPPING'].includes(mission.status)) {
      const discoveryFailed = !mission.target?.root;
      const credentialFailure = credentialError(mission.error);
      try {
        const key = await loadApiKey(this.credentialPath(mission));
        const target = await this.resolveTarget(this.runnerArgs(mission.nextArgv ?? mission.argv), key);
        mission.target = target; mission.name = target.name;
        if (discoveryFailed || credentialFailure) {
          mission.status = 'REGISTERED'; mission.error = null;
        }
      } catch (error) {
        const message = redact(error.message, this.secrets);
        if (discoveryFailed || credentialFailure) { mission.status = 'ERROR'; mission.error = message; }
        await this.persist();
        return message;
      }
      await this.persist();
    }
    return null;
  }
  refreshMissions() {
    if (this.missionRefresh) return this.missionRefresh;
    this.missionRefresh = (async () => {
      // Refresh only incomplete discovery/authentication on app open. Do not
      // replay runs, clear unrelated failures, or scan every healthy mission.
      const ids = this.registry.missions.filter(m => !m.target?.root || credentialError(m.error)).map(m => m.id);
      for (const id of ids) {
        if (this.closing) break;
        const operation = this.writer.then(async () => {
          const mission = this.findMission(id);
          if (!mission || this.active?.missionId === mission.id ||
              ['RUNNING', 'STARTING', 'STOPPING'].includes(mission.status) ||
              mission.target?.root && !credentialError(mission.error)) return;
          const lock = await this.externalRunner();
          if (lock?.alive || !(await this.credentials(mission)).configured) return;
          await this.refreshMission(mission);
        });
        // Release the writer between lookups so user commands can proceed.
        this.writer = operation.catch(() => {});
        await operation;
      }
    })().finally(() => { this.missionRefresh = null; });
    return this.missionRefresh;
  }
  async configuration(mission) {
    const argv = this.runnerArgs(mission.nextArgv ?? mission.argv);
    const configured = await this.validateArgs(argv);
    const config = await readRunnerConfig(option(argv, '--config') ?? this.configPath);
    const limits = pipelineLimits({ ...config.values, ...configured.options.pipeline });
    const overrides = Object.fromEntries(['--model', '--codex-concurrency', '--max-remote-jobs', '--verification-mode']
      .map(flag => [flag, option(argv, flag)]).filter(([, value]) => value !== undefined));
    if (overrides['--model']) limits.attemptModels = [overrides['--model']];
    return { argv, config, limits, overrides };
  }
  async savedSettings(mission, command) {
    const flags = command.action === 'set-runtime-settings' ? [
      ...(Object.hasOwn(command.settings, 'attemptModels') ? ['--model'] : []),
      ...(Object.entries(command.settings.queues ?? {}).some(([stage, queue]) => stage.toUpperCase() === 'CODEX' && Object.hasOwn(queue, 'concurrency')) ? ['--codex-concurrency'] : []),
      ...(Object.hasOwn(command.settings, 'maxRemoteJobs') ? ['--max-remote-jobs'] : []),
    ] : [];
    mission.argv = withoutOptions(this.runnerArgs(mission.argv), flags);
    if (mission.nextArgv) mission.nextArgv = withoutOptions(this.runnerArgs(mission.nextArgv), flags);
    await this.persist();
  }
  async persist(increment = true) {
    this.mergeMissions();
    if (increment) this.registry.revision++;
    await save(this.path, this.registry);
  }
  mergeMissions() {
    const roots = new Map();
    // Keep the managed entry (and its process callbacks) when a newly resolved
    // name/URL turns out to be the same root as a previously saved mission.
    const priority = mission => mission.id === this.active?.missionId ? 3 :
      ['RUNNING', 'STARTING', 'STOPPING'].includes(mission.status) ? 2 : mission.id.startsWith('saved-') ? 0 : 1;
    for (const mission of this.registry.missions) {
      if (!mission.target?.root) continue;
      const previous = roots.get(mission.target.root);
      if (!previous || priority(mission) > priority(previous)) roots.set(mission.target.root, mission);
    }
    this.registry.missions = this.registry.missions.filter(mission => {
      const canonical = roots.get(mission.target?.root);
      if (!canonical || canonical === mission) return true;
      canonical.aliases = [...new Set([...(canonical.aliases ?? []), mission.id, ...(mission.aliases ?? [])])];
      return false;
    });
  }
  findMission(id) {
    return this.registry.missions.find(m => m.id === id || m.aliases?.includes(id));
  }
  async externalRunner() {
    const content = await readFile(join(this.runs, 'runner.lock'), 'utf8').catch(error => {
      if (error.code === 'ENOENT') return null; throw error;
    });
    return content ? { pid: Number(content), alive: alive(Number(content)) } : null;
  }
  async archiveCurrent() {
    const summary = await readJson(join(this.runs, 'last-run.json'));
    if (summary?.target?.root) await save(join(this.base, 'snapshots', `${shortHash(summary.target.root)}.json`), summary);
  }
  async start(mission) {
    if (this.active) throw statusError('One mission can run in this checkout. Stop and save the active mission first.', 409);
    const lock = await this.externalRunner();
    if (lock) throw statusError(lock.alive ? 'An existing runner owns this checkout. Its status is available here; stop it in its console before starting another mission.'
      : 'A saved runner lock needs inspection. Confirm that its process has stopped before removing the lock.', 409);
    const argv = this.runnerArgs(mission.nextArgv ?? mission.argv);
    await this.validateArgs(argv);
    if (!(await this.credentials(mission)).configured) return { status: 'CREDENTIALS_REQUIRED', missionId: mission.id };
    await this.archiveCurrent();
    mission.argv = argv; delete mission.nextArgv;
    mission.status = 'STARTING'; mission.error = null; mission.startedAt = now(); mission.finishedAt = null;
    await this.persist();
    let child;
    try { child = this.spawnRunner(argv); }
    catch (error) { mission.status = 'ERROR'; mission.error = error.message; await this.persist(); throw error; }
    const active = { missionId: mission.id, child, heartbeatAt: now(), runId: null };
    this.active = active; mission.pid = child.pid;
    active.exited = new Promise(resolve => { active.resolveExit = resolve; });
    child.on('message', message => {
      // Serialize lifecycle writes with HTTP commands. Receipts must resolve
      // outside that queue because a command may be awaiting the child.
      active.heartbeatAt = now();
      if (message.type === 'receipt') {
        if (message.receipt?.limits) active.limits = message.receipt.limits;
        const pending = this.pending.get(message.id);
        if (pending) { this.pending.delete(message.id); message.error ? pending.reject(new Error(message.error)) : pending.resolve(message.receipt); }
      } else if (message.type === 'heartbeat') return;
      else {
        const operation = this.writer.then(async () => {
          if (message.type === 'target') { mission.target = message.target; mission.name = message.target.name; }
          if (message.type === 'ready') { mission.status = 'RUNNING'; active.runId = message.runId; active.limits = message.limits; }
          if (message.type === 'failure') mission.error = message.error;
          await this.persist();
        });
        this.writer = operation.catch(error => console.error(`Mission Control: ${error.message}`));
      }
    });
    const finish = async (code, error) => {
      if (active.finished) return;
      active.finished = true;
      for (const pending of this.pending.values()) pending.reject(new Error('Runner exited before acknowledging command. Refresh to inspect saved state.'));
      this.pending.clear();
      // Resolve before lifecycle persistence so Stop can finish its command.
      active.resolveExit();
      const operation = this.writer.then(async () => {
        await this.archiveCurrent();
        const summary = await readJson(join(this.runs, 'last-run.json'));
        mission.status = mission.status === 'STOPPING' ? 'STOPPED' : error ? 'ERROR' : summary?.run_id === active.runId ? summary.status : code === 0 ? 'STOPPED' : 'ERROR';
        mission.finishedAt = now(); mission.exitCode = code;
        if (error) mission.error = error.message;
        if (this.active === active) this.active = null;
        await this.persist();
      });
      this.writer = operation.catch(error => console.error(`Mission Control: ${error.message}`));
    };
    child.once('error', error => void finish(null, error));
    child.once('exit', code => void finish(code));
    return { status: 'STARTED', missionId: mission.id };
  }
  async checkLimits() {
    if (this.sampling) return this.sampling;
    this.sampling = (async () => {
      try {
        const response = await this.sampleLimits();
        const snapshot = quotaSnapshot(response);
        this.account = { ...snapshot, checkedAt: now(), attemptedAt: now(), error: null,
          scope: 'Shared Codex account; includes activity outside these missions',
          account: 'Current local Codex account',
          blockReason: snapshot.blocked ? 'Account usage or permission limit reported by Codex' : null };
      } catch (error) { this.account = { ...this.account, attemptedAt: now(), error: error.message }; }
      await save(join(this.base, 'account.json'), this.account);
      return this.account;
    })().finally(() => { this.sampling = null; });
    return this.sampling;
  }
  command(command) {
    const operation = this.writer.then(() => this.apply(command));
    this.writer = operation.catch(() => {});
    return operation;
  }
  async apply(command) {
    if (!safeId(command.id)) throw statusError('A valid command ID is required');
    const path = join(this.base, 'commands', `${command.id}.json`);
    const previous = await readJson(path);
    if (previous) {
      if (previous.action !== command.action || previous.missionId !== (command.missionId ?? null)) throw statusError('Command ID belongs to another action', 409);
      return previous;
    }
    if (command.revision !== this.registry.revision) throw statusError('Mission list changed. Refresh before applying this action.', 409);
    const mission = this.findMission(command.missionId);
    if (command.action !== 'add' && !mission) throw statusError('Mission not found', 404);
    const receipt = { id: command.id, action: command.action, missionId: command.missionId ?? null, status: 'PENDING', requestedAt: now() };
    await save(path, receipt);
    try {
      if (command.action === 'add') {
        if (typeof command.query !== 'string' || !command.query.trim() || command.query.length > 2048) throw statusError('Enter a mission name, URL, or ID');
        if (command.milestone != null && (typeof command.milestone !== 'string' || command.milestone.length > 2048)) throw statusError('Invalid milestone');
        const argv = command.argv ?? ['--mission', command.query.trim(), ...(command.milestone?.trim() ? ['--milestone', command.milestone.trim()] : [])];
        // argv is accepted only from the trusted CLI path, never HTTP (see route).
        await this.validateArgs(argv);
        const option = key => argv.find(a => a.startsWith(`${key}=`))?.slice(key.length + 1)
          ?? (argv.includes(key) ? argv[argv.indexOf(key) + 1] : undefined);
        const normalize = value => String(value ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
        const query = option('--mission-id') ?? option('--mission') ?? command.query;
        const milestone = option('--milestone');
        const duplicate = this.registry.missions.find(m => JSON.stringify(m.argv) === JSON.stringify(argv) ||
          m.target && (milestone ? m.target.kind === 'milestone' &&
            [m.target.id, m.target.name].some(value => value && normalize(value) === normalize(milestone)) : m.target.kind === 'mission') &&
          [m.target.mission?.id, m.target.mission?.mission_id, m.target.mission?.name,
            m.target.kind === 'mission' ? m.target.id : null].some(value => value && normalize(value) === normalize(query)));
        const created = duplicate ?? { id: randomUUID(), name: command.query.trim(), argv, status: 'REGISTERED', createdAt: now() };
        if (!duplicate) { this.registry.missions.push(created); await this.persist(); }
        else if (command.start && !this.active) { created.nextArgv = argv; }
        receipt.result = { missionId: created.id };
        await save(path, receipt);
        if (command.start) receipt.result = await this.start(created);
      } else if (command.action === 'start') receipt.result = await this.start(mission);
      else if (command.action === 'stop') {
        if (!this.active || this.active.missionId !== mission.id || this.active.runId !== command.runId) throw statusError('This managed run is no longer active. Refresh first.', 409);
        mission.status = 'STOPPING'; await this.persist();
        const active = this.active;
        active.child.send({ type: 'stop' });
        let timer;
        try {
          await Promise.race([active.exited, new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('Runner is still saving. Refresh to inspect its status.')), 60000);
          })]);
        } finally { clearTimeout(timer); }
        receipt.result = { status: 'STOPPED', note: 'Existing server submissions may continue.' };
      } else if (command.action === 'set-config') {
        if (this.active || await this.externalRunner()) throw statusError('Stop the runner before editing the full configuration.', 409);
        const { config } = await this.configuration(mission);
        await updateRunnerConfig(config.path, command.config, { revision: command.configRevision });
        await this.persist();
        receipt.result = { status: 'SAVED' };
      } else if (['set-prompt-variant', 'set-runtime-settings'].includes(command.action) && !this.active) {
        if (await this.externalRunner()) throw statusError('Stop the external runner before changing its settings.', 409);
        const { config, limits } = await this.configuration(mission);
        const operator = new MissionCommands({ options: { runs: this.runs, configPath: config.path },
          target: { root: mission.target?.root ?? mission.id }, runId: command.runId,
          signal: new AbortController().signal, limits, wake() {} });
        await operator.load();
        receipt.result = await operator.execute({ ...command, revision: command.controlRevision ?? 0 });
        await this.savedSettings(mission, command);
      } else if (['pause-admission', 'resume-admission', 'pause-dispatch', 'resume-dispatch', 'stop-agents', 'resume-agents', 'set-prompt-variant', 'set-runtime-settings', 'check-quota-now'].includes(command.action)) {
        if (command.action === 'set-prompt-variant' || Object.hasOwn(command, 'promptVariant')) validatePromptVariant(command.promptVariant);
        if (!this.active || this.active.missionId !== mission.id || this.active.runId !== command.runId) throw statusError('This run is not connected to the supervisor. Refresh first.', 409);
        receipt.result = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => { this.pending.delete(command.id); reject(new Error('Acknowledgement timed out. Refresh to inspect the persisted operator pause.')); }, 15000);
          this.pending.set(command.id, { resolve: result => { clearTimeout(timer); resolve(result); }, reject: error => { clearTimeout(timer); reject(error); } });
          this.active.child.send({ type: 'command', command: { id: command.id, action: command.action,
            runId: command.runId, revision: command.controlRevision, settings: command.settings, configRevision: command.configRevision,
            ...(Object.hasOwn(command, 'promptVariant') ? { promptVariant: command.promptVariant } : {}) } });
        });
        if (['set-prompt-variant', 'set-runtime-settings'].includes(command.action)) await this.savedSettings(mission, command);
      } else throw statusError('Unsupported command');
      receipt.status = 'APPLIED'; receipt.appliedAt = now();
    } catch (error) { receipt.status = 'REJECTED'; receipt.error = error.message; }
    await save(path, receipt);
    return receipt;
  }
  async state({ missionId, range = 'run', since: customSince, until: customUntil } = {}) {
    const at = Date.now();
    const lock = await this.externalRunner();
    // Read local observations on every poll, including explicit Refresh. A
    // graph or job can change without a supervisor lifecycle/registry event.
    const [last, jobs] = await Promise.all([readJson(join(this.runs, 'last-run.json')), readJobs(this.runs)]);
    const sources = await Promise.all(this.registry.missions.map(async mission => {
      const root = mission.target?.root;
      const summary = root && last?.target?.root === root ? last : root ? await readJson(join(this.base, 'snapshots', `${shortHash(root)}.json`)) : null;
      const graph = root ? await readJson(join(this.runs, 'graphs', `${encodeURIComponent(root)}.json`)) : null;
      return { mission, summary, graph };
    }));
    const custom = range === 'custom';
    if (custom && (!/(Z|[+-]\d\d:\d\d)$/.test(customSince ?? '') || !/(Z|[+-]\d\d:\d\d)$/.test(customUntil ?? '') ||
      !Number.isFinite(Date.parse(customSince)) || !Number.isFinite(Date.parse(customUntil)) || Date.parse(customSince) >= Date.parse(customUntil))) throw statusError('Custom dates must include a timezone and a start before the end');
    const views = sources.map(source => {
      const managed = this.active?.missionId === source.mission.id;
      const external = !this.active && lock?.alive && source.mission.target?.root === last?.target?.root &&
        (!source.summary?.runner_pid || source.summary.runner_pid === lock.pid);
      const mission = { ...publicMission(source.mission), running: !!(managed || external), managed,
        managedRunId: managed ? this.active.runId : null,
        heartbeatAt: managed ? this.active.heartbeatAt : null,
        processStatus: managed ? source.mission.status : external ? 'EXTERNAL' : source.mission.status === 'SAVED' ? 'STOPPED' : source.mission.status };
      const since = custom ? Date.parse(customSince) : range === 'hour' ? at - 3600000 : range === 'day' ? at - 86400000
        : Date.parse(source.summary?.started_at ?? source.mission.startedAt ?? source.mission.createdAt) || 0;
      return buildMissionView({ ...source, mission, jobs, since, until: custom ? Date.parse(customUntil) : at + 1 });
    });
    const selected = views.find(v => v.mission.id === missionId || v.mission.aliases?.includes(missionId))
      ?? views.find(v => v.mission.running)
      ?? views.find(v => v.mission.target?.root && v.mission.target.root === last?.target?.root)
      ?? views.at(-1) ?? null;
    if (selected) {
      const entry = this.findMission(selected.mission.id);
      const source = selected.mission.running && !selected.mission.managed && selected.summary?.config_path
        ? { argv: [...withoutOptions(entry.argv, ['--config']), '--config', selected.summary.config_path] } : entry;
      const { config, limits, overrides } = await this.configuration(source);
      const controls = await readJson(join(this.base, 'controls', `${encodeURIComponent(entry.target?.root ?? entry.id)}.json`));
      const revision = controls?.revision ?? 0;
      if (controls && selected.summary) {
        const { receipts, promptVariant, runtimeSettings, ...operator } = controls;
        selected.summary.operator = operator;
      }
      const live = selected.mission.running ? selected.mission.managed
        ? this.active.limits ?? (selected.summary?.run_id === this.active.runId ? selected.summary.limits : null)
        : selected.summary?.limits : null;
      const changedKeys = live ? Object.keys(config.values).filter(key => JSON.stringify(config.values[key]) !== JSON.stringify(live[key])) : [];
      selected.configSettings = { values: config.values, path: config.path, configRevision: config.revision,
        revision, overrides, runningValues: live ?? null, pending: !!live && changedKeys.length > 0, changedKeys,
        effectiveValues: limits };
      selected.promptSettings = { promptVariant: config.values.promptVariant, revision };
    }
    if (selected?.summary?.mission_research?.latest && safeId(selected.mission.target?.root)) {
      const latest = selected.summary.mission_research.latest;
      if (/^[a-f0-9]{64}$/.test(latest.epoch) && safeId(latest.id)) {
        const dir = join(this.runs, 'mission-research', selected.mission.target.root, latest.epoch, latest.id);
        const manifest = await readJson(join(dir, 'manifest.json'));
        const notes = await readFile(join(dir, 'notes.md'), 'utf8').catch(() => null);
        selected.research = { notes, createdAt: manifest?.created_at, sources: (manifest?.resources ?? []).map(r => ({ url: r.url, purpose: r.purpose })) };
      }
    }
    const uniqueResults = new Map(views.flatMap(v => v.results).map(r => [r.submission_id, r]));
    const uniqueLeaves = new Set(views.flatMap(v => v.frontier?.leafIds ?? []));
    return { revision: this.registry.revision, observedAt: now(), singleRunner: true,
      lock: lock ? { alive: lock.alive, managed: !!this.active } : null,
      account: { ...this.account, checking: !!this.sampling }, selected,
      credentials: await this.credentials(selected ? this.findMission(selected.mission.id) : null),
      missions: views.map(v => ({ mission: v.mission, counts: v.counts, frontier: v.frontier,
        currentWork: v.jobs.filter(j => j.job_status === 'ACTIVE').map(j => ({
          theorem_id: j.theorem_id, theorem_name: j.theorem_name, job_status: j.job_status,
          stage: j.stage, operation: j.operation, dispatch_state: j.dispatch_state,
          running: j.running, worker_model: j.worker_model, model: j.model, remote_issued: j.remote_issued,
          waiting_reason: j.waiting_reason,
        })),
        rootStatus: v.summary?.root_status ?? null, pipeline: v.summary?.pipeline,
        lastEvent: v.activity[0], attention: v.jobs.filter(j => j.waiting_reason || j.job_status === 'NEEDS_ATTENTION' || /UNKNOWN/.test(j.status ?? '')).length })),
      totals: { proofs: [...uniqueResults.values()].filter(r => r.kind === 'proof').length,
        sketches: [...uniqueResults.values()].filter(r => r.kind === 'reduction').length,
        sketched_theorems: new Set([...uniqueResults.values()].filter(r => r.kind === 'reduction').map(r => r.theorem_id)).size,
        uniqueOpenLeaves: views.some(v => !v.frontier) ? null : uniqueLeaves.size,
        pending: new Set(views.flatMap(v => v.pending).map(p => p.submission_id ?? p.publication_id ?? p.operation_id ?? p.theorem_id)).size },
      range };
  }
  async close() {
    this.closing = true;
    clearInterval(this.sampleTimer);
    if (this.active && !this.active.finished) { this.active.child.send({ type: 'stop' }); await this.active.exited; }
    await this.missionRefresh;
    await this.writer;
    await this.sampling;
  }
}

export async function createMissionControlServer(options = {}) {
  const control = options.control ?? new MissionControl(options);
  await mkdir(control.base, { recursive: true });
  const lockPath = join(control.base, 'server.lock');
  let lock;
  try { lock = openSync(lockPath, 'wx'); writeFileSync(lock, String(process.pid)); }
  catch (error) {
    if (lock !== undefined) { closeSync(lock); await rm(lockPath, { force: true }); }
    if (error.code === 'EEXIST') throw new Error('Mission Control already owns this checkout. Use its console URL. After a crash, confirm the recorded PID is stopped before removing .runs/mission-control/server.lock.');
    throw error;
  }
  const release = () => {
    if (lock === undefined) return;
    closeSync(lock); lock = undefined;
    try { unlinkSync(lockPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  };
  process.once('exit', release);
  try {
    await control.init();
    const token = randomBytes(32).toString('hex'), csrf = randomBytes(24).toString('hex');
    const staticFiles = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'],
      '/model-picker.js': ['model-picker.js', 'text/javascript'], '/mission-settings.js': ['mission-settings.js', 'text/javascript'], '/styles.css': ['styles.css', 'text/css'] };
    const server = createServer(async (req, res) => {
      const reply = (status, value, type = 'application/json') => {
        res.writeHead(status, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
          'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" });
        res.end(type === 'application/json' ? redact(value, control.secrets) : value);
      };
      try {
        const port = server.address().port;
        const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
        if (!hosts.includes(req.headers.host)) throw statusError('Invalid host', 403);
        const origin = `http://${req.headers.host}`;
        const url = new URL(req.url, origin);
        if (req.method === 'GET' && staticFiles[url.pathname]) {
          const [file, type] = staticFiles[url.pathname];
          return reply(200, await readFile(join(ROOT, 'mission-control', file), 'utf8'), type);
        }
        if (req.method !== 'GET' && req.headers.origin !== origin) throw statusError('Same-origin requests are required', 403);
        if (url.pathname === '/api/session' && req.method === 'POST') {
          if (req.headers.authorization !== `Bearer ${token}`) throw statusError('Use the Mission Control URL printed in the console to sign in.', 401);
          res.setHeader('Set-Cookie', `mission_control=${token}; HttpOnly; SameSite=Strict; Path=/`);
          return reply(200, { csrf });
        }
        const authenticated = (req.headers.cookie ?? '').split(';').some(cookie => cookie.trim() === `mission_control=${token}`);
        if (!authenticated) throw statusError('Open the authenticated Mission Control URL printed in the console.', 401);
        if (req.method !== 'GET' && req.headers['x-csrf-token'] !== csrf) throw statusError('Session expired. Reopen Mission Control from the console URL.', 403);
        if (url.pathname === '/api/session' && req.method === 'GET') return reply(200, { csrf });
        if (url.pathname === '/api/state' && req.method === 'GET') return reply(200, await control.state(Object.fromEntries(url.searchParams)));
        if (url.pathname === '/api/limits' && req.method === 'POST') return reply(200, await control.checkLimits());
        if (url.pathname === '/api/refresh-missions' && req.method === 'POST') {
          void control.refreshMissions().catch(error => console.error(`Mission refresh: ${redact(error.message, control.secrets)}`));
          return reply(202, { status: 'REFRESHING' });
        }
        if (url.pathname === '/api/credentials' && req.method === 'POST') {
          let body = '';
          for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 8192) throw statusError('Credentials request too large', 413); }
          let parsed;
          try { parsed = JSON.parse(body); } catch { throw statusError('Invalid credentials request'); }
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw statusError('Invalid credentials request');
          const operation = control.writer.then(() => control.saveCredentials(parsed));
          control.writer = operation.catch(() => {});
          return reply(200, await operation);
        }
        if (url.pathname === '/api/command' && req.method === 'POST') {
          let body = '';
          for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 8192) throw statusError('Command too large', 413); }
          const parsed = JSON.parse(body);
          if (Object.hasOwn(parsed, 'argv')) throw statusError('Runner arguments cannot be supplied over HTTP');
          return reply(200, await control.command(parsed));
        }
        if (url.pathname === '/api/artifacts' && req.method === 'GET') {
          const view = (await control.state({ missionId: url.searchParams.get('missionId') })).selected;
          const id = url.searchParams.get('theorem');
          if (!view || !view.jobs.some(j => j.theorem_id === id)) throw statusError('Theorem is outside the selected mission', 404);
          const name = url.searchParams.get('name');
          return reply(200, name ? await readArtifact(control.runs, id, name) : await artifactList(control.runs, id));
        }
        if (url.pathname === '/api/export' && req.method === 'GET') {
          const state = await control.state(Object.fromEntries(url.searchParams));
          if (!state.selected) throw statusError('Select a mission to export', 400);
          res.setHeader('Content-Disposition', 'attachment; filename="mission-report.json"');
          return reply(200, { exportedAt: now(), ...state.selected, account: state.account });
        }
        throw statusError('Not found', 404);
      } catch (error) { reply(error.status ?? 400, { error: error.message }); }
    });
    server.requestTimeout = 75000;
    server.once('close', () => { release(); process.off('exit', release); });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? 4317, '127.0.0.1', resolve); });
    const address = `http://127.0.0.1:${server.address().port}`;
    if (options.sampling !== false) {
      void control.checkLimits().catch(error => console.error(`Account sampler: ${error.message}`));
      control.sampleTimer = setInterval(() => void control.checkLimits().catch(error => console.error(`Account sampler: ${error.message}`)), control.samplerInterval).unref();
    }
    return { server, control, url: `${address}/#session=${token}`, address, csrf,
      close: async () => { await control.close(); await new Promise(resolve => server.close(resolve)); } };
  } catch (error) { release(); process.off('exit', release); throw error; }
}

export function openMissionControlBrowser(url, { platform = process.platform, spawnProcess = spawn } = {}) {
  const command = platform === 'win32' ? 'powershell.exe' : platform === 'darwin' ? 'open' : 'xdg-open';
  const args = platform === 'win32'
    ? ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', 'Start-Process -FilePath $env:PROVE2ME_UI_URL']
    : [url];
  return new Promise((resolve, reject) => {
    const child = spawnProcess(command, args, {
      windowsHide: true, stdio: 'ignore', timeout: 10000,
      ...(platform === 'win32' ? { env: { ...process.env, PROVE2ME_UI_URL: url } } : {}),
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Browser launcher ${signal ? `stopped (${signal})` : `exited with ${code}`}`));
    });
  });
}

export async function launchMissionControl(argv = [], {
  openBrowser = openMissionControlBrowser, control = new MissionControl(), ...serverOptions
} = {}) {
  let port = 4317;
  const runnerArgs = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--ui') continue;
    if (argv[i] === '--port' || argv[i].startsWith('--port=')) {
      port = Number(argv[i].includes('=') ? argv[i].split('=')[1] : argv[++i]);
      if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('--port must be between 1 and 65535');
    } else runnerArgs.push(argv[i]);
  }
  const launch = runnerArgs.length ? await control.validateArgs(runnerArgs) : null;
  const app = await createMissionControlServer({ ...serverOptions, port: serverOptions.port ?? port, control });
  console.log(`\nMission Control: ${app.url}\nConsole logs continue here. One running mission per checkout.\n`);
  void Promise.resolve().then(() => openBrowser(app.url)).catch(() => {
    console.warn('Could not open the browser automatically. Open the Mission Control URL printed above. Console logs continue here.');
  });
  let closing = false;
  const close = async () => {
    if (closing) return; closing = true;
    console.log('Saving the managed runner and closing Mission Control…');
    await app.close();
    process.off('SIGINT', close); process.off('SIGTERM', close);
  };
  process.on('SIGINT', close); process.on('SIGTERM', close);
  app.server.once('close', () => { process.off('SIGINT', close); process.off('SIGTERM', close); });
  if (launch) {
    const receipt = await control.command({ id: randomUUID(), revision: control.registry.revision,
      action: 'add', query: launch.query, argv: runnerArgs, start: true });
    if (receipt.status === 'REJECTED') console.error(receipt.error);
  }
  return app;
}
