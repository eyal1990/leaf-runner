#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as cancellableDelay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { closeSync, openSync, unlinkSync, writeFileSync } from 'node:fs';
import { lstat, mkdir, open, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { ApiError, transientReadError } from './api-errors.mjs';
import { ApiRecovery } from './api-recovery.mjs';
import { loadApiKey } from './credentials-store.mjs';
import { idOf, enc, digest, json, sleep, save, exists, progress, latestLogOutput, targetFingerprint, cleanExplanation, readJson, writeIfChanged } from './runner-state.mjs';
import { moduleFor, imports, ANSWER_SCHEMA, AnswerFormatError, answerPayload, normalizeSolutionDeclaration } from './lean-artifacts.mjs';
import { runSerialJob } from './serial-jobs.mjs';
import { codexQuotaFailure, readCodexRateLimits } from './codex-quota.mjs';
import { Pipeline, pipelineLimits } from './pipeline.mjs';
import { connectRunnerControl } from './mission-control-commands.mjs';
import { scoreWork } from './work-policy.mjs';
import { appendEvent } from './attempt-history.mjs';
import { buildGraph as previewGraph } from './work-selection.mjs';
import { JobPersistenceError } from './job-store.mjs';
import { createWorkspaceManager, environmentIdentity, releaseWorkspace } from './isolated-workspaces.mjs';
import { updateWorkspaceDocumentation } from './workspace-updates.mjs';
import { withBuildSlot, withSetupSlot, boundedResource } from './shared-resources.mjs';
import { publishCompiledDependencies } from './compiled-dependencies.mjs';
import { serverOnly, verificationMode } from './verification-mode.mjs';
import { readRunnerConfig } from './runner-config-store.mjs';
import { attemptModel, modelProfile } from './model-policy.mjs';
import { agentPrompt, answerRepairPrompt, workspaceInstructions } from './agent-prompts.mjs';
import { REVIEW_SCHEMA, REVIEW_MODEL, missionReviewPrompt } from './mission-research.mjs';
import { openTheoremLibrary } from './theorem-library.mjs';
import { codexSandboxRecovery } from './codex-sandbox-recovery.mjs';
import { discoverFrontier, findTarget, openLeaves, selectTargetQuery, WorkSelection, retryGraphRefreshError } from './work-selection.mjs';

// Preserve the runner's existing exports for callers.
export { moduleFor, leanTokens, imports, gate, normalizeAnswer, decomposition, AnswerFormatError, typeCheckSource } from './lean-artifacts.mjs';
export { poll, pollPublish, publishArtifacts } from './remote-actions.mjs';
export { ApiError } from './api-errors.mjs';
export { buildGraph, selectCandidate, discoverFrontier, findTarget, openLeaves } from './work-selection.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const API = 'https://prove2.me/api/v1/';
const REPO = 'https://github.com/prove2me/prove2me_workspace.git';
const FIRST_MODEL = 'gpt-6-luna';

export class Client {
  constructor(key, fetcher = fetch, { report = () => {}, retryDelay = 1000, wait = sleep, apiConcurrency = pipelineLimits().apiConcurrency, credentialSource = 'the configured API key' } = {}) {
    this.key = key; this.fetcher = fetcher; this.token = null; this.expiry = 0; this.report = report;
    this.credentialSource = credentialSource;
    this.retryDelay = retryDelay; this.wait = wait; this.tokenGeneration = 0;
    if (!Number.isSafeInteger(apiConcurrency) || apiConcurrency < 1) throw new Error('API concurrency must be a positive integer');
    this.withApiSlot = boundedResource(apiConcurrency);
  }
  async raw(path, options = {}) {
    return this.withApiSlot(() => this.rawWithPermit(path, options));
  }
  async rawWithPermit(path, options = {}) {
    this.signal?.throwIfAborted();
    const url = new URL(path, API);
    if (url.origin !== 'https://prove2.me' || !url.pathname.startsWith('/api/v1/') ||
        url.username || url.password || url.hash || path.includes('\\')) throw new Error('Invalid API URL');
    // Log only method/path, never authentication headers, bodies, or query values.
    const label = `${options.method ?? 'GET'} ${url.pathname}`;
    const method = (options.method ?? 'GET').toUpperCase();
    const quiet = method === 'GET' &&
      /^\/api\/v1\/theorems\/[^/]+\/decompositions$/.test(url.pathname);
    const verification = url.pathname === '/api/v1/verify';
    const started = Date.now(), elapsed = () => ((Date.now() - started) / 1000).toFixed(1);
    if (!quiet && method !== 'GET' && !verification) this.report(label);
    const heartbeat = quiet ? undefined : setInterval(() => this.report(`Waiting for ${label} (${elapsed()}s; request timeout: 60s)`), 15000);
    try {
      const timeout = AbortSignal.timeout(60000);
      const signals = [this.signal, options.signal, timeout].filter(Boolean);
      const response = await this.fetcher(url, { ...options, redirect: 'error', signal: AbortSignal.any(signals) });
      if (!response.ok) {
        const error = new ApiError(response.status, url.pathname);
        const retryAfter = response.headers?.get('Retry-After');
        if (retryAfter) {
          const delay = /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now();
          if (Number.isFinite(delay)) error.retryAfterMs = Math.max(0, delay);
        }
        await response.body?.cancel(); throw error;
      }
      const result = await response.json();
      if (!quiet) this.report(`${label} completed (${elapsed()}s)`);
      return result;
    } catch (error) {
      this.report(`${label} failed (${elapsed()}s): ${error instanceof ApiError ? `HTTP ${error.status}` : error.name}`);
      throw error;
    } finally { clearInterval(heartbeat); }
  }
  async refresh() {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      const auth = await this.raw('agent/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ api_key: this.key }) });
      if (typeof auth.access_token !== 'string' || !Number.isFinite(auth.expires_at)) throw new Error('Invalid token response');
      this.token = auth.access_token;
      this.expiry = auth.expires_at * 1000;
      this.version = auth.version;
      this.tokenGeneration++;
    })();
    try { await this.refreshing; }
    catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        error.message = `Prove2.me authentication failed: the server rejected ${this.credentialSource} (HTTP 401 at /api/v1/agent/refresh). Get a valid key from the Prove2.me account menu > API key, then update ${this.credentialSource} and rerun the command.`;
      }
      throw error;
    }
    finally { this.refreshing = null; }
  }
  async request(path, options = {}) {
    return this.recovery ? this.recovery.request(path, options) : this.requestOnce(path, options);
  }
  async requestOnce(path, options = {}) {
    options.signal?.throwIfAborted();
    if (!this.token || this.expiry < Date.now() + 30000) await this.refresh();
    let renewed = false;
    for (let retries = 0; ; ) {
      options.signal?.throwIfAborted();
      const generation = this.tokenGeneration;
      try { return await this.raw(path, { ...options, headers: { ...options.headers, Authorization: `Bearer ${this.token}` } }); }
      catch (error) {
        options.signal?.throwIfAborted();
        // A 401 rejects the request before queuing it; never retry an uncertain POST.
        if (error instanceof ApiError && error.status === 401 && !renewed) {
          renewed = true;
          // A late failure from an older token must not invalidate the new one.
          if (generation === this.tokenGeneration) await this.refresh();
          continue;
        }
        if (this.recovery) throw error;
        if ((options.method ?? 'GET').toUpperCase() !== 'GET' || !transientReadError(error) || retries >= 2) throw error;
        const delay = this.recovery ? error.retryAfterMs ?? this.retryDelay * 2 ** retries
          : Math.min(10000, error.retryAfterMs ?? this.retryDelay * 2 ** retries);
        retries++;
        this.report(`Retrying GET ${new URL(path, API).pathname} (${retries}/2) in ${(delay / 1000).toFixed(1)}s`);
        if (this.wait === sleep) await cancellableDelay(delay, undefined, { signal: options.signal ?? this.signal });
        else await this.wait(delay);
      }
    }
  }
  async pages(path, key, { until, limit = 100 } = {}) {
    const rows = [], seen = new Set();
    for (let offset = 0; ; ) {
      const url = new URL(path, API);
      url.searchParams.set('limit', String(limit)); url.searchParams.set('offset', String(offset));
      const page = await this.request(url.href);
      const items = page[key], total = page.total ?? page.pagination?.total;
      if (!Array.isArray(items) || !Number.isSafeInteger(total) || total < 0) throw new Error(`Invalid ${key} pagination`);
      for (const item of items) {
        // Collection rows can carry both their own ID and a foreign theorem_id.
        // In particular, distinct submissions for one theorem are distinct rows.
        const id = item.id ?? item.submission_id ?? idOf(item);
        if (!id || seen.has(id)) throw new Error(`Unstable ${key} pagination; rerun discovery`);
        seen.add(id); rows.push(item);
      }
      offset += items.length;
      if (total > 0) this.report(`Loaded ${rows.length}/${total} ${key}`);
      if (offset >= total || until?.(rows)) return rows;
      if (!items.length || offset > 100000) throw new Error(`Incomplete ${key} pagination`);
    }
  }
  async submit(theoremId, source, explanation, proofType = 'prove') {
    if (!['prove', 'disprove'].includes(proofType)) throw new Error('Invalid proof type');
    const form = new FormData();
    form.set('theorem_id', theoremId); form.set('proof_type', proofType);
    form.set('file', new Blob([source], { type: 'text/plain' }), 'solution.lean');
    form.set('explanation', cleanExplanation(explanation));
    return this.request('verify', { method: 'POST', body: form });
  }
  async publish(kind, artifact, target) {
    const payload = { ...artifact, env: target.mathlib_rev, private: target.visibility !== 'public' };
    return this.request(kind === 'definition' ? 'submit-definition' : 'submit-problem', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
  }
}

export async function mirror(client, workspace, source, target, {
  direct = false, knownDependencies = [], cacheDir = join(ROOT, '.cache/dependencies'), localModules = new Map(),
  resolvedDependencies = new Map(), onDependency = () => {},
  sourceOnly = false,
} = {}) {
  const files = new Map(), visiting = new Set();
  const known = new Map(knownDependencies.map(row => [moduleFor(row.definition_id ? { ...row, status: 'Definition' } : row), idOf(row)]));
  const canFallback = error => error instanceof ApiError && [400, 404, 405, 501].includes(error.status) || transientReadError(error);
  async function resolveDependency(module, slug) {
    // The live catalog excludes definitions unless explicitly requested, even
    // for exact-name searches. Apply the filter to both discovery paths.
    const statusFilter = module.startsWith('Definitions.') ? '&status=Definition' : '';
    const nativeDefinition = row => row?.definition_id ? { ...row, status: 'Definition', theorem_name: row.definition_name } : row;
    const definitionEndpointFallback = error => statusFilter && error instanceof ApiError && [400, 404, 405, 422, 501].includes(error.status);
    async function catalog(query, exact = false) {
      try { return await client.pages(`theorems?env=${enc(target.mathlib_rev)}${statusFilter}&${query}`, 'theorems'); }
      catch (error) {
        if (!definitionEndpointFallback(error)) throw error;
        const nativeQuery = exact ? `definition_name=${enc(slug)}` : query;
        return (await client.pages(`definitions?env=${enc(target.mathlib_rev)}&${nativeQuery}`, 'definitions')).map(nativeDefinition);
      }
    }
    const cachePath = join(cacheDir, digest(`${target.mathlib_rev}:${module}`) + '.json');
    let cached;
    try { cached = JSON.parse(await readFile(cachePath, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    const cachedId = cached?.module === module && cached.mathlib_rev === target.mathlib_rev && typeof cached.id === 'string' ? cached.id : undefined;
    const hintedId = known.get(module) ?? cachedId;
    async function detail(id) {
      let row;
      try { row = await client.request(`theorems/${enc(id)}`); }
      catch (error) {
        if (!definitionEndpointFallback(error)) throw error;
        row = await client.request(`definitions/${enc(id)}`);
      }
      row = nativeDefinition(row);
      if (idOf(row) !== id || row.mathlib_rev !== target.mathlib_rev || moduleFor(row) !== module) throw new Error('Dependency identity/environment mismatch');
      return row;
    }
    let row;
    if (hintedId) {
      try { row = await detail(hintedId); }
      catch (error) { if (!canFallback(error)) throw error; client.report?.(`Known ID lookup unavailable for ${module}; trying exact name`); }
    }
    if (!row) {
      client.report?.(`Resolving ${module} by exact name`);
      let rows = [];
      try { rows = await catalog(`theorem_name=${enc(slug)}`, true); }
      catch (error) { if (!canFallback(error)) throw error; client.report?.(`Exact lookup unavailable for ${module}; trying keyword search`); }
      let matches = rows.filter(candidate => moduleFor(candidate) === module);
      if (!matches.length) {
        // Dots in theorem names become underscores in module names and cannot
        // be reconstructed reliably. Definitions use their name verbatim.
        const keyword = slug.split('_').sort((a, b) => b.length - a.length)[0];
        client.report?.(`Resolving ${module} by keyword fallback`);
        rows = await catalog(`q=${enc(keyword)}`);
        matches = rows.filter(candidate => moduleFor(candidate) === module);
      }
      if (matches.length !== 1) throw new Error(`Cannot uniquely resolve ${module} in target environment (${matches.length} exact module matches)`);
      row = await detail(idOf(matches[0]));
    }
    // Revalidate against the live detail endpoint on every mirror operation;
    // cached source is never used to bypass permissions or freshness checks.
    return { row, cachePath };
  }
  async function visit(module, requireProved) {
    if (!module.startsWith('Theorems.') && !module.startsWith('Definitions.')) return;
    if (module === moduleFor(target)) throw new Error('Dependency imports the target (circular proof)');
    if (visiting.has(module)) throw new Error(`Circular platform imports: ${module}`);
    if (files.has(module)) return;
    visiting.add(module);
    const slug = module.split('.')[1]?.replace(/^(?:Thm_|Def_)/, '');
    if (!slug || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(slug)) throw new Error(`Unsupported import ${module}`);
    let resolved;
    try {
      resolved = localModules.has(module) ? { row: localModules.get(module) }
        : resolvedDependencies.has(module) ? { row: resolvedDependencies.get(module) } : await resolveDependency(module, slug);
    }
    catch (error) { error.message += ` while resolving ${module}`; throw error; }
    const { row, cachePath } = resolved;
    if (row.deprecated_at) throw new Error(`Deprecated dependency ${module}`);
    if (!['Definition', 'Open', 'Proved'].includes(row.status)) throw new Error(`Unavailable dependency ${module} (${row.status})`);
    if (requireProved && row.status !== 'Definition' && row.status !== 'Proved') throw new Error(`Open dependency ${module}; direct proofs require Proved dependencies`);
    if (!localModules.has(module)) resolvedDependencies.set(module, row);
    onDependency(row);
    const content = row.status === 'Definition' ? row.definition : `${row.preamble ?? ''}\n${row.formal_statement}\n`;
    if (typeof content !== 'string' || !content.trim() || content.includes('undefined')) throw new Error(`Missing Lean source for ${module}`);
    if (cachePath) await save(cachePath, { module, mathlib_rev: target.mathlib_rev, id: idOf(row), content, source_hash: digest(content) });
    for (const child of imports(content)) await visit(child, false);
    files.set(module, content); visiting.delete(module);
    if (files.size > 2000) throw new Error('Too many platform dependencies');
  }
  for (const module of imports(source)) await visit(module, direct);
  if (!sourceOnly) for (const [module, content] of files) await writeIfChanged(join(workspace, module.replaceAll('.', '/') + '.lean'), content);
  return [...files.keys()];
}

// No shell interpolation. npm's Windows Codex shim is launched through Node.
export async function executable(name) {
  // Resolve relative to this runner, not the caller's cwd or npm's PATH.
  if (name === 'codex') {
    const cli = join(ROOT, 'node_modules/@openai/codex/bin/codex.js');
    if (await exists(cli)) return [process.execPath, cli];
    throw new Error('Project Codex dependency is missing. Run npm install in the runner project.');
  }
  const directories = name.includes('/') || name.includes('\\') ? [''] : (process.env.PATH ?? '').split(delimiter);
  const extensions = process.platform === 'win32' ? ['', '.exe', '.cmd'] : [''];
  for (const directory of directories) for (const ext of extensions) {
    const path = directory ? join(directory, name + ext) : resolve(name + ext);
    if (!await exists(path)) continue;
    if (path.endsWith('.cmd')) {
      if (/codex/i.test(name)) {
        for (const cli of [join(dirname(path), 'node_modules/@openai/codex/bin/codex.js'), join(dirname(path), '../@openai/codex/bin/codex.js')]) {
          if (await exists(cli)) return [process.execPath, cli];
        }
      }
      continue;
    }
    return [path];
  }
  throw new Error(name === 'codex'
    ? 'Cannot find Codex. Run npm install in the runner project, or provide --codex PATH.'
    : `Cannot find ${name}. Install it or provide its executable path.`);
}
export function childEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^PROVE2ME_/i.test(key)));
}
const activeChildren = new Set();

function stopChildren() {
  for (const child of activeChildren) {
    if (!child.pid) continue;
    if (process.platform === 'win32') {
      const result = spawnSync(join(process.env.SystemRoot ?? 'C:/Windows', 'System32/taskkill.exe'),
        ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 10000 });
      if (result.error || result.status !== 0) {
        // taskkill also fails when the child has already exited.
        try { process.kill(child.pid, 0); }
        catch (error) { if (error.code === 'ESRCH') continue; throw error; }
        throw new Error(`Could not stop child process ${child.pid}; keeping runner lock`);
      }
    } else {
      try { process.kill(-child.pid, 'SIGKILL'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  }
}

export function acquireRunnerLock(lockPath, { interrupt } = {}) {
  let fd;
  try { fd = openSync(lockPath, 'wx'); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    throw new Error(`Another run owns ${lockPath}. If it crashed, confirm its PID is no longer running, then remove this lock file.`);
  }
  const release = () => {
    if (fd === undefined) return;
    closeSync(fd); fd = undefined;
    try { unlinkSync(lockPath); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  };
  try { writeFileSync(fd, String(process.pid)); }
  catch (error) { release(); throw error; }
  // Exit hooks must be synchronous. Stop writers before allowing another run in.
  const onExit = () => {
    try { stopChildren(); release(); }
    catch (error) { console.error(error.message); }
  };
  const onInterrupt = () => {
    console.error('Interrupted; stopping child processes and releasing runner lock.');
    if (interrupt) interrupt(130); else process.exit(130);
  };
  const onTerminate = () => { if (interrupt) interrupt(143); else process.exit(143); };
  process.on('exit', onExit);
  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onTerminate);
  return () => {
    release();
    process.off('exit', onExit);
    process.off('SIGINT', onInterrupt);
    process.off('SIGTERM', onTerminate);
  };
}

export async function command(exe, args, { cwd, log, timeout = 3600000, input, env = childEnv(), quiet = false, signal, label = exe, showOutput = false } = {}) {
  signal?.throwIfAborted();
  if (!quiet) progress(`Starting ${label}; log: ${log}`);
  const prefix = await executable(exe);
  await mkdir(dirname(log), { recursive: true });
  const handle = await open(log, 'w');
  if (signal?.aborted) { await handle.close(); signal.throwIfAborted(); }
  const child = spawn(prefix[0], [...prefix.slice(1), ...args], { cwd, env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', handle.fd, handle.fd] });
  activeChildren.add(child);
  let timedOut = false, cancelled = false, stopping = false;
  let cleanup = Promise.resolve();
  const stop = () => {
    if (stopping) return;
    stopping = true;
    if (process.platform === 'win32' && child.pid) {
      // Kill only this runner's process tree, including Codex's shell/Lean children.
      cleanup = new Promise(done => {
        const killer = spawn(join(process.env.SystemRoot ?? 'C:/Windows', 'System32/taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.once('error', () => { child.kill(); done(); }); killer.once('exit', () => { child.kill(); done(); });
      });
    } else {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    }
  };
  const abort = () => { cancelled = true; stop(); };
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => { timedOut = true; stop(); }, timeout);
  const startedAt = Date.now();
  let finished = false, reporting = false, succeeded = false;
  const heartbeat = quiet ? null : setInterval(async () => {
    if (reporting) return;
    reporting = true;
    try {
      const output = showOutput ? await latestLogOutput(log) : undefined;
      if (!finished) progress(`${label} still running (${Math.round((Date.now() - startedAt) / 1000)}s elapsed)${output ? `; latest output: ${output}` : ''}; log: ${log}`);
    } catch { /* A progress read must not interrupt the supervised command. */ }
    finally { reporting = false; }
  }, 30000);
  try {
    const code = await new Promise((res, rej) => {
      child.once('error', rej); child.once('exit', res);
      child.stdin.on('error', () => {}); child.stdin.end(input);
    });
    if (cancelled) throw signal.reason ?? new Error(`${exe} cancelled. See ${log}`);
    if (timedOut) throw Object.assign(new Error(`${exe} timed out after ${timeout / 1000}s. See ${log}`), { code: 'COMMAND_TIMEOUT' });
    if (code !== 0) throw new Error(`${exe} exited with ${code}. See ${log}`);
    succeeded = true;
    if (!quiet) progress(`${label} completed (${Math.round((Date.now() - startedAt) / 1000)}s elapsed); log: ${log}`);
  } finally {
    finished = true; clearTimeout(timer); clearInterval(heartbeat); signal?.removeEventListener('abort', abort);
    await cleanup; activeChildren.delete(child); await handle.close();
    await save(`${log}.timing.json`, { label, duration_ms: Date.now() - startedAt,
      outcome: succeeded ? 'completed' : cancelled ? 'cancelled' : timedOut ? 'timed_out' : 'failed' });
  }
}

function pins(environment) {
  if (!/^[a-f0-9]{40}$/.test(environment.mathlib_rev) || !/^leanprover\/lean4:v[0-9A-Za-z.-]+$/.test(environment.toolchain)) throw new Error('Invalid environment pin');
  return `import Lake\nopen Lake DSL\npackage «prove2me_runner» where\n  leanOptions := #[⟨\`autoImplicit, false⟩]\nrequire mathlib from git "https://github.com/leanprover-community/mathlib4.git" @ "${environment.mathlib_rev}"\nlean_lib «Definitions»\nlean_lib «Theorems»\n@[default_target]\nlean_lib «Solutions»\n`;
}
export async function initializeEnvironment(workspace, environment, options, hooks = {}) {
  options.signal?.throwIfAborted();
  const execute = hooks.command ?? command;
  const run = (exe, args, settings) => withBuildSlot(() => execute(exe, args, { ...settings, signal: options.signal }), settings.label);
  console.log(`Preparing workspace for ${environment.toolchain}`);
  await mkdir(dirname(workspace), { recursive: true });
  await execute('git', ['clone', '--depth', '1', REPO, workspace], { cwd: ROOT,
    log: join(options.runs, `clone-${environment.mathlib_rev}.log`), signal: options.signal });
  await updateWorkspaceDocumentation(workspace, options, { command: execute, wait: hooks.wait });
  await Promise.all(['Definitions', 'Theorems', 'Solutions'].map(d => mkdir(join(workspace, d), { recursive: true })));
  await writeFile(join(workspace, 'lean-toolchain'), environment.toolchain + '\n');
  await writeFile(join(workspace, 'lakefile.lean'), pins(environment));
  await writeFile(join(workspace, 'AGENTS.md'), workspaceInstructions(options));
  if (serverOnly(options)) {
    // Supply pinned Mathlib sources for the agent's research using Git only.
    // No Lake update/cache command or toolchain installation is needed.
    const mathlib = join(workspace, '.lake', 'packages', 'mathlib');
    await mkdir(mathlib, { recursive: true });
    for (const args of [['init'], ['remote', 'add', 'origin', 'https://github.com/leanprover-community/mathlib4.git'],
      ['fetch', '--depth', '1', 'origin', environment.mathlib_rev], ['checkout', '--detach', 'FETCH_HEAD']]) {
      await execute('git', args, { cwd: mathlib, log: join(options.runs, `${environment.mathlib_rev}-sources-${args[0]}.log`),
        signal: options.signal, label: `Mathlib sources ${args[0]}` });
    }
    return;
  }
  console.log('Downloading the pinned Mathlib dependencies and prebuilt cache (first run).');
  for (const [label, args] of [['update', ['update']], ['cache', ['exe', 'cache', 'get']], ['smoke', ['build', 'Solutions.SmokeTest']]]) {
    await run(options.lake, args, { cwd: workspace, log: join(options.runs, `${environment.mathlib_rev}-${label}.log`), timeout: (options.leanTimeout ?? 3600) * 1000,
      label: `Lean environment ${label}`, showOutput: true });
  }
}
const isolatedWorkspace = createWorkspaceManager(initializeEnvironment);
export function workspaceIdentity(environment, options) {
  const configuration = pins(environment) + workspaceInstructions(options);
  return environmentIdentity(environment, options, configuration);
}
export async function ensureWorkspace(environment, options) {
  options = { ...options, apiVersion: options.getApiVersion?.() ?? options.apiVersion };
  return isolatedWorkspace(environment, options, workspaceIdentity(environment, options));
}

export class EnvironmentError extends Error {}

// A readiness probe chooses the fallback before any model invocation. Keep the
// choice shared with proof, formatting and research calls for this CLI binary.
const windowsSandboxFallbacks = new Map();
function windowsSandboxSelection(options) {
  return options.windowsSandbox ?? options['windows-sandbox'] ?? 'auto';
}
function windowsSandboxMode(options) {
  const selection = windowsSandboxSelection(options);
  return selection === 'auto' ? codexSandboxRecovery.mode(options) ?? windowsSandboxFallbacks.get(options.codex) ?? 'mxc' : selection;
}

function agentEnvironmentConfig(dir, options, platform = process.platform, workspace) {
  const roots = [...new Set([dir, workspace].filter(Boolean).map(path => resolve(path)))];
  const args = ['--config', `sandbox_workspace_write.writable_roots=${JSON.stringify(roots)}`];
  if (platform === 'win32') args.push('--config', `windows.sandbox=${windowsSandboxMode(options)}`);
  return args;
}

// Exercise the actual sandbox on every attempt. Only the Lean module/build
// artifacts are reusable; sandbox startup, reads and writes must still run.
export async function prepareAgentEnvironment(target, workspace, dir, options, hooks = {}) {
  try { return await checkAgentEnvironment(target, workspace, dir, options, hooks); }
  catch (error) {
    options.signal?.throwIfAborted();
    if (error instanceof EnvironmentError) throw error;
    throw new EnvironmentError(`Codex environment is not ready; no proof attempt was started. ${error.message}`);
  }
}

async function checkAgentEnvironment(target, workspace, dir, options, hooks) {
  const run = hooks.command ?? command, wait = hooks.wait ?? sleep;
  const platform = hooks.platform ?? process.platform;
  const readinessSource = `${target.preamble ?? ''}\nexample : True := by trivial\n`;
  // Retain the source and Lake traces until the private workspace is released.
  const module = `Solutions.RunnerEnvironment_${digest(readinessSource).slice(0, 16)}`;
  const leanFile = join(workspace, module.replaceAll('.', '/') + '.lean');
  const script = join(dir, 'environment-probe.cjs');
  const remoteVerification = serverOnly(options);
  const lake = remoteVerification ? null : await (hooks.executable ?? executable)(options.lake);
  if (!remoteVerification) await writeIfChanged(leanFile, readinessSource);
  await writeFile(script, `const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { join } = require('node:path');
JSON.parse(fs.readFileSync(${JSON.stringify(join(dir, 'context.json'))}, 'utf8'));
for (const name of ['references/prove.md', 'references/lean-setup.md', 'lean-toolchain', 'lakefile.lean']) fs.readFileSync(join(process.cwd(), name), 'utf8');
for (const folder of [join(process.cwd(), 'Solutions'), ${JSON.stringify(resolve(dir))}]) {
  const file = join(folder, ${JSON.stringify(`.runner-write-${randomUUID()}`)});
  try { fs.writeFileSync(file, 'ready', { flag: 'wx' }); if (fs.readFileSync(file, 'utf8') !== 'ready') throw new Error('Write/read mismatch'); }
  finally { fs.rmSync(file, { force: true }); }
}
${remoteVerification ? '' : `for (const args of [['--version'], ['build', ${JSON.stringify(module)}]]) {
  const result = spawnSync(${JSON.stringify(lake[0])}, [...${JSON.stringify(lake.slice(1))}, ...args], { stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}`}
console.log('RUNNER_ENVIRONMENT_READY');
`);
  let shell = [process.execPath, script];
  if (platform === 'win32') {
    const quote = value => `'${value.replaceAll("'", "''")}'`;
    const encoded = Buffer.from(`& ${quote(process.execPath)} ${quote(script)}; exit $LASTEXITCODE`, 'utf16le').toString('base64');
    shell = [join(process.env.SystemRoot ?? 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'), '-NoProfile', '-EncodedCommand', encoded];
  }
  // Codex 0.162.1 selects the host sandbox automatically on every platform.
  // Legacy `linux`/`macos` subcommands are interpreted as programs to execute.
  for (let retry = 0; retry < 3; retry++) {
    const mode = windowsSandboxMode(options);
    const config = agentEnvironmentConfig(dir, options, platform, workspace);
    const fallback = platform === 'win32' && windowsSandboxSelection(options) === 'auto' && mode === 'elevated';
    const log = join(dir, `environment-${options.environmentAttempt ?? 'check'}-${retry + 1}${fallback ? '-elevated' : ''}.log`);
    progress(`Checking Codex workspace and shell${remoteVerification ? '' : ', and Lean'}${platform === 'win32' ? ` (${mode})` : ''}`);
    try {
      const label = `[${idOf(target)}] ${remoteVerification ? 'Sandbox' : 'Lean'} readiness (no model request)`;
      const probe = async (exe = options.codex, probeLog = log, modeOverride) => {
        const probeConfig = modeOverride ? agentEnvironmentConfig(dir, { ...options, windowsSandbox: modeOverride }, platform, workspace) : config;
        await run(exe, [...probeConfig, '--config', 'sandbox_mode="workspace-write"', 'sandbox', '--', ...shell], {
          cwd: workspace, log: probeLog, timeout: (options.leanTimeout ?? 3600) * 1000, signal: options.signal, label, showOutput: true,
        });
        if (!(await readFile(probeLog, 'utf8')).includes('RUNNER_ENVIRONMENT_READY')) throw new Error('Sandbox did not complete the readiness check');
      };
      let recovered = false;
      const check = async () => {
        try { await probe(); }
        catch (error) {
          options.signal?.throwIfAborted();
          if (platform === 'win32' && retry === 2) {
            const output = await exists(log) ? (await readFile(log, 'utf8')).slice(-10000) : '';
            recovered = await (hooks.sandboxRecovery ?? codexSandboxRecovery).recover({ options, output, probe, dir, mode });
            if (recovered) return;
          }
          throw error;
        }
      };
      await withSetupSlot(() => remoteVerification ? check() : withBuildSlot(check, label), label);
      const output = await readFile(log, 'utf8');
      if (!recovered && !output.includes('RUNNER_ENVIRONMENT_READY')) throw new Error('Sandbox did not complete the readiness check');
      try { if (!remoteVerification) await publishCompiledDependencies(workspace, { ...options, workspaceOwner: idOf(target) }); }
      catch (error) {
        options.signal?.throwIfAborted();
        progress(`[${idOf(target)}] Compiled dependency cache export skipped: ${error.message}`);
      }
      return;
    } catch (error) {
      options.signal?.throwIfAborted();
      const output = await exists(log) ? (await readFile(log, 'utf8')).slice(-10000) : '';
      if (platform === 'win32' && windowsSandboxSelection(options) === 'auto' && mode === 'mxc' &&
          /CreateProcessSecurityEnvironment failed \(HRESULT = 0x800705AA\)/i.test(output)) {
        windowsSandboxFallbacks.set(options.codex, 'elevated');
        progress('MXC cannot allocate its process security environment (0x800705AA); checking the elevated Windows sandbox before starting any proof attempt');
        retry--; continue;
      }
      if (retry < 2 && (error.code === 'COMMAND_TIMEOUT' || /\btimed out\b/i.test(error.message) ||
          /setup refresh had errors|being used by another process|os error 32/i.test(output))) {
        progress('Readiness is temporarily unavailable; retrying in the same workspace with existing build output before starting a proof attempt');
        await wait(2000 * (retry + 1)); continue;
      }
      throw new EnvironmentError(`Codex environment is not ready; no proof attempt was started. ${error.message}\n${output}`);
    }
  }
}

export async function agent(target, workspace, dir, attempt, feedback, options) {
  // Keep retrieval alive for this invocation only, including prompt creation
  // and partial-candidate preservation. The API client never enters the child.
  let library;
  try {
    if (options.theoremLibraryClient) {
      try {
        library = await openTheoremLibrary(options.theoremLibraryClient, target, dir, attempt, options);
        const startingContextPath = await library.prefetch();
        options = { ...options, theoremLibrary: { startingContextPath, evidenceDirectory: library.directory },
          theoremLibraryConfig: library.configArgs };
      } catch (error) {
        await library?.close(); library = undefined;
        options.signal?.throwIfAborted();
        progress(`[${idOf(target)}] Optional theorem-library startup unavailable; continuing with existing proof context`);
      }
    }
    return await invokeProofAgent(target, workspace, dir, attempt, feedback, options);
  } finally { await library?.close(); }
}

async function invokeProofAgent(target, workspace, dir, attempt, feedback, options) {
  const schema = join(dir, 'answer.schema.json'), answer = join(dir, `answer-${attempt}.json`);
  await save(schema, ANSWER_SCHEMA);
  const { rm } = await import('node:fs/promises');
  await rm(answer, { force: true });
  const solution = `Solutions/Sol_${idOf(target).replaceAll('-', '_')}.lean`;
  const solutionPath = join(workspace, solution);
  const solutionNames = async () => {
    const entries = await readdir(join(workspace, 'Solutions'), { withFileTypes: true });
    return entries.filter(e => e.isFile() && e.name.replaceAll('-', '_') === `Sol_${idOf(target).replaceAll('-', '_')}.lean`)
      .map(e => join(workspace, 'Solutions', e.name));
  };
  const readSolution = async path => {
    try {
      const info = await lstat(path, { bigint: true });
      if (!info.isFile()) return undefined;
      const source = await readFile(path, 'utf8');
      return { source, stamp: `${info.mtimeNs}:${info.ctimeNs}:${info.ino}:${info.size}` };
    }
    catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
  };
  // Recover only ID-equivalent separator variants changed by this invocation.
  // Ambiguous alternatives and stale files must never replace current work.
  const before = new Map();
  for (const path of new Set([solutionPath, ...await solutionNames()])) before.set(path, await readSolution(path));
  const unchanged = (path, file) => file?.source === before.get(path)?.source && file?.stamp === before.get(path)?.stamp;
  let source;
  const { model, reasoningEffort } = options.reasoningEffort
    ? { model: options.model ?? FIRST_MODEL, reasoningEffort: options.reasoningEffort } : attemptModel(attempt, options);
  const prompt = agentPrompt(target, dir, attempt, feedback, solution, options);
  await writeFile(join(dir, `prompt-${attempt}.txt`), prompt);
  await save(join(dir, `prompt-${attempt}.json`), { attempt, prompt_experiment: options.promptExperiment ?? null,
    prompt_path: join(dir, `prompt-${attempt}.txt`), prompt_sha256: digest(prompt), model, reasoning_effort: reasoningEffort,
    theorem_library: options.theoremLibrary ?? null });
  const args = ['-a', 'never', 'exec', '--json', '--sandbox', 'workspace-write', '--cd', workspace, '--skip-git-repo-check', '--color', 'never', '--output-schema', schema, '--output-last-message', answer];
  args.push('--model', model, '--config', `model_reasoning_effort="${reasoningEffort}"`);
  args.push(...agentEnvironmentConfig(dir, options, process.platform, workspace));
  args.push(...(options.theoremLibraryConfig ?? []));
  args.push('-');
  const attemptLabel = `lifetime #${attempt}`;
  console.log(`  Codex attempt ${attemptLabel}: ${model}, reasoning ${reasoningEffort}, prompt ${options.promptExperiment?.variant ?? 'legacy_original'}`);
  try {
    options.assertModelSlot?.();
    await command(options.codex, args, { cwd: workspace, log: join(dir, `codex-${attempt}.log`), input: prompt, timeout: options.agentTimeout * 1000, signal: options.signal,
      label: `[${idOf(target)}] Codex proof attempt ${attempt} (${model})` });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw await codexQuotaFailure(error, join(dir, `codex-${attempt}.log`));
  } finally {
    // Keep partial work even when Codex times out or fails, before a retry edits it.
    const canonical = await readSolution(solutionPath);
    const alternatives = [];
    if (unchanged(solutionPath, canonical)) for (const path of await solutionNames()) {
      if (path === solutionPath) continue;
      const file = await readSolution(path);
      if (file && !unchanged(path, file)) alternatives.push({ path, file });
    }
    const alternate = alternatives.length === 1 ? alternatives[0] : undefined;
    source = (alternate?.file ?? canonical)?.source;
    if (source !== undefined) {
      source = source.replace(/^\uFEFF/, '');
      const normalized = normalizeSolutionDeclaration(source, target);
      if (normalized !== source) {
        await writeFile(join(dir, `solution-${attempt}-original.lean`), source);
        source = normalized;
        progress(`Attempt ${attempt}: renamed exact target declaration ${target.theorem_name} to solution`);
      }
      if (source !== canonical?.source) await writeFile(solutionPath, source, 'utf8');
      if (alternate) progress(`Attempt ${attempt}: recovered solution filename ${alternate.path} as ${solutionPath}`);
      await writeFile(join(dir, `solution-${attempt}.lean`), source);
    }
  }
  let result;
  try { result = JSON.parse(await readFile(answer, 'utf8')); }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new AnswerFormatError(`Invalid Codex answer JSON; saved at ${answer}`);
  }
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new AnswerFormatError('Invalid Codex answer object');
  if (source === undefined && (result.ready === true || result.kind === 'counterexample')) {
    throw new Error(`Codex returned a candidate without writing the assigned solution file: ${solutionPath}`);
  }
  return { ...result, solution: solutionPath, module: solution.slice(0, -5).replaceAll('/', '.') };
}

export async function repairAnswer(target, workspace, dir, attempt, feedback, result, options) {
  const schema = join(dir, 'answer.schema.json'), answer = join(dir, `answer-${attempt}-repair.json`);
  await save(schema, ANSWER_SCHEMA);
  await rm(answer, { force: true });
  const prompt = answerRepairPrompt(feedback, answerPayload(result));
  await writeFile(join(dir, `prompt-${attempt}-repair.txt`), prompt);
  const args = ['-a', 'never', 'exec', '--json', '--sandbox', 'read-only', '--cd', workspace, '--skip-git-repo-check', '--color', 'never',
    '--output-schema', schema, '--output-last-message', answer, '--model', FIRST_MODEL, '--config', 'model_reasoning_effort="low"',
    ...agentEnvironmentConfig(dir, options, process.platform, workspace), '-'];
  options.assertModelSlot?.();
  try {
    await command(options.codex, args, { cwd: workspace, log: join(dir, `codex-${attempt}-repair.log`), input: prompt,
      timeout: Math.min(options.agentTimeout ?? 120, 120) * 1000, signal: options.signal,
      label: `[${idOf(target)}] Codex formatting repair for attempt ${attempt}` });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw await codexQuotaFailure(error, join(dir, `codex-${attempt}-repair.log`));
  }
  return JSON.parse(await readFile(answer, 'utf8'));
}

export async function reviewMission(request, options, hooks = {}) {
  const invocation = request.invocation ?? 1;
  const schema = join(request.dir, 'answer.schema.json'), answer = join(request.dir, `answer-${invocation}.json`);
  await save(schema, REVIEW_SCHEMA); await rm(answer, { force: true });
  const prompt = missionReviewPrompt(request), log = join(request.dir, `codex-${invocation}.log`);
  await writeFile(join(request.dir, `prompt-${invocation}.txt`), prompt);
  const args = ['-a', 'never', 'exec', '--json', '--sandbox', 'read-only', '--cd', request.dir,
    '--skip-git-repo-check', '--color', 'never', '--output-schema', schema, '--output-last-message', answer,
    '--model', request.model ?? REVIEW_MODEL, '--config', `model_reasoning_effort="${request.reasoningEffort ?? 'high'}"`,
    ...agentEnvironmentConfig(request.dir, options, hooks.platform ?? process.platform), '-'];
  options.assertModelSlot?.();
  try {
    await (hooks.command ?? command)(options.codex, args, { cwd: request.dir, log, input: prompt,
      timeout: Math.min(options.agentTimeout ?? 1800, 1800) * 1000, signal: options.signal,
      label: `[${request.root_id}] mission research (${request.model ?? REVIEW_MODEL})` });
  } catch (error) {
    options.signal?.throwIfAborted(); throw await codexQuotaFailure(error, log);
  }
  return JSON.parse(await readFile(answer, 'utf8'));
}

export async function solveLeaf(client, target, context, environment, options, hooks = {}) {
  return runSerialJob(client, target, context, environment, options, hooks,
    { ensureWorkspace, mirror, agent, repairAnswer, command, pins, releaseWorkspace, prepareAgentEnvironment,
      readCodexRateLimits: () => readCodexRateLimits(options, { executable, env: childEnv() }) });
}

// A worker returns here after every visit. Rebuild the frontier before assigning
// more work. Completed attempts return to the scored work pool;
// an open mission stays alive while waiting for new work or environment recovery.
export async function runTarget(client, target, options, hooks = {}) {
  // Token renewal can report a deployment during a long-running mission.
  // New preparations must use that version rather than the startup snapshot.
  options = { ...options, getApiVersion: () => client.version ?? options.apiVersion };
  options.signal?.throwIfAborted();
  if (client instanceof Client && !client.recovery) {
    client.recovery = new ApiRecovery(client, options);
    client.signal = options.signal;
  }
  // The legacy whole-theorem test/embedding hook has no stage boundaries.
  // Normal execution always uses the bounded stage pipeline.
  if (!hooks.solveLeaf) {
    const pipeline = new Pipeline(client, target, options, {
      ...hooks, isEnvironmentError: error => error instanceof EnvironmentError,
      reviewMission: hooks.reviewMission ?? ((request, control) => reviewMission(request, { ...options, signal: control.signal,
        assertModelSlot: () => pipeline.assertReviewSlot() })),
      readCodexRateLimits: hooks.readCodexRateLimits ?? (() => readCodexRateLimits({ ...options, signal: pipeline.signal }, { executable, env: childEnv() })),
      runJob: async (job, control) => {
        const id = job.theorem_id;
        const theorem = await client.request(`theorems/${enc(id)}`);
        if (['SUBMITTING', 'SUBMISSION_UNKNOWN', 'PENDING'].includes(job.status)) {
          const snapshot = await readJson(join(options.runs, id, 'context.json'));
          return solveLeaf(client, theorem, snapshot ?? { scope: target }, snapshot?.environment ?? {},
            { ...options, signal: control.signal, runId: control.runId, rootId: target.root }, { ...hooks, ...control });
        }
        if ((theorem.status !== 'Open' || theorem.deprecated_at) &&
            !['SUBMITTING', 'SUBMISSION_UNKNOWN', 'PENDING', 'PUBLISHING', 'PUBLISH_UNKNOWN', 'PUBLISH_PENDING'].includes(job.status)) {
          job.job_status = 'DONE'; job.status = `SKIPPED (${theorem.status})`;
          if (!await pipeline.store.replace(job, job.revision, { allowRetirement: true })) {
            const current = await pipeline.store.read(id);
            // Completion can overtake the theorem read. Preserve its result
            // rather than replacing accepted evidence with a skipped status.
            if (current?.job_id !== job.job_id || !['DONE', 'RETIRED', 'UNRESOLVED'].includes(current.job_status)) {
              throw new JobPersistenceError('Cannot save skipped job');
            }
            await control.changed(current); return current.status ?? current.job_status;
          }
          await control.changed(job); return job.status;
        }
        const { environments } = await client.request('environments');
        const environment = environments.find(e => e.mathlib_rev === theorem.mathlib_rev);
        if (!environment) throw new EnvironmentError('Target Lean environment is unavailable');
        const decompositions = await client.request(`theorems/${enc(id)}/decompositions`);
        const submissions = await client.pages(`theorems/${enc(id)}/submissions`, 'submissions');
        const history = target.milestone ? await client.pages(`milestones/${enc(target.id)}/history`, 'events') : [];
        return solveLeaf(client, theorem, { scope: target, milestone_history: history,
          decompositions, previous_submissions: submissions }, environment,
        { ...options, signal: control.signal, runId: control.runId, rootId: target.root,
          missionResearchEpoch: pipeline.research.state?.epoch }, { ...hooks, ...control });
      },
    });
    const previousSignal = client.signal;
    if (client instanceof Client) client.signal = pipeline.signal;
    try { return await pipeline.run(); }
    finally { if (client instanceof Client) client.signal = previousSignal; }
  }
  const results = new Map(), selection = new WorkSelection(options);
  const runId = randomUUID();
  const wait = hooks.wait ?? sleep;
  const refreshDelay = (options.refreshInterval ?? 30) * 1000;
  let rootStatus;
  const checkpoint = async (status, error, waitingReason) => {
    const summary = { target, run_id: runId, status, completed: status === 'COMPLETE', root_status: rootStatus,
      visits: selection.visits, results: [...results.values()], updated_at: new Date().toISOString() };
    if (status !== 'RUNNING') summary.finished_at = summary.updated_at;
    if (error) summary.error = error.message;
    if (waitingReason) summary.waiting_reason = waitingReason;
    await save(join(options.runs, 'last-run.json'), summary);
    return summary;
  };
  try {
    for (;;) {
      options.signal?.throwIfAborted();
      progress(`Refreshing graph for ${target.name}`);
      let frontier;
      try { frontier = await selection.buildGraph(client, target.root, hooks.frontier); }
      catch (error) {
        options.signal?.throwIfAborted();
        if (!retryGraphRefreshError(error)) throw error;
        progress(`Graph refresh failed: ${error.message}; retrying in ${refreshDelay / 1000}s`);
        await checkpoint('RUNNING'); await wait(refreshDelay); continue;
      }
      rootStatus = frontier.root.status;
      const next = selection.next(frontier);
      if (next.kind === 'complete') {
        progress(`${target.kind} complete: ${target.name}`);
        return await checkpoint('COMPLETE');
      }
      if (next.kind === 'disproved') {
        const reason = 'target disproved; proof search stopped';
        progress(reason);
        return await checkpoint('DISPROVED', undefined, reason);
      }
      await checkpoint('RUNNING');
      if (next.kind === 'wait') {
        progress(`Target still open; ${next.reason} in ${refreshDelay / 1000}s`);
        await checkpoint('RUNNING', undefined, next.reason);
        await wait(next.next_poll_at ? Math.min(refreshDelay || 20000, Math.max(1, Date.parse(next.next_poll_at) - Date.now())) : refreshDelay); continue;
      }
      const leaf = next.kind === 'resume' ? next.leaf : await selection.getWork({ attempts: options.attempts, runId }), id = leaf && idOf(leaf);
      if (!leaf) continue;
      selection.startVisit(leaf);
      console.log(`\nWorking on ${leaf.theorem_name} (${id}; ${leaf.task_kind ?? 'recovery'}; ${leaf.operation ?? 'resume'}; score ${leaf.score ?? 'pending'}; closability ${leaf.closability ?? 0}; attempts ${leaf.totalAttempts ?? leaf.attempt_count ?? 0}, current context ${leaf.attemptsInCurrentContext ?? 'unknown'}; ${leaf.selection_reason ?? 'resume'}; context ${leaf.context_id ?? 'saved'}; visit ${selection.visits})`);
      let result;
      try {
        const theorem = await client.request(`theorems/${enc(id)}`);
        if (theorem.status !== 'Open' || theorem.deprecated_at) {
          result = { theorem_id: id, name: leaf.theorem_name, status: `SKIPPED (${theorem.status})` };
        } else {
          const { environments } = await client.request('environments');
          const environment = environments.find(e => e.mathlib_rev === theorem.mathlib_rev);
          if (!environment) throw new Error('Target Lean environment is unavailable');
          const decompositions = await client.request(`theorems/${enc(id)}/decompositions`);
          const submissions = await client.pages(`theorems/${enc(id)}/submissions`, 'submissions');
          const history = target.milestone ? await client.pages(`milestones/${enc(target.id)}/history`, 'events') : [];
          const status = await (hooks.solveLeaf ?? solveLeaf)(client, theorem,
            { scope: target, milestone_history: history, decompositions, previous_submissions: submissions }, environment,
            { ...options, runId, rootId: target.root, resumeOnly: next.kind === 'resume' });
          result = { theorem_id: id, name: leaf.theorem_name, status };
        }
      } catch (error) {
        options.signal?.throwIfAborted();
        if (error instanceof JobPersistenceError) throw error;
        if (error instanceof EnvironmentError) {
          // Readiness precedes the saved model invocation. Keep the ACTIVE job,
          // feedback and attempt budget, and do not count this as a work visit.
          selection.deferVisit(leaf);
          result = { theorem_id: id, name: leaf.theorem_name, status: 'ENVIRONMENT_WAIT', error: error.message };
          results.set(id, result);
          progress(`Environment unavailable for ${leaf.theorem_name}: ${error.message}; retrying in ${refreshDelay / 1000}s`);
          await checkpoint('RUNNING', undefined, 'waiting for Lean/Codex environment recovery');
          await wait(refreshDelay); continue;
        }
        console.error(`  ${error.message}`);
        result = { theorem_id: id, name: leaf.theorem_name, status: 'ERROR', error: error.message };
      }
      if (hooks.solveLeaf || result.status.startsWith('SKIPPED')) {
        const job = await selection.store.ensure(id, { attempts: options.attempts, rootId: target.root });
        // The legacy whole-solver hook has no model boundary. Record its visit
        // only once it returns; the production stage driver commits before dispatch.
        if (hooks.solveLeaf && next.kind !== 'resume') {
          job.attempt_count++; job.attempts_used_in_job++; job.attempt_id = randomUUID();
          job.attempts_by_model.unknown = (job.attempts_by_model.unknown ?? 0) + 1;
          appendEvent(job, { event_id: job.attempt_id + ':started', event_type: 'attempt', attempt: job.attempt_count,
            attempt_id: job.attempt_id, result: 'started', context_id: job.context_id, operation: leaf.operation, model: 'unknown' });
        }
        if (job.attempt_id && !['PENDING', 'PUBLISH_PENDING'].includes(result.status)) {
          appendEvent(job, { event_id: `${job.attempt_id}:outcome`, event_type: 'attempt', attempt: job.attempt_count,
            attempt_id: job.attempt_id, context_id: job.history.find(e => e.attempt_id === job.attempt_id)?.context_id,
            result: ({ ACCEPTED: 'proof_accepted', SKETCH_ACCEPTED: 'sketch_accepted', DISPROVED: 'disproof_accepted' })[result.status] ?? 'incomplete' });
        }
        Object.assign(job, { status: result.status, job_status: ['ACCEPTED', 'SKETCH_ACCEPTED', 'DISPROVED'].includes(result.status) || result.status.startsWith('SKIPPED')
          ? 'DONE' : ['PENDING', 'PUBLISH_PENDING'].includes(result.status) ? 'ACTIVE' : 'READY' });
        await selection.store.replace(job, job.revision);
      }
      results.set(id, result);
      await checkpoint('RUNNING');
    }
  } catch (error) {
    await checkpoint('ERROR', error);
    throw error;
  }
}

const HELP = `Usage: node prove2me.mjs                 Open Mission Control and set up a mission in the browser
       node prove2me.mjs --mission "name, URL or ID" [--milestone "name or ID"] [options]
       node prove2me.mjs --mission-id ID [--milestone "name or ID"] [options]
       node prove2me.mjs "mission or milestone name" [options]

  --kind auto|mission|milestone  Prefer exact missions; otherwise search both
  --mission "name, URL or ID"    Select a mission; plain or percent-encoded names/URLs work
  --mission-id ID                Explicit mission ID; UUIDs in --mission also use this path
  --milestone "name or ID"       Optional milestone within the selected mission
  --list                        Preview scored leaves and parent repairs (read-only)
  --config PATH                 Override project runner-config.json defaults
  --codex-concurrency N         Override configured simultaneous Codex calls
  --attempts N                  Deprecated positive integer; no longer caps attempts
  --model NAME                  Override every proof attempt's profile (default: attemptModels in runner-config.json)
  --codex PATH                  Explicit override (default: project's Codex package)
  --lake PATH                   Lake executable (default: lake)
  --verification-mode MODE      Override configured mode: local or server-only
  --max-remote-jobs N            Override configured remote-job capacity
  --windows-sandbox MODE        auto (default), mxc, elevated, or unelevated; Windows only
  --credentials PATH            JSON file with api_key (default: project's credentials.json)
  --agent-timeout SECONDS        Per Codex attempt (default: 1800)
  --lean-timeout SECONDS         Per readiness/build/check command (default: 3600)
  --poll-timeout SECONDS         Legacy compatibility; stage checks use one request
  --refresh-interval SECONDS     Recovery retry delay (default: 30)
  --graph-refresh-interval SECONDS  Background graph reconciliation; no work refreshes early (default: 600)
  --ui                          Open Mission Control in the browser (default; a mission is optional)
  --port PORT                   Mission Control port (default: 4317)
  --no-ui                       Run in the console without Mission Control
  --help                        Show help
`;

export async function main(argv = process.argv.slice(2), { validateOnly = false } = {}) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    help: { type: 'boolean' }, list: { type: 'boolean' }, kind: { type: 'string', default: 'auto' }, mission: { type: 'string' }, 'mission-id': { type: 'string' }, milestone: { type: 'string' },
    'max-leaves': { type: 'string' }, attempts: { type: 'string' }, model: { type: 'string' }, codex: { type: 'string', default: 'codex' }, lake: { type: 'string', default: 'lake' },
    credentials: { type: 'string', default: join(ROOT, 'credentials.json') }, 'agent-timeout': { type: 'string', default: '1800' }, 'lean-timeout': { type: 'string', default: '3600' }, 'poll-timeout': { type: 'string', default: '600' },
    'refresh-interval': { type: 'string', default: '30' },
    'graph-refresh-interval': { type: 'string', default: '600' },
    config: { type: 'string' }, 'codex-concurrency': { type: 'string' },
    'verification-mode': { type: 'string' }, 'max-remote-jobs': { type: 'string' },
    'windows-sandbox': { type: 'string', default: 'auto' },
  } });
  if (values['max-leaves'] !== undefined) throw new Error('--max-leaves has been removed. Omit it to run continuously until the selected root is proved; use Ctrl+C to interrupt and save unfinished jobs. There is no replacement visit limit.');
  if (values.help) { console.log(HELP); return; }
  if (positionals.length > 1 || positionals.some(name => !name.trim())) throw new Error(HELP);
  if (!['auto', 'mission', 'milestone'].includes(values.kind)) throw new Error('Invalid --kind');
  if (!['auto', 'mxc', 'elevated', 'unelevated'].includes(values['windows-sandbox'])) throw new Error('Invalid --windows-sandbox');
  for (const name of ['mission', 'mission-id', 'milestone']) {
    if (values[name] !== undefined && !values[name].trim()) throw new Error(`--${name} must not be empty`);
  }
  if (values.mission && values['mission-id']) throw new Error('Use either --mission or --mission-id, not both');
  if (values['mission-id'] && !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(values['mission-id'])) throw new Error('Invalid mission ID');
  const { query, selection } = selectTargetQuery(values, positionals[0]);
  if (!query) throw new Error(HELP);
  const integer = (key, fallback) => {
    const value = values[key] === undefined ? fallback : Number(values[key]);
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`--${key} must be a positive integer`);
    return value;
  };
  if (values.config !== undefined && !values.config.trim()) throw new Error('--config must not be empty');
  const config = await readRunnerConfig(values.config);
  // Validate before overriding so a malformed file cannot be silently masked.
  const pipeline = config.values;
  if (values.model !== undefined) modelProfile(values.model);
  if (values['codex-concurrency'] !== undefined) pipeline.queues.CODEX.concurrency = integer('codex-concurrency');
  if (values['verification-mode'] !== undefined) pipeline.verificationMode = verificationMode({ verificationMode: values['verification-mode'] });
  if (values['max-remote-jobs'] !== undefined) pipeline.maxRemoteJobs = integer('max-remote-jobs');
  const options = { ...values, pipeline, attempts: values.attempts === undefined ? undefined : integer('attempts'), agentTimeout: integer('agent-timeout', 1800), leanTimeout: integer('lean-timeout', 3600), pollTimeout: integer('poll-timeout', 600), refreshInterval: integer('refresh-interval', 30), graphRefreshInterval: integer('graph-refresh-interval', 600), runs: join(ROOT, '.runs'), workspaces: join(ROOT, '.workspaces') };
  options.configPath = config.path;
  options.configRevision = config.revision;
  if (validateOnly) return { options, query, selection };
  const controller = new AbortController();
  options.signal = controller.signal;
  const controlConnection = connectRunnerControl(controller);
  try {
    if (values.attempts !== undefined) console.warn('Warning: --attempts is deprecated and no longer caps mathematical attempts.');
    if (pipeline.queues.CODEX.concurrency > pipeline.maxActiveJobs) progress('Codex concurrency exceeds maxActiveJobs; the active-job cap limits utilization');
    progress(`Starting Prove2.me runner for "${query}"${values.list ? ' (list only)' : ''}`);
    progress('Loading credentials');
    const key = await loadApiKey(resolve(values.credentials));
    const credentialSource = process.env.PROVE2ME_API_KEY ? 'PROVE2ME_API_KEY' : `api_key in "${resolve(values.credentials)}"`;
    const client = new Client(key, fetch, { report: progress, apiConcurrency: pipeline.apiConcurrency, credentialSource });
    client.signal = controller.signal;
    progress(`Resolving target (kind: ${selection.kind})${selection.mission ? ` in mission "${selection.mission}"` : ''}`);
    const target = await findTarget(client, query, selection);
    controller.signal.throwIfAborted();
    controlConnection.target(target);
    options.apiVersion = client.version;
    console.log(`${target.kind}: ${target.name}\nMission: ${target.mission.name}`);
    if (values.list) {
      const ranked = scoreWork(await previewGraph(client, target.root, { runs: options.runs, readOnly: true }), undefined, Date.now(), options);
      console.log(`${ranked.length} scored work items`);
      console.table(ranked.map(l => ({ name: l.theorem_name, kind: l.task_kind, operation: l.operation, score: l.score, closability: l.closability, total: l.totalAttempts, current: l.attemptsInCurrentContext, reason: l.selection_reason, id: idOf(l) })));
      return;
    }
    await executable(options.codex); if (!serverOnly(options)) await executable(options.lake);
    await mkdir(options.runs, { recursive: true });
    const lockPath = join(options.runs, 'runner.lock');
    const releaseLock = acquireRunnerLock(lockPath, { interrupt: code => {
      process.exitCode = code; controller.abort(new Error('Operator interrupted runner'));
    } });
    options.signal = controller.signal; client.signal = controller.signal;
    client.recovery = new ApiRecovery(client, { runs: options.runs, pipeline,
      loadCredentials: () => loadApiKey(resolve(values.credentials)) });
    try {
      const summary = await runTarget(client, target, options, {
        onControlReady: pipeline => controlConnection.ready(pipeline),
      });
      console.table(summary.results);
      if (!summary.completed) process.exitCode = 1;
    } finally {
      stopChildren();
      releaseLock();
    }
  } catch (error) { controlConnection.failure(error); throw error; }
  finally { controlConnection.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const argv = process.argv.slice(2);
  const headless = argv.includes('--no-ui') || argv.includes('--list') || argv.includes('--help');
  const launch = headless ? main(argv.filter(arg => arg !== '--no-ui' && arg !== '--ui'))
    : import('./mission-control-server.mjs').then(({ launchMissionControl }) => launchMissionControl(argv));
  launch.catch(error => {
    console.error(error.message);
    if (process.connected) process.send({ type: 'failure', error: error.message });
    process.exitCode ||= 1;
  });
}
