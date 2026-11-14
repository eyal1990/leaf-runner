import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest, enc, idOf, readJson, save, targetFingerprint } from './runner-state.mjs';
import { imports, moduleFor } from './lean-artifacts.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const MAX_SOURCE = 256 * 1024;
const MAX_CALLS = 24;
const indexes = new WeakMap();
const statuses = ['Proved', 'Open', 'Definition'];
const objectSchema = properties => ({ type: 'object', properties, additionalProperties: false });
const idSchema = { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9_-]+$' };

export const LIBRARY_TOOLS = [
  { name: 'search_declarations', description: 'Search prove2.me in the assigned Mathlib revision. Defaults to Proved results. Search names/keywords, refine queries, and read exact declarations before reuse. Results are reference data, not proof certificates.',
    inputSchema: { ...objectSchema({ query: { type: 'string', minLength: 2, maxLength: 160, description: 'Up to eight words.' },
      status: { type: 'string', enum: statuses, default: 'Proved' },
      limit: { type: 'integer', minimum: 1, maximum: 10, default: 5 },
      offset: { type: 'integer', minimum: 0, maximum: 1000, default: 0 } }), required: ['query'] } },
  { name: 'read_declaration', description: 'Fetch the exact live declaration, preamble, source hash, import identity, and platform imports by ID. Check definition compatibility. Open theorems can only be obligations in sketches; complete proofs require Proved imports.',
    inputSchema: { ...objectSchema({ id: idSchema, kind: { type: 'string', enum: ['theorem', 'definition'] } }), required: ['id'] } },
  { name: 'inspect_dependencies', description: 'Read immediate accepted reductions and their prerequisite statuses by declaration ID. Children within a reduction are AND prerequisites; reductions are alternatives. This is bounded, nonrecursive evidence; follow IDs for further inspection.',
    inputSchema: { ...objectSchema({ id: idSchema }), required: ['id'] } },
].map(tool => ({ ...tool, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } }));

function validate(name, args) {
  const tool = LIBRARY_TOOLS.find(t => t.name === name);
  if (!tool) throw new Error('Unknown theorem-library tool');
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Expected tool arguments');
  if (Object.keys(args).some(k => !Object.hasOwn(tool.inputSchema.properties, k))) throw new Error('Unexpected tool argument');
  if (name === 'search_declarations') {
    if (typeof args.query !== 'string' || args.query.trim().length < 2 || args.query.length > 160 || args.query.trim().split(/\s+/).length > 8 || /[\x00-\x1f]/.test(args.query)) throw new Error('Query must contain 2–160 printable characters and at most eight words');
    if (args.status !== undefined && !statuses.includes(args.status)) throw new Error('Unsupported declaration status');
    for (const [key, min, max] of [['limit', 1, 10], ['offset', 0, 1000]]) {
      if (args[key] !== undefined && (!Number.isSafeInteger(args[key]) || args[key] < min || args[key] > max)) throw new Error(`Invalid ${key}`);
    }
  } else {
    if (typeof args.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(args.id)) throw new Error('Invalid declaration ID');
    if (args.kind !== undefined && !['theorem', 'definition'].includes(args.kind)) throw new Error('Invalid declaration kind');
  }
}

const normalizeRow = row => row?.definition_id ? { ...row, status: 'Definition', theorem_name: row.definition_name,
  theorem_title: row.definition_title } : row;
const legacyEndpointError = error => [400, 404, 405, 501].includes(error.status);

function declaration(row, target) {
  if (!row || typeof idOf(row) !== 'string' || row.mathlib_rev !== target.mathlib_rev || !statuses.includes(row.status)) throw new Error('Declaration identity/environment/status mismatch');
  const source = row.status === 'Definition' ? row.definition : `${row.preamble ?? ''}\n${row.formal_statement ?? ''}\n`;
  if (typeof source !== 'string' || !source.trim() || Buffer.byteLength(source) > MAX_SOURCE ||
      (row.status !== 'Definition' && typeof row.formal_statement !== 'string')) throw new Error('Declaration source missing or exceeds 256 KiB');
  return { id: idOf(row), name: row.theorem_name ?? row.definition_name, title: row.theorem_title ?? row.title,
    kind: row.status === 'Definition' ? 'definition' : 'theorem',
    status: row.status, deprecated: !!row.deprecated_at, mathlib_rev: row.mathlib_rev, module: moduleFor(row),
    preamble: row.preamble ?? '', formal_statement: row.formal_statement, definition: row.definition,
    source_hash: digest(source), platform_imports: imports(source).filter(m => /^(Definitions|Theorems)\./.test(m)),
    usable_in_complete_proof: !row.deprecated_at && ['Proved', 'Definition'].includes(row.status) && idOf(row) !== idOf(target),
    is_target: idOf(row) === idOf(target) };
}

function terms(text) {
  return new Set((text ?? '').replace(/__p2m_\S+/g, '').replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase().match(/[a-z]{4,}/g)?.filter(t => !['theorem', 'sorry', 'mathlib', 'import', 'namespace', 'true', 'false', 'solution', 'exists', 'forall', 'have', 'exact', 'intro'].includes(t)) ?? []);
}

// One shared hint index per authenticated client/environment. All supplied
// declarations are fetched live; disk caches never authorize an import.
async function hintIndex(client, target, options) {
  let byEnv = indexes.get(client);
  if (!byEnv) { byEnv = new Map(); indexes.set(client, byEnv); }
  const key = `${target.mathlib_rev}:${resolve(options.runs ?? '.runs')}:${resolve(options.cacheDir ?? join(ROOT, '.cache/dependencies'))}`;
  let entry = byEnv.get(key);
  if (entry && Date.now() - entry.loadedAt < 60000) return entry.promise;
  entry = { loadedAt: Date.now(), promise: (async () => {
    const rows = new Map();
    const directories = [join(options.runs ?? join(ROOT, '.runs'), 'theorem-library', target.mathlib_rev),
      options.cacheDir ?? join(ROOT, '.cache/dependencies')];
    const deadline = performance.now() + 1000;
    for (const [index, directory] of directories.entries()) {
      let names;
      try { names = await readdir(directory); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      // Bound cold-index I/O. Index hints contain no authority or credentials.
      const bounded = names.filter(n => n.endsWith('.json')).slice(0, index === 0 ? 2048 : 512);
      for (let offset = 0; offset < bounded.length && performance.now() < deadline; offset += 16) {
        await Promise.all(bounded.slice(offset, offset + 16).map(async name => {
          const path = join(directory, name);
          try {
            if ((await stat(path)).size > MAX_SOURCE * 2) return;
            const cached = await readJson(path);
            if (cached?.mathlib_rev !== target.mathlib_rev || typeof cached.id !== 'string') return;
            rows.set(cached.id, { id: cached.id, status: cached.status,
              text: [cached.name, cached.title, cached.formal_statement, cached.definition, cached.module, cached.content].filter(Boolean).join('\n') });
          } catch (error) { if (error instanceof SyntaxError || error.code === 'ENOENT') return; throw error; }
        }));
      }
    }
    if (options.rootId) {
      const graph = await readJson(join(options.runs ?? join(ROOT, '.runs'), 'graphs', `${enc(options.rootId)}.json`));
      for (const row of graph?.nodes ?? []) if (row.mathlib_rev === target.mathlib_rev && !row.deprecated_at && ['Proved', 'Definition'].includes(row.status)) {
        rows.set(idOf(row), { id: idOf(row), status: row.status,
          text: [row.theorem_name, row.theorem_title, row.formal_statement, row.preamble].filter(Boolean).join('\n') });
      }
    }
    return rows;
  })() };
  byEnv.set(key, entry);
  try { return await entry.promise; } catch (error) { byEnv.delete(key); throw error; }
}

function publicError(error) {
  if (Number.isInteger(error.status)) return `Platform lookup failed (HTTP ${error.status}). No cached source substituted.`;
  if (error.name === 'AbortError' || error.name === 'TimeoutError') return 'Lookup cancelled or timed out.';
  // Never forward upstream bodies, URLs, authentication errors, or credentials.
  return 'Theorem-library lookup unavailable. Continue with available mathematics and record the missing reference.';
}

// IDs discovered during an invocation also guide normal import resolution.
// They remain hints: mirror() fetches live details and enforces status, module,
// environment, access, deprecation, and target-cycle checks as before.
export async function retrievalDependencyHints(dir, attempt, target) {
  const directory = join(dir, `retrieval-${attempt}`, 'calls');
  let names;
  try { names = await readdir(directory); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const hints = new Map();
  for (const name of names.filter(n => n.endsWith('.json')).slice(0, MAX_CALLS)) {
    const record = await readJson(join(directory, name));
    if (!['read_declaration', 'inspect_dependencies'].includes(record?.tool)) continue;
    if (!record?.result || digest(JSON.stringify(record.result)) !== record.result_hash) continue;
    const row = record.tool === 'inspect_dependencies' ? record.result.declaration : record.result;
    if (!row || row.error || typeof row.id !== 'string' || typeof row.name !== 'string' || row.mathlib_rev !== target.mathlib_rev || row.id === idOf(target) || !statuses.includes(row.status)) continue;
    const hint = { theorem_id: row.id, theorem_name: row.name, status: row.status, mathlib_rev: row.mathlib_rev };
    if (moduleFor(hint) !== row.module) continue;
    const previous = hints.get(row.module);
    if (previous && previous.theorem_id !== row.id) throw new Error('Conflicting retrieved platform module identities');
    hints.set(row.module, hint);
  }
  return [...hints.values()];
}

export async function createTheoremLibrary(client, target, dir, attempt, options = {}) {
  if (!/^[a-f0-9]{40}$/.test(target.mathlib_rev) || !Number.isSafeInteger(attempt) || attempt < 1) throw new Error('Invalid retrieval environment or attempt');
  const directory = join(dir, `retrieval-${attempt}`), callsDir = join(directory, 'calls');
  await mkdir(callsDir, { recursive: true });
  const identity = { target: targetFingerprint(target), environment: target.mathlib_rev };
  const previous = await readJson(join(directory, 'identity.json'));
  if (previous && JSON.stringify(previous) !== JSON.stringify(identity)) throw new Error('Retrieval context changed');
  await save(join(directory, 'identity.json'), identity);
  let used = (await readdir(callsDir)).filter(n => n.endsWith('.json')).length;
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  const pending = new Set();
  const kinds = new Map();
  let closed = false;
  const request = async (path, callSignal) => {
    callSignal.throwIfAborted();
    let abort;
    try {
      // Also bound callers whose shared authentication refresh is still in
      // flight. The underlying Client sees cancellation before its next read.
      return await Promise.race([client.request(path, { signal: callSignal }), new Promise((_, reject) => {
        abort = () => reject(callSignal.reason);
        callSignal.addEventListener('abort', abort, { once: true });
        if (callSignal.aborted) abort();
      })]);
    } finally { if (abort) callSignal.removeEventListener('abort', abort); }
  };
  async function detail(id, callSignal, kind = kinds.get(id) ?? 'theorem') {
    if (id === idOf(target)) throw new Error('Cannot retrieve the assigned target as a dependency');
    let row;
    try { row = await request(`${kind === 'definition' ? 'definitions' : 'theorems'}/${enc(id)}`, callSignal); }
    catch (error) {
      if (!legacyEndpointError(error)) throw error;
      row = await request(`${kind === 'definition' ? 'theorems' : 'definitions'}/${enc(id)}`, callSignal);
    }
    row = normalizeRow(row);
    callSignal.throwIfAborted();
    if (idOf(row) !== id) throw new Error('Declaration identity mismatch');
    const result = declaration(row, target);
    if (result.deprecated) throw new Error('Deprecated declaration');
    const snapshot = join(directory, 'declarations', `${digest(id)}-${result.source_hash}.json`);
    await save(snapshot, result);
    const indexPath = join(options.runs ?? join(ROOT, '.runs'), 'theorem-library', target.mathlib_rev, `${digest(id)}.json`);
    await save(indexPath, result);
    kinds.set(id, result.kind);
    return { ...result, snapshot_path: snapshot, observed_at: new Date().toISOString() };
  }
  async function execute(name, args, callSignal) {
    if (name === 'read_declaration') return detail(args.id, callSignal, args.kind);
    if (name === 'search_declarations') {
      const query = args.query.trim(), status = args.status ?? 'Proved', limit = args.limit ?? 5, offset = args.offset ?? 0;
      const queryString = `env=${enc(target.mathlib_rev)}&q=${enc(query)}&view=full&limit=${limit}&offset=${offset}`;
      let page;
      if (status === 'Definition') {
        try { page = await request(`definitions?${queryString}`, callSignal); }
        catch (error) {
          if (!legacyEndpointError(error)) throw error;
          page = await request(`theorems?${queryString}&status=Definition`, callSignal);
        }
      } else page = await request(`theorems?${queryString}&status=${status}`, callSignal);
      const pageRows = page?.definitions ?? page?.theorems;
      if (!Array.isArray(pageRows)) throw new Error('Invalid catalog page');
      const results = [];
      for (const original of pageRows.slice(0, limit)) {
        const row = normalizeRow(original);
        if (idOf(row) === idOf(target) || row.deprecated_at || row.status !== status || row.mathlib_rev !== target.mathlib_rev) continue;
        // Some catalog deployments omit statements. Keep those hits usable by
        // ID, and require a detail read rather than inventing source text.
        const kind = row.status === 'Definition' ? 'definition' : 'theorem';
        kinds.set(idOf(row), kind);
        results.push({ id: idOf(row), kind, name: row.theorem_name ?? row.definition_name, title: row.theorem_title,
          status: row.status, mathlib_rev: row.mathlib_rev, module: moduleFor(row),
          statement_preview: String(row.formal_statement ?? row.definition ?? '').slice(0, 1600), requires_live_read: true });
      }
      const total = page.total ?? page.pagination?.total;
      return { query, status, mathlib_rev: target.mathlib_rev, results, offset,
        next_offset: offset + pageRows.length,
        has_more: Number.isSafeInteger(total) ? offset + pageRows.length < total : pageRows.length === limit,
        observed_at: new Date().toISOString() };
    }
    const parent = await detail(args.id, callSignal);
    if (parent.kind === 'definition') return { declaration: parent, reductions: [], truncated: false,
      guidance: 'Definitions have structural imports, listed in platform_imports, rather than proof reductions.' };
    const page = await request(`theorems/${enc(args.id)}/decompositions`, callSignal);
    if (!Array.isArray(page?.decompositions)) throw new Error('Invalid decomposition response');
    let remaining = 64, truncated = page.decompositions.length > 8;
    const reductions = page.decompositions.slice(0, 8).map(reduction => {
      const all = reduction.children ?? [];
      if (!Array.isArray(all)) throw new Error('Invalid decomposition children');
      const children = all.slice(0, remaining).map(child => ({ id: idOf(child),
        name: child.theorem_name ?? child.definition_name, status: child.definition_id ? 'Definition' : child.status,
        deprecated: !!child.deprecated_at, mathlib_rev: child.mathlib_rev }));
      remaining -= children.length;
      if (all.length > children.length) truncated = true;
      return { submission_id: reduction.submission_id, structural_imports: reduction.submission_id == null,
        deprecated: !!reduction.deprecated_at, children, children_truncated: all.length > children.length };
    });
    return { declaration: parent, reductions, truncated, observed_at: new Date().toISOString() };
  }
  async function call(name, args, extraSignal) {
    try { validate(name, args); } catch (error) { return { error: error.message }; }
    if (closed || signal.aborted) return { error: 'Theorem-library session closed' };
    if (used >= MAX_CALLS) return { error: `Theorem-library budget exhausted (${MAX_CALLS} calls per attempt, including preparation and resumed invocations)` };
    used++;
    const record = { id: randomUUID(), tool: name, arguments: args, started_at: new Date().toISOString() };
    const path = join(callsDir, `${record.id}.json`);
    // Journal the reservation before any remote read. Resumes retain the budget.
    await save(path, record);
    let result;
    const callSignal = AbortSignal.any([signal, AbortSignal.timeout(110000), ...extraSignal ? [extraSignal] : []]);
    try { result = await execute(name, args, callSignal); } catch (error) { result = { error: publicError(error) }; }
    if (Buffer.byteLength(JSON.stringify(result)) > MAX_SOURCE * 2) result = { error: 'Result exceeds the tool response limit; narrow the lookup.' };
    await save(path, { ...record, completed_at: new Date().toISOString(), result, result_hash: digest(JSON.stringify(result)) });
    return { ...result, calls_remaining: MAX_CALLS - used, evidence_path: path };
  }
  const trackedCall = (name, args, extraSignal) => {
    const task = call(name, args, extraSignal); pending.add(task);
    void task.finally(() => pending.delete(task)).catch(() => {});
    return task;
  };
  async function prefetch() {
    const path = join(directory, 'starting-context.json');
    // Preserve the same advisory context across quota continuations/restarts.
    const saved = await readJson(path);
    if (saved) return path;
    const suggestions = [], gaps = [], deadline = AbortSignal.timeout(10000);
    try {
      const index = await hintIndex(client, target, options), wanted = terms(`${target.theorem_name} ${target.theorem_title ?? ''} ${target.formal_statement} ${target.preamble ?? ''}`);
      for (const word of terms(target.theorem_name.split('.').slice(0, -1).join(' '))) wanted.delete(word);
      const ranked = [...index.values()].filter(row => row.id !== idOf(target) && row.status !== 'Open')
        .map(row => ({ ...row, score: [...terms(row.text)].filter(t => wanted.has(t)).length }))
        .filter(row => row.score >= 2).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
      for (const hint of ranked.slice(0, 6)) {
        if (suggestions.length === 3 || deadline.aborted || signal.aborted) break;
        const result = await trackedCall('read_declaration', { id: hint.id, ...hint.status === 'Definition' ? { kind: 'definition' } : {} }, deadline);
        if (result.usable_in_complete_proof) {
          const { formal_statement, definition, preamble, ...brief } = result;
          suggestions.push({ ...brief, preamble_preview: preamble.slice(0, 800),
            statement_preview: String(formal_statement ?? definition).slice(0, 1600),
            guidance: 'Read the exact declaration snapshot before use; previews may be truncated.' });
        }
        else if (result.error) gaps.push({ id: hint.id, error: result.error });
      }
    } catch { gaps.push({ error: 'Optional local hint index unavailable' }); }
    await save(path, { identity, suggestions, gaps,
      guidance: 'Advisory matches from local mission/declaration caches, revalidated when fetched. Search live for other results. Check exact hypotheses and definitions; final validation refreshes every selected import.' });
    return path;
  }
  return { directory, call: trackedCall, prefetch,
    async close() { closed = true; controller.abort(); await Promise.allSettled([...pending]); } };
}

// The bridge receives only this invocation's read-only capability, never the
// platform key. Requests use the runner's existing authenticated Client.
export async function openTheoremLibrary(client, target, dir, attempt, options = {}) {
  const library = await createTheoremLibrary(client, target, dir, attempt, options);
  const capability = `/${randomUUID()}`;
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== capability || req.headers.origin) { res.writeHead(403).end(); return; }
    try {
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (Buffer.byteLength(body) > 16384) { res.writeHead(413).end(); return; }
      }
      const { name, arguments: args } = JSON.parse(body);
      const result = await library.call(name, args);
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(result));
    } catch { res.writeHead(500).end(JSON.stringify({ error: 'Theorem-library request failed' })); }
  });
  server.requestTimeout = 150000;
  try { await new Promise((yes, no) => { server.once('error', no); server.listen(0, '127.0.0.1', yes); }); }
  catch (error) { await library.close(); throw error; }
  const endpoint = `http://127.0.0.1:${server.address().port}${capability}`;
  const config = { command: process.execPath, args: [join(ROOT, 'theorem-library-mcp.mjs'), endpoint],
    enabled: true, required: false, enabled_tools: LIBRARY_TOOLS.map(t => t.name), tool_timeout_sec: 130 };
  // A whole TOML inline-table argument avoids global config edits and shares
  // no platform credentials with the Codex child or its environment.
  const toml = `{command=${JSON.stringify(config.command)},args=${JSON.stringify(config.args)},enabled=true,required=false,enabled_tools=${JSON.stringify(config.enabled_tools)},tool_timeout_sec=130}`;
  return { ...library, endpoint, configArgs: ['--config', `mcp_servers.prove2me_library=${toml}`],
    async close() {
      await library.close();
      const closing = new Promise(resolve => server.close(resolve));
      server.closeAllConnections(); await closing;
    } };
}
