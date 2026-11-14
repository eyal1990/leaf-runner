import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { createTheoremLibrary, openTheoremLibrary, retrievalDependencyHints, LIBRARY_TOOLS } from '../theorem-library.mjs';
import { createJobStages } from '../job-stages.mjs';
import { Client, agent, mirror } from '../prove2me.mjs';
import { ApiRecovery } from '../api-recovery.mjs';
import { ApiError } from '../api-errors.mjs';
import { agentPrompt } from '../agent-prompts.mjs';
import { digest, save } from '../runner-state.mjs';

const rev = 'a'.repeat(40);
const target = { theorem_id: 'target', theorem_name: 'Ns.planar_finite_maximal', theorem_title: 'Finite maximal planar extension',
  status: 'Open', mathlib_rev: rev, preamble: 'import Mathlib', formal_statement: 'theorem Ns.planar_finite_maximal : True := by sorry' };
const theorem = { theorem_id: 'helper', theorem_name: 'Ns.finite_maximal', theorem_title: 'Finite maximal extension',
  status: 'Proved', mathlib_rev: rev, preamble: 'import Definitions.Def_Drawing', formal_statement: 'theorem Ns.finite_maximal : True := by sorry' };
const definition = { theorem_id: 'drawing', theorem_name: 'Drawing', status: 'Definition', mathlib_rev: rev, definition: 'def Drawing := Nat' };
const toolsBridge = fileURLToPath(new URL('../theorem-library-mcp.mjs', import.meta.url));

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'prove2me-library-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = join(root, 'runs', 'target'), cacheDir = join(root, 'cache');
  await mkdir(dir, { recursive: true }); await mkdir(cacheDir);
  const calls = [], rows = new Map([['helper', theorem], ['drawing', definition]]);
  const client = { async pages(path) { calls.push(path); return structuredClone([...rows.values()]); }, async request(path) {
    calls.push(path);
    if (path.startsWith('definitions')) throw new ApiError(404, '/api/v1/definitions');
    if (path === 'theorems/target') return target;
    if (path.endsWith('/decompositions')) return { decompositions: [{ submission_id: 'accepted-sketch', children: [
      { theorem_id: 'unresolved', theorem_name: 'Ns.unresolved', status: 'Open', mathlib_rev: rev },
      { definition_id: 'drawing', definition_name: 'Drawing', mathlib_rev: rev },
    ] }] };
    if (path.startsWith('theorems?')) return { theorems: [...rows.values()], total: 2 };
    const row = rows.get(path.split('/')[1]);
    if (!row) throw new ApiError(404, '/api/v1/theorems/unknown');
    return structuredClone(row);
  } };
  const options = { runs: join(root, 'runs'), cacheDir, rootId: 'mission-root' };
  return { root, dir, cacheDir, calls, rows, client, options };
}

test('search pins revision/status, bounds pagination, and reads exact fresh sources without publishing', async t => {
  const h = await fixture(t), library = await createTheoremLibrary(h.client, target, h.dir, 1, h.options);
  t.after(() => library.close());
  const search = await library.call('search_declarations', { query: 'finite & maximal', limit: 2 });
  assert.equal(search.results.length, 1);
  assert.equal(search.results[0].module, 'Theorems.Thm_Ns_finite_maximal');
  const query = new URL(h.calls[0], 'https://prove2.me/api/v1/').searchParams;
  assert.equal(query.get('env'), rev); assert.equal(query.get('status'), 'Proved');
  assert.equal(query.get('q'), 'finite & maximal'); assert.equal(query.get('limit'), '2');
  const read = await library.call('read_declaration', { id: 'helper' });
  assert.equal(read.formal_statement, theorem.formal_statement);
  assert.deepEqual(read.platform_imports, ['Definitions.Def_Drawing']);
  assert.equal(read.usable_in_complete_proof, true);
  assert.equal(read.source_hash, digest(`${theorem.preamble}\n${theorem.formal_statement}\n`));
  assert.equal(JSON.parse(await readFile(read.snapshot_path)).formal_statement, theorem.formal_statement);
  const evidence = JSON.parse(await readFile(read.evidence_path));
  assert.equal(evidence.result_hash, digest(JSON.stringify(evidence.result)));
  h.rows.set('helper', { ...theorem, status: 'Open', formal_statement: 'theorem Ns.finite_maximal : False := by sorry' });
  const changed = await library.call('read_declaration', { id: 'helper' });
  assert.equal(changed.status, 'Open'); assert.equal(changed.usable_in_complete_proof, false);
  assert.notEqual(changed.source_hash, read.source_hash);
  const unavailable = await library.call('read_declaration', { id: 'missing' });
  assert.match(unavailable.error, /HTTP 404.*No cached source/);
  assert.ok(h.calls.every(path => /^(theorems|definitions)/.test(path)));
});

test('tools reject arbitrary API operations, wrong environments, circular targets, and deprecated results', async t => {
  const h = await fixture(t), library = await createTheoremLibrary(h.client, target, h.dir, 1, h.options);
  t.after(() => library.close());
  for (const [name, args] of [
    ['submit', {}], ['read_declaration', { id: '../credentials' }], ['read_declaration', { id: 'helper', method: 'POST' }],
    ['search_declarations', { query: 'hi', env: 'another' }], ['search_declarations', { query: 'hi', limit: 11 }],
    ['search_declarations', { query: 'hi', offset: -1 }], ['search_declarations', { query: 'hi', status: 'Anything' }],
  ]) assert.ok((await library.call(name, args)).error);
  assert.equal(h.calls.length, 0);
  assert.ok((await library.call('read_declaration', { id: 'target' })).error);
  assert.equal(h.calls.length, 0);
  h.rows.set('helper', { ...theorem, mathlib_rev: 'b'.repeat(40) });
  assert.ok((await library.call('read_declaration', { id: 'helper' })).error);
  h.rows.set('helper', { ...theorem, deprecated_at: 'now' });
  assert.ok((await library.call('read_declaration', { id: 'helper' })).error);
  h.rows.set('helper', { ...theorem, theorem_id: 'wrong-id' });
  assert.ok((await library.call('read_declaration', { id: 'helper' })).error);
});

test('definition searches explicitly request Definition and dependency inspection retains open obligations', async t => {
  const h = await fixture(t), library = await createTheoremLibrary(h.client, target, h.dir, 1, h.options);
  t.after(() => library.close());
  const result = await library.call('search_declarations', { query: 'Drawing', status: 'Definition' });
  assert.equal(result.results[0].module, 'Definitions.Def_Drawing');
  assert.ok(h.calls.some(path => /status=Definition/.test(path)));
  assert.equal((await library.call('read_declaration', { id: 'drawing' })).definition, definition.definition);
  const deps = await library.call('inspect_dependencies', { id: 'helper' });
  assert.equal(deps.reductions[0].submission_id, 'accepted-sketch');
  assert.equal(deps.reductions[0].children[0].status, 'Open');
  assert.equal(deps.reductions[0].children[1].status, 'Definition');
  assert.equal(deps.truncated, false);
});

test('current definition endpoints return native definition identities without a theorem status field', async t => {
  const h = await fixture(t), original = h.client.request;
  const native = { definition_id: 'drawing', definition_name: 'Drawing', definition_title: 'Drawing definition',
    definition: 'def Drawing := Nat', mathlib_rev: rev };
  h.client.request = async path => path.startsWith('definitions?') ? { definitions: [native], total: 1 }
    : path === 'definitions/drawing' ? native : original(path);
  const library = await createTheoremLibrary(h.client, target, h.dir, 1, h.options);
  t.after(() => library.close());
  const search = await library.call('search_declarations', { query: 'Drawing', status: 'Definition' });
  assert.equal(search.results[0].kind, 'definition');
  const read = await library.call('read_declaration', { id: 'drawing', kind: 'definition' });
  assert.equal(read.id, 'drawing'); assert.equal(read.status, 'Definition');
  assert.equal(read.definition, native.definition); assert.equal(read.module, 'Definitions.Def_Drawing');
  const hints = await retrievalDependencyHints(h.dir, 1, target);
  assert.equal(hints[0].theorem_id, 'drawing');
  const canonicalOnly = { request: async path => {
    if (path === 'definitions/drawing') return native;
    throw new ApiError(404, '/api/v1/theorems/drawing');
  }, pages: async (path, key) => {
    if (key === 'definitions') return [native];
    throw new ApiError(422, '/api/v1/theorems');
  } };
  assert.deepEqual(await mirror(canonicalOnly, undefined, 'import Definitions.Def_Drawing', target,
    { sourceOnly: true, direct: true, cacheDir: h.cacheDir, knownDependencies: hints }), ['Definitions.Def_Drawing']);
  assert.deepEqual(await mirror(canonicalOnly, undefined, 'import Definitions.Def_Drawing', target,
    { sourceOnly: true, direct: true, cacheDir: join(h.root, 'uncached') }), ['Definitions.Def_Drawing']);
});

test('lookup budget survives resumes and concurrent calls cannot exceed it', async t => {
  const h = await fixture(t);
  let library = await createTheoremLibrary(h.client, target, h.dir, 1, h.options);
  const results = await Promise.all(Array.from({ length: 26 }, () => library.call('read_declaration', { id: 'helper' })));
  assert.equal(results.filter(r => !r.error).length, 24);
  assert.equal(h.calls.length, 24);
  await library.close();
  library = await createTheoremLibrary(h.client, target, h.dir, 1, h.options);
  assert.match((await library.call('read_declaration', { id: 'helper' })).error, /budget exhausted/);
  assert.equal(h.calls.length, 24);
  await library.close();
  const next = await createTheoremLibrary(h.client, target, h.dir, 2, h.options);
  assert.equal((await next.call('read_declaration', { id: 'helper' })).calls_remaining, 23);
  await next.close();
});

test('local hint preparation is small, live-checked, and preserved for continuation', async t => {
  const h = await fixture(t);
  await save(join(h.cacheDir, 'hint.json'), { id: 'helper', module: 'Theorems.Thm_Ns_finite_maximal', mathlib_rev: rev,
    content: 'theorem Ns.finite_maximal : True := by sorry' });
  const library = await createTheoremLibrary(h.client, target, h.dir, 1, h.options);
  const path = await library.prefetch(), packet = JSON.parse(await readFile(path));
  assert.equal(packet.suggestions.length, 1);
  assert.equal(packet.suggestions[0].status, 'Proved');
  assert.deepEqual(h.calls, ['theorems/helper']);
  await library.prefetch();
  assert.equal(h.calls.length, 1, 'continuation keeps its original advisory snapshot');
  for (const variant of ['balanced', 'proof_first', 'proofOnly']) {
    const prompt = agentPrompt(target, h.dir, 1, '', 'solution.lean', { promptExperiment: { variant },
      theoremLibrary: { startingContextPath: path, evidenceDirectory: library.directory } });
    assert.match(prompt, /search_declarations, read_declaration, inspect_dependencies/);
    assert.ok(prompt.includes(path));
    assert.match(prompt, /24 lookups per attempt/);
    assert.match(prompt, /check|Check/);
  }
  await library.close();
  const resumed = await createTheoremLibrary(h.client, target, h.dir, 1, h.options);
  assert.equal(await resumed.prefetch(), path); assert.equal(h.calls.length, 1);
  await resumed.close();
});

test('failed local hints never supply stale or inaccessible declarations', async t => {
  const h = await fixture(t);
  await save(join(h.cacheDir, 'hint.json'), { id: 'helper', mathlib_rev: rev, module: 'Theorems.Thm_Ns_finite_maximal',
    content: 'theorem Ns.finite_maximal : True := by sorry' });
  h.client.request = async () => { throw Object.assign(new Error('secret-key-in-upstream-error'), { status: 403 }); };
  const library = await createTheoremLibrary(h.client, target, h.dir, 1, h.options);
  const packet = JSON.parse(await readFile(await library.prefetch()));
  assert.equal(packet.suggestions.length, 0); assert.equal(packet.gaps.length, 1);
  assert.doesNotMatch(JSON.stringify(packet), /secret-key/);
  await library.close();
});

test('closing one session aborts its reads and does not stop other sessions', async t => {
  const h = await fixture(t);
  let started;
  const begun = new Promise(resolve => { started = resolve; });
  const normal = h.client.request;
  h.client.request = async (path, options) => {
    if (path === 'theorems/stalled') {
      started();
      return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
    }
    return normal(path, options);
  };
  const a = await createTheoremLibrary(h.client, target, h.dir, 1, h.options);
  const b = await createTheoremLibrary(h.client, target, h.dir, 2, h.options);
  const pending = a.call('read_declaration', { id: 'stalled' });
  await begun; await a.close();
  assert.match((await pending).error, /cancelled/);
  assert.equal((await b.call('read_declaration', { id: 'helper' })).status, 'Proved');
  await b.close();
});

test('API recovery allows cancelling a lookup while another job retains the shared recovery probe', async () => {
  const client = { report() {}, requestOnce: async () => ({ ok: true }) };
  const recovery = new ApiRecovery(client);
  let release;
  recovery.gate = () => new Promise(resolve => { release = resolve; });
  const controller = new AbortController();
  const pending = recovery.request('theorems/helper', { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  release();
  recovery.gate = async () => {};
  assert.deepEqual(await recovery.request('theorems/helper', {}), { ok: true });
});

test('Client propagates per-lookup cancellation without cancelling other shared requests', async () => {
  let started;
  const begun = new Promise(resolve => { started = resolve; });
  const client = new Client('never-exposed', async (url, options) => {
    if (url.pathname.endsWith('/stall')) {
      started(); return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
    }
    return new Response(JSON.stringify({ ok: true }));
  });
  client.token = 'token'; client.expiry = Date.now() + 3600000;
  const controller = new AbortController(), pending = client.request('theorems/stall', { signal: controller.signal });
  await begun; controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.deepEqual(await client.request('theorems/helper'), { ok: true });
});

test('real stdio bridge negotiates MCP, lists only read tools, and performs a journaled lookup', async t => {
  const h = await fixture(t), library = await openTheoremLibrary(h.client, target, h.dir, 1, h.options);
  t.after(() => library.close());
  const child = spawn(process.execPath, [toolsBridge, library.endpoint], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  t.after(() => child.kill());
  const lines = createInterface({ input: child.stdout });
  const responses = lines[Symbol.asyncIterator]();
  const rpc = async (id, method, params) => {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    const next = await responses.next(); return JSON.parse(next.value);
  };
  const init = await rpc(1, 'initialize', { protocolVersion: '2025-06-18' });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  assert.deepEqual((await rpc(2, 'tools/list')).result.tools.map(t => t.name), LIBRARY_TOOLS.map(t => t.name));
  const read = await rpc(3, 'tools/call', { name: 'read_declaration', arguments: { id: 'helper' } });
  assert.equal(read.result.isError, false);
  const result = JSON.parse(read.result.content[0].text);
  assert.equal(result.status, 'Proved'); assert.ok(result.evidence_path);
  const wrong = await rpc(4, 'tools/call', { name: 'publish', arguments: {} });
  assert.equal(wrong.result.isError, true);
  const closed = once(child, 'close'); child.stdin.end(); await closed;
  const forbidden = await fetch(library.endpoint + 'wrong', { method: 'POST' });
  assert.equal(forbidden.status, 403);
  assert.equal((await fetch(library.endpoint, { method: 'POST', headers: { Origin: 'https://example.com' } })).status, 403);
  assert.doesNotMatch(JSON.stringify(library.configArgs), /never-exposed|api_key|Authorization/);
});

test('pinned Codex CLI accepts the per-invocation MCP configuration without a model call', async t => {
  const h = await fixture(t), library = await openTheoremLibrary(h.client, target, h.dir, 1, h.options);
  t.after(() => library.close());
  const codexHome = join(h.root, 'isolated-codex-home'); await mkdir(codexHome);
  const cli = fileURLToPath(new URL('../node_modules/@openai/codex/bin/codex.js', import.meta.url));
  const { stdout } = await promisify(execFile)(process.execPath, [cli, ...library.configArgs, 'mcp', 'get', 'prove2me_library', '--json'],
    { env: { ...process.env, CODEX_HOME: codexHome }, windowsHide: true, timeout: 15000 });
  const config = JSON.parse(stdout);
  assert.equal(config.enabled, true);
  assert.deepEqual(config.transport.args, [toolsBridge, library.endpoint]);
  assert.equal(config.transport.command, process.execPath);
});

test('proof invocation consumes live lookup tools and selected imports still pass fresh normal mirroring', async t => {
  const h = await fixture(t), workspace = join(h.root, 'workspace');
  await mkdir(join(workspace, 'Solutions'), { recursive: true });
  const cliDir = join(h.root, 'fake', 'node_modules/@openai/codex/bin'); await mkdir(cliDir, { recursive: true });
  const shim = join(h.root, 'fake', 'codex.cmd'); await writeFile(shim, 'test shim');
  await writeFile(join(cliDir, 'codex.js'), `
    const { readFileSync, writeFileSync } = require('node:fs');
    const { join } = require('node:path');
    (async () => {
      const args = process.argv.slice(2), prompt = readFileSync(0, 'utf8');
      if (!prompt.includes('search_declarations, read_declaration, inspect_dependencies')) throw new Error('Missing tool instructions');
      const config = args.find(x => x.startsWith('mcp_servers.prove2me_library='));
      const endpoint = JSON.parse(config.slice(config.indexOf('args=') + 5, config.indexOf(',enabled=')))[1];
      const result = await (await fetch(endpoint, { method: 'POST', body: JSON.stringify({ name: 'read_declaration', arguments: { id: 'helper' } }) })).json();
      if (result.status !== 'Proved') throw new Error('No proved helper');
      writeFileSync(join(process.cwd(), 'Solutions/Sol_target.lean'), 'import ' + result.module + '\\ntheorem solution : True := Ns.finite_maximal');
      writeFileSync(args[args.indexOf('--output-last-message') + 1], JSON.stringify({ ready: true, kind: 'proof', children: [], definitions: [], explanation: 'Reuse the existing proved declaration.' }));
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `);
  t.mock.method(console, 'log', () => {});
  const result = await agent(target, workspace, h.dir, 1, '', { ...h.options, codex: shim, agentTimeout: 10,
    theoremLibraryClient: h.client, promptExperiment: { variant: 'proofOnly' } });
  assert.equal(result.kind, 'proof');
  const metadata = JSON.parse(await readFile(join(h.dir, 'prompt-1.json')));
  assert.ok(metadata.theorem_library.startingContextPath);
  assert.equal((await readdir(join(h.dir, 'retrieval-1/calls'))).length, 1);
  const source = await readFile(result.solution, 'utf8');
  const hints = await retrievalDependencyHints(h.dir, 1, target);
  assert.equal(hints[0].theorem_id, 'helper');
  h.client.pages = async path => { assert.match(path, /status=Definition/); return [definition]; };
  const mirrored = await mirror(h.client, workspace, source, target, { direct: true, knownDependencies: hints, cacheDir: h.cacheDir, sourceOnly: true });
  assert.deepEqual(mirrored.sort(), ['Definitions.Def_Drawing', 'Theorems.Thm_Ns_finite_maximal']);
  const stages = createJobStages({ client: h.client, target, context: {}, environment: { toolchain: 'leanprover/lean4:v4.33.1' },
    options: { verificationMode: 'server-only' }, dir: h.dir, pins: () => '-- pinned environment',
    mirror: (client, workspace, source, target, settings) => mirror(client, workspace, source, target, { ...settings, sourceOnly: true, cacheDir: h.cacheDir }) });
  assert.equal((await stages.validate({ workspace, knownDependencies: [], candidate: result, attempt: 1 })).type, 'VALIDATED');
  h.rows.set('helper', { ...theorem, status: 'Open' });
  await assert.rejects(stages.checkSubmission({ source, kind: 'proof', candidate: result, attempt: 1 }), /direct proofs require Proved/);
});
