import { solveLeaf } from '../test-support/selection-rounds.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Client, ApiError, runTarget, imports, gate, mirror, poll, agent, typeCheckSource, childEnv, command, main } from '../prove2me.mjs';
import { findTarget, openLeaves } from '../work-selection.mjs';
import { normalizeSolutionDeclaration } from '../lean-artifacts.mjs';

const rev = 'a'.repeat(40);
const environment = { mathlib_rev: rev, toolchain: 'leanprover/lean4:v4.33.1' };
const target = { theorem_id: 'leaf-1', theorem_name: 'Ns.goal', status: 'Open', preamble: '', formal_statement: 'theorem Ns.goal (n : Nat) : n = n := by sorry', mathlib_rev: rev };
const mission = { id: 'mission-1', name: 'The irrationality measure of π is 2 (OpenAI)', main_theorem: { theorem_id: 'root-1' } };
const milestone = { id: 'mile-1', title: 'Lower bound', theorem: { id: 'bound-1' } };
const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
async function temporary(t) {
  const dir = await mkdtemp(join(tmpdir(), 'prove2me-test-'));
  t.after(() => rm(dir, { recursive: true, force: true })); return dir;
}

test('API key exchange, 401 renewal, multipart upload, and redirects', async () => {
  let refreshes = 0, calls = 0;
  const client = new Client('p2m_test', async (url, options) => {
    assert.equal(options.redirect, 'error'); assert.equal(url.origin, 'https://prove2.me');
    if (url.pathname.endsWith('agent/refresh')) {
      assert.deepEqual(JSON.parse(options.body), { api_key: 'p2m_test' });
      return response({ access_token: `token${++refreshes}`, expires_at: Date.now() / 1000 + 3600 });
    }
    if (++calls === 1) return response({}, 401);
    assert.equal(options.headers.Authorization, 'Bearer token2');
    assert.ok(options.body instanceof FormData);
    assert.equal(options.body.get('theorem_id'), 'leaf-1');
    assert.equal(options.body.get('proof_type'), 'prove');
    assert.equal(await options.body.get('file').text(), 'theorem solution : True := by trivial');
    assert.equal(options.body.get('explanation'), 'True holds.');
    return response({ submission_id: 'sub-1' });
  });
  assert.equal((await client.submit('leaf-1', 'theorem solution : True := by trivial', 'True holds.')).submission_id, 'sub-1');
  assert.equal(refreshes, 2);
  await assert.rejects(client.request('https://other.example/api/v1/missions'), /Invalid API URL/);
});

test('rejected API keys explain recovery while preserving HTTP error classification', async () => {
  let calls = 0;
  const client = new Client('private-rejected-key', async () => { calls++; return response({}, 401); });
  await assert.rejects(client.request('missions'), error => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 401);
    assert.match(error.message, /authentication failed.*server rejected.*HTTP 401/);
    assert.match(error.message, /account menu > API key.*rerun the command/);
    assert.doesNotMatch(error.message, /private-rejected-key/);
    return true;
  });
  assert.equal(calls, 1, 'a rejected API key must not be retried');
  client.fetcher = async () => response({}, 503);
  await assert.rejects(client.refresh(), error => error.message === 'Prove2.me HTTP 503 at /api/v1/agent/refresh');
});

test('CLI authentication errors identify the active credential source without exposing secrets', async t => {
  const dir = await temporary(t), credentials = join(dir, 'custom-credentials.json');
  await writeFile(credentials, JSON.stringify({ api_key: 'private-file-key' }));
  const previousKey = process.env.PROVE2ME_API_KEY, messages = [];
  t.after(() => {
    if (previousKey === undefined) delete process.env.PROVE2ME_API_KEY;
    else process.env.PROVE2ME_API_KEY = previousKey;
  });
  t.mock.method(console, 'log', message => messages.push(String(message)));
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async url => {
    calls++;
    assert.equal(url.pathname, '/api/v1/agent/refresh');
    return response({ detail: 'private-server-details' }, 401);
  });
  for (const useEnv of [false, true]) {
    if (useEnv) process.env.PROVE2ME_API_KEY = 'private-env-key';
    else delete process.env.PROVE2ME_API_KEY;
    await assert.rejects(main(['--mission-id', 'mission-1', '--credentials', credentials]), error => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, 401);
      assert.ok(error.message.includes(useEnv ? 'PROVE2ME_API_KEY' : `api_key in "${credentials}"`));
      if (useEnv) assert.ok(!error.message.includes(credentials));
      assert.doesNotMatch(error.message, /private-/);
      return true;
    });
  }
  assert.equal(calls, 2, 'each launch stops at the rejected key exchange');
  assert.doesNotMatch(messages.join('\n'), /private-/);
});

test('uncertain submission POST is never automatically retried', async () => {
  let posts = 0;
  const client = new Client('key', async url => {
    if (url.pathname.endsWith('agent/refresh')) return response({ access_token: 'token', expires_at: Date.now() / 1000 + 3600 });
    posts++; throw new Error('connection lost');
  });
  await assert.rejects(client.submit('leaf', 'code', 'explanation'), /connection lost/);
  assert.equal(posts, 1);
});

test('submission pagination uses submission identity rather than the shared theorem ID', async () => {
  const calls = [];
  const client = new Client('key', async url => {
    calls.push(url.searchParams.get('offset'));
    const submissions = url.searchParams.get('offset') === '0'
      ? [{ id: 'sub-1', theorem_id: 'same-theorem' }, { id: 'sub-2', theorem_id: 'same-theorem' }]
      : [{ id: 'sub-3', theorem_id: 'same-theorem' }];
    return response({ submissions, total: 3 });
  });
  client.token = 'token'; client.expiry = Date.now() + 3600000;
  assert.deepEqual((await client.pages('theorems/same-theorem/submissions', 'submissions')).map(s => s.id),
    ['sub-1', 'sub-2', 'sub-3']);
  assert.deepEqual(calls, ['0', '2']);
  client.fetcher = async () => response({ submissions: [{ id: 'duplicate', theorem_id: 't' },
    { id: 'duplicate', theorem_id: 't' }], total: 2 });
  await assert.rejects(client.pages('theorems/t/submissions', 'submissions'), /Unstable submissions pagination/);
});

test('disproof uploads use the documented multipart mode and preserve certificate bytes', async () => {
  const source = 'theorem solution : ¬ (∀ n : Nat, n = 0) := by intro h; cases h 1\n';
  let posts = 0;
  const client = new Client('key', async (url, options) => {
    posts++;
    assert.equal(url.pathname, '/api/v1/verify');
    assert.equal(options.body.get('proof_type'), 'disprove');
    assert.equal(options.body.get('theorem_id'), 'false-leaf');
    assert.equal(await options.body.get('file').text(), source);
    assert.equal(options.body.get('explanation'), 'Take $n=1$. ');
    return response({ submission_id: 'disproof-1' });
  });
  client.token = 'token'; client.expiry = Date.now() + 3600000;
  assert.equal((await client.submit('false-leaf', source, 'Take $n=1$.\0', 'disprove')).submission_id, 'disproof-1');
  await assert.rejects(client.submit('false-leaf', source, 'Witness.', 'invalid'), /Invalid proof type/);
  assert.equal(posts, 1);
});

test('submission strips NULs from prose while preserving proof bytes and reporting the POST', async () => {
  const messages = [], source = 'theorem solution : True := by trivial\n';
  const client = new Client('key', async (url, options) => {
    assert.equal(url.pathname, '/api/v1/verify');
    assert.equal(await options.body.get('file').text(), source);
    assert.equal(options.body.get('explanation'), '$x=0,  y=1$\nUnicode: π ≥ 2.');
    return response({ submission_id: 'sub-1' });
  }, { report: message => messages.push(message) });
  client.token = 'token'; client.expiry = Date.now() + 3600000;
  await client.submit('leaf', source, '$x=0,\0 y=1$\nUnicode: π ≥ 2.');
  assert.equal(messages.length, 1, 'one result log per verification request');
  assert.match(messages.at(-1), /POST \/api\/v1\/verify completed/);
});

test('GET retries transient failures with backoff and honors bounded Retry-After', async () => {
  const delays = [], messages = [];
  let calls = 0;
  const client = new Client('key', async () => {
    calls++;
    if (calls === 1) return response({}, 500);
    if (calls === 2) return new Response('{}', { status: 429, headers: { 'Retry-After': '60' } });
    return response({ theorems: [] });
  }, { wait: async delay => delays.push(delay), report: message => messages.push(message) });
  client.token = 'token'; client.expiry = Date.now() + 3600000;
  assert.deepEqual(await client.request('theorems?q=private-query'), { theorems: [] });
  assert.deepEqual(delays, [1000, 10000]);
  assert.equal(calls, 3);
  assert.equal(messages.filter(message => message.startsWith('Retrying')).length, 2);
  assert.doesNotMatch(messages.join('\n'), /private-query/);
});

test('GET retry limit, timeout recovery, and permanent HTTP errors', async () => {
  let calls = 0;
  const delays = [];
  const client = new Client('key', async () => { calls++; return response({}, 503); }, { wait: async delay => delays.push(delay) });
  client.token = 'token'; client.expiry = Date.now() + 3600000;
  await assert.rejects(client.request('theorems'), error => error instanceof ApiError && error.status === 503);
  assert.equal(calls, 3); assert.deepEqual(delays, [1000, 2000]);
  for (const status of [400, 403, 404]) {
    calls = 0; client.fetcher = async () => { calls++; return response({}, status); };
    await assert.rejects(client.request('theorems'), error => error.status === status);
    assert.equal(calls, 1);
  }
  for (const error of [new DOMException('timed out', 'TimeoutError'), new TypeError('fetch failed')]) {
    calls = 0; client.fetcher = async () => { if (++calls === 1) throw error; return response({ ok: true }); };
    assert.deepEqual(await client.request('theorems'), { ok: true });
    assert.equal(calls, 2);
  }
});

test('POST server failures and rate limits are never retried', async () => {
  for (const status of [429, 500, 502, 503, 504]) {
    let posts = 0;
    const client = new Client('key', async () => { posts++; return response({}, status); }, { wait: async () => assert.fail('POST retry') });
    client.token = 'token'; client.expiry = Date.now() + 3600000;
    await assert.rejects(client.submit('leaf', 'code', 'explanation'), error => error.status === status);
    assert.equal(posts, 1);
  }
});

test('API progress appears before a response, keeps waiting visible, and excludes secrets', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const messages = [];
  let finish;
  const body = new Promise(resolve => { finish = resolve; });
  const client = new Client('private-key', async () => ({ ok: true, json: () => body }), { report: message => messages.push(message) });
  const pending = client.raw('agent/refresh?secret=private-query', {
    method: 'POST', headers: { Authorization: 'Bearer private-token' }, body: '{"api_key":"private-key"}',
  });
  assert.deepEqual(messages, ['POST /api/v1/agent/refresh']);
  await Promise.resolve(); // Response headers have arrived; the JSON body is still pending.
  t.mock.timers.tick(15000);
  assert.match(messages.at(-1), /Waiting for POST .*request timeout: 60s/);
  finish({ access_token: 'private-result' });
  assert.deepEqual(await pending, { access_token: 'private-result' });
  assert.match(messages.at(-1), /completed/);
  assert.doesNotMatch(messages.join('\n'), /private-/);
  const count = messages.length;
  t.mock.timers.tick(30000);
  assert.equal(messages.length, count, 'completed requests stop their heartbeat');
});

test('API failures report the stage and stop their heartbeat without logging error secrets', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const messages = [];
  const failure = new Error('private-connection-details');
  const client = new Client('key', async () => { throw failure; }, { report: message => messages.push(message) });
  await assert.rejects(client.raw('missions'), error => error === failure);
  assert.match(messages.at(-1), /GET \/api\/v1\/missions failed .*Error/);
  assert.doesNotMatch(messages.join('\n'), /private-connection-details/);
  const count = messages.length;
  t.mock.timers.tick(30000);
  assert.equal(messages.length, count);
});

test('CLI accepts the exact π mission title and skips milestones in default auto mode', async t => {
  const events = [], previousKey = process.env.PROVE2ME_API_KEY;
  process.env.PROVE2ME_API_KEY = 'private-cli-key';
  t.mock.method(console, 'log', message => events.push(String(message)));
  t.mock.method(console, 'table', () => {});
  t.mock.method(globalThis, 'fetch', async url => {
    events.push(`fetch:${url.pathname}`);
    if (url.pathname.endsWith('agent/refresh')) return response({ access_token: 'private-cli-token', expires_at: Date.now() / 1000 + 3600 });
    if (url.pathname.endsWith('/missions')) return response({ missions: [mission], total: 1 });
    if (url.pathname.endsWith('/decompositions')) return response({ decompositions: [] });
    assert.equal(url.pathname, '/api/v1/theorems/root-1');
    return response({ ...target, theorem_id: 'root-1' });
  });
  try { await main([mission.name, '--list']); }
  finally {
    if (previousKey === undefined) delete process.env.PROVE2ME_API_KEY;
    else process.env.PROVE2ME_API_KEY = previousKey;
  }
  assert.match(events[0], /Starting Prove2.me runner/);
  assert.ok(events.findIndex(message => message.includes('Loading credentials')) < events.findIndex(message => message.startsWith('fetch:')));
  assert.ok(events.some(message => message.includes('Loaded 1/1 missions')));
  assert.ok(events.some(message => message.includes('1 open leaves')));
  assert.doesNotMatch(events.join('\n'), /private-cli-/);
});

test('pagination reads all pages including nested milestone totals', async () => {
  const client = new Client('key'); const offsets = [];
  client.request = async href => {
    const offset = Number(new URL(href).searchParams.get('offset')); offsets.push(offset);
    return { milestones: offset === 0 ? [{ id: 'a' }, { id: 'b' }] : [{ id: 'c' }], pagination: { total: 3 } };
  };
  assert.deepEqual(await client.pages('missions/id/milestones', 'milestones'), [{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
  assert.deepEqual(offsets, [0, 2]);
  client.request = async () => ({ milestones: [{ id: 'a' }], total: 3 });
  await assert.rejects(client.pages('missions/id/milestones', 'milestones'), /Unstable/);
});

test('CLI supports mission selection with an optional scoped milestone', async t => {
  const cases = [
    { name: 'mission only', args: ['--mission', mission.name], root: 'root-1' },
    { name: 'encoded mission name', args: ['--mission', encodeURIComponent(mission.name)], root: 'root-1' },
    { name: 'mission URL', args: ['--mission', 'https://prove2.me/missions/The_irrationality_measure_of_%CF%80_is_2_(OpenAI)'], root: 'root-1' },
    { name: 'positional mission URL', args: ['https://prove2.me/missions/The_irrationality_measure_of_π_is_2_(OpenAI)'], root: 'root-1' },
    { name: 'mission URL scopes milestone', args: ['--mission', 'https://prove2.me/missions/The_irrationality_measure_of_%CF%80_is_2_(OpenAI)', '--milestone', milestone.title], root: 'bound-1' },
    { name: 'partial mission only', args: ['--mission', 'irrationality measure'], root: 'root-1' },
    { name: 'mission and milestone names', args: ['--mission', mission.name, '--milestone', milestone.title], root: 'bound-1' },
    { name: 'mission and milestone IDs', args: ['--mission', mission.id, '--milestone', milestone.id], root: 'bound-1' },
    { name: 'positional mission with milestone flag', args: [mission.name, '--milestone', milestone.title], root: 'bound-1' },
    { name: 'original scoped milestone syntax', args: [milestone.title, '--kind', 'milestone', '--mission', mission.name], root: 'bound-1' },
    { name: 'milestone named the same as mission', args: ['--mission', mission.name, '--milestone', mission.name], root: 'collision-root' },
    { name: 'unknown milestone has no mission fallback', args: ['--mission', mission.name, '--milestone', 'Missing'], error: /No mission or milestone matches/ },
    { name: 'unlinked milestone has no mission fallback', args: ['--mission', mission.name, '--milestone', 'Unlinked'], error: /no linked theorem/ },
  ];
  for (const example of cases) await t.test(example.name, async sub => {
    const paths = [], previousKey = process.env.PROVE2ME_API_KEY;
    process.env.PROVE2ME_API_KEY = 'test-key';
    sub.mock.method(console, 'log', () => {});
    sub.mock.method(console, 'table', () => {});
    sub.mock.method(globalThis, 'fetch', async url => {
      const path = url.pathname;
      paths.push(path);
      if (path.endsWith('agent/refresh')) return response({ access_token: 'token', expires_at: Date.now() / 1000 + 3600 });
      if (path.endsWith('/missions')) return response({ missions: [mission, { ...mission, id: 'other-mission', name: 'Other mission' }], total: 2 });
      if (path.endsWith('/milestones')) {
        assert.equal(path, '/api/v1/missions/mission-1/milestones', 'only search the selected mission');
        return response({ milestones: [milestone, { ...milestone, id: 'collision', title: mission.name, theorem: { id: 'collision-root' } }, { ...milestone, id: 'unlinked', title: 'Unlinked', theorem: null }], total: 3 });
      }
      assert.equal(path, `/api/v1/theorems/${example.root}`);
      return response({ ...target, theorem_id: example.root, status: 'Proved' });
    });
    try {
      if (example.error) await assert.rejects(main([...example.args, '--list']), example.error);
      else await main([...example.args, '--list']);
    } finally {
      if (previousKey === undefined) delete process.env.PROVE2ME_API_KEY;
      else process.env.PROVE2ME_API_KEY = previousKey;
    }
    assert.equal(paths.filter(path => path.endsWith('/milestones')).length, example.root === 'root-1' ? 0 : 1);
    assert.equal(paths.filter(path => path.startsWith('/api/v1/theorems/')).length, example.error ? 0 : 1);
    assert.ok(paths.every(path => !path.endsWith('/open-leaves')));
  });
});

test('CLI rejects missing, empty, and conflicting selection arguments before networking', async t => {
  t.mock.method(globalThis, 'fetch', () => { assert.fail('Invalid arguments must not reach networking'); });
  for (const [args, error] of [
    [[], /Usage:/],
    [['--milestone', milestone.title], /requires --mission/],
    [['--mission', ' '], /--mission must not be empty/],
    [['--mission-id', ' '], /--mission-id must not be empty/],
    [['--mission-id', '../missions'], /Invalid mission ID/],
    [['--mission-id', mission.id, '--mission', mission.name], /not both/],
    [['--mission', mission.name, '--milestone', ' '], /--milestone must not be empty/],
    [['--mission', mission.name, '--milestone', milestone.title, '--kind', 'mission'], /cannot be combined/],
    [['--mission', mission.name, '--kind', 'milestone'], /requires a milestone name/],
    [[mission.name, '--mission', mission.name, '--milestone', milestone.title], /not both/],
  ]) await assert.rejects(main(args), error);
});

test('mission ID routes bypass discovery or stop catalog fallback when the ID is found', async t => {
  const id = '12345678-1234-1234-1234-123456789abc', selected = { ...mission, id };
  const cases = [
    { name: 'explicit ID directly fetches mission', args: ['--mission-id', id] },
    { name: 'UUID in mission flag directly fetches mission', args: ['--mission', id] },
    { name: 'explicit ID and milestone skip mission detail and catalog', args: ['--mission-id', id, '--milestone', milestone.title], milestone: true },
    { name: 'UUID and milestone ID skip mission detail and catalog', args: ['--mission', id, '--milestone', milestone.id], milestone: true },
    { name: 'legacy scoped milestone also skips catalog for UUID', args: [milestone.title, '--mission', id], milestone: true },
    { name: 'HTTP 405 fallback stops before the final catalog page', args: ['--mission-id', id], status: 405 },
    { name: 'HTTP 404 reports error without catalog fallback', args: ['--mission-id', id], status: 404, error: /HTTP 404/ },
    { name: 'invalid detail identity never falls back', args: ['--mission-id', id], invalid: true, error: /Invalid mission detail/ },
  ];
  for (const example of cases) await t.test(example.name, async sub => {
    const paths = [], offsets = [], previousKey = process.env.PROVE2ME_API_KEY;
    process.env.PROVE2ME_API_KEY = 'test-key';
    sub.mock.method(console, 'log', () => {});
    sub.mock.method(console, 'table', () => {});
    sub.mock.method(globalThis, 'fetch', async url => {
      const path = url.pathname;
      paths.push(path);
      if (path.endsWith('agent/refresh')) return response({ access_token: 'token', expires_at: Date.now() / 1000 + 3600 });
      if (path === `/api/v1/missions/${id}`) {
        assert.ok(!example.milestone, 'milestone selection must not request mission detail');
        return response(example.invalid ? { ...selected, id: 'wrong-id' } : selected, example.status ?? 200);
      }
      if (path === '/api/v1/missions') {
        assert.equal(example.status, 405, 'only an unsupported direct endpoint may fall back');
        const offset = Number(url.searchParams.get('offset'));
        offsets.push(offset);
        assert.ok(offset === 0 || offset === 100, 'must stop before fetching remaining missions');
        return response({ missions: offset === 0 ? Array.from({ length: 100 }, (_, i) => ({ ...mission, id: `other-${i}`, name: `Other ${i}` })) : [selected], total: 201 });
      }
      if (path === `/api/v1/missions/${id}/milestones`) {
        assert.ok(example.milestone);
        return response({ mission_id: id, milestones: [milestone], total: 1 });
      }
      const root = example.milestone ? 'bound-1' : 'root-1';
      assert.equal(path, `/api/v1/theorems/${root}`);
      return response({ ...target, theorem_id: root, status: 'Proved' });
    });
    try {
      if (example.error) await assert.rejects(main([...example.args, '--list']), example.error);
      else await main([...example.args, '--list']);
    } finally {
      if (previousKey === undefined) delete process.env.PROVE2ME_API_KEY;
      else process.env.PROVE2ME_API_KEY = previousKey;
    }
    assert.deepEqual(offsets, example.status === 405 ? [0, 100] : []);
    assert.equal(paths.filter(path => path === `/api/v1/missions/${id}`).length, example.milestone ? 0 : 1);
  });
});

test('resolve mission example, milestone by ID, and case-insensitive unique partial', async () => {
  const client = { pages: async (path) => path === 'missions' || path.startsWith('missions?') ? [mission] : [milestone] };
  assert.equal((await findTarget(client, mission.name)).root, 'root-1');
  assert.equal((await findTarget(client, 'mile-1', { kind: 'milestone' })).root, 'bound-1');
  assert.equal((await findTarget(client, 'LOWER', { mission: 'irrationality measure' })).name, 'Lower bound');
});

test('exact mission matches use filtered lookup and normalize whitespace', async () => {
  const calls = [];
  const client = { pages: async path => {
    calls.push(path);
    assert.ok(path.startsWith('missions?name='), 'exact mission lookup must use the name filter');
    return [mission];
  } };
  assert.equal((await findTarget(client, '  The irrationality measure of π is 2 (OPENAI)  ')).root, 'root-1');
  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0], 'https://prove2.me/api/v1/').searchParams.get('name'), 'The irrationality measure of π is 2 (OPENAI)');
  assert.equal((await findTarget(client, 'mission-1')).root, 'root-1');
});

test('exact mission shortcut preserves ambiguous and unlinked mission errors', async () => {
  const client = { pages: async path => {
    assert.ok(path.startsWith('missions?name='));
    return [mission, { ...mission, id: 'mission-2' }];
  } };
  await assert.rejects(findTarget(client, mission.name), /Ambiguous/);
  client.pages = async () => [{ ...mission, main_theorem: null }];
  await assert.rejects(findTarget(client, mission.name), /no linked theorem/);
});

test('explicit milestone kind bypasses an exact mission with the same title', async () => {
  const client = { pages: async path => path === 'missions' ? [mission] : [{ ...milestone, title: mission.name }] };
  const found = await findTarget(client, mission.name, { kind: 'milestone' });
  assert.equal(found.kind, 'milestone');
  assert.equal(found.root, 'bound-1');
});

test('ambiguous and unlinked milestones fail clearly', async () => {
  const client = { pages: async path => path === 'missions' || path.startsWith('missions?') ? [mission, { ...mission, id: 'mission-2', name: 'Other mission' }] : [milestone] };
  await assert.rejects(findTarget(client, 'Lower bound'), /Ambiguous/);
  client.pages = async path => path === 'missions' || path.startsWith('missions?') ? [mission] : [{ ...milestone, theorem: null }];
  await assert.rejects(findTarget(client, 'Lower bound'), /no linked theorem/);
});

test('source gates understand multi-module imports and nested comments', () => {
  const source = '/- sorry /- nested -/ import Theorems.Thm_Ns_goal -/\nimport Mathlib Theorems.Thm_Helper\n-- admit\n#check "sorry"\ntheorem solution (n : Nat) : n = n := by rfl';
  assert.deepEqual(imports(source), ['Mathlib', 'Theorems.Thm_Helper']);
  gate(source, target);
  for (const hole of ['sorry', 'admit']) assert.throws(() => gate(`theorem solution : True := by ${hole}`, target), /proof hole/);
  assert.throws(() => gate('import Theorems.Thm_Ns_goal\ntheorem solution : True := by trivial', target), /own target/);
  assert.throws(() => gate('import Solutions.Other\ntheorem solution : True := by trivial', target), /self-contained/);
  assert.throws(() => gate('axiom magic : False\ntheorem solution : True := by trivial', target), /untrusted/);
});

test('mirror resolves dotted names, full definition bodies and transitive imports', async t => {
  const dir = await temporary(t);
  await mkdir(join(dir, 'Definitions')); await mkdir(join(dir, 'Theorems'));
  const helper = { theorem_id: 'helper', theorem_name: 'Ns.helper', status: 'Proved', mathlib_rev: rev, preamble: 'import Definitions.Def_Count', formal_statement: 'theorem Ns.helper : count = count := by sorry' };
  const definition = { theorem_id: 'def', theorem_name: 'Count', status: 'Definition', mathlib_rev: rev, definition: 'def count : Nat := 3' };
  const client = { pages: async () => [helper, definition], request: async path => path.endsWith('helper') ? helper : definition };
  const options = { direct: true, cacheDir: join(dir, 'cache') };
  await mirror(client, dir, 'import Theorems.Thm_Ns_helper', target, options);
  assert.equal(await readFile(join(dir, 'Definitions/Def_Count.lean'), 'utf8'), definition.definition);
  assert.match(await readFile(join(dir, 'Theorems/Thm_Ns_helper.lean'), 'utf8'), /Ns.helper/);
  helper.status = 'Open';
  await assert.rejects(mirror(client, dir, 'import Theorems.Thm_Ns_helper', target, options), /Open dependency/);
  helper.status = 'Proved'; helper.preamble = 'import Theorems.Thm_Ns_goal';
  await assert.rejects(mirror(client, dir, 'import Theorems.Thm_Ns_helper', target, options), /circular proof/);
});

test('mirror rejects a dependency from another environment', async t => {
  const dir = await temporary(t);
  const row = { theorem_id: 'helper', theorem_name: 'Helper', status: 'Proved', mathlib_rev: 'b'.repeat(40) };
  const client = { pages: async () => [row], request: async () => row };
  await assert.rejects(mirror(client, dir, 'import Theorems.Thm_Helper', target, { cacheDir: join(dir, 'cache') }), /environment mismatch/);
});

test('definition mirroring uses exact names and cached IDs, refreshing source every time', async t => {
  const dir = await temporary(t), cacheDir = join(dir, 'cache');
  await mkdir(join(dir, 'Definitions'));
  let row = { theorem_id: 'def', theorem_name: 'OAI_ApproximationDefinitions', status: 'Definition', mathlib_rev: rev, definition: 'def count : Nat := 3' };
  const searches = [], details = [];
  const client = {
    pages: async path => {
      const url = new URL(path, 'https://prove2.me/api/v1/'); searches.push(url);
      assert.equal(url.searchParams.get('theorem_name'), row.theorem_name);
      assert.equal(url.searchParams.get('env'), rev);
      assert.equal(url.searchParams.get('status'), 'Definition');
      assert.equal(url.searchParams.has('q'), false);
      return [row];
    },
    request: async path => { details.push(path); return row; },
  };
  const source = 'import Definitions.Def_OAI_ApproximationDefinitions';
  await mirror(client, dir, source, target, { cacheDir });
  row = { ...row, definition: 'def count : Nat := 4' };
  await writeFile(join(dir, 'Definitions/Def_OAI_ApproximationDefinitions.lean'), 'tampered source');
  await mirror(client, dir, source, target, { cacheDir });
  assert.equal(searches.length, 1); assert.equal(details.length, 2);
  assert.equal(await readFile(join(dir, 'Definitions/Def_OAI_ApproximationDefinitions.lean'), 'utf8'), row.definition);
  row = { ...row, deprecated_at: '2026-10-12' };
  await assert.rejects(mirror(client, dir, source, target, { cacheDir }), /Deprecated dependency/);
});

test('uncached transitive definitions resolve when the catalog excludes definitions by default', async t => {
  const dir = await temporary(t), cacheDir = join(dir, 'cache');
  const rows = [
    { theorem_id: 'outer', theorem_name: 'Outer', status: 'Definition', mathlib_rev: rev,
      definition: 'import Definitions.Def_Ns_Encoding\ndef outer : Nat := encoded' },
    { theorem_id: 'encoding', theorem_name: 'Ns.Encoding', status: 'Definition', mathlib_rev: rev,
      definition: 'def encoded : Nat := 3' },
  ];
  const searches = [], details = [];
  const client = new Client('test', async url => {
    if (url.pathname.endsWith('/agent/refresh')) return response({ access_token: 'token', expires_at: Date.now() / 1000 + 3600 });
    if (url.pathname.endsWith('/theorems')) {
      searches.push(url);
      assert.equal(url.searchParams.get('env'), rev);
      const found = rows.filter(row => url.searchParams.get('status') === 'Definition' &&
        (url.searchParams.has('theorem_name') ? row.theorem_name === url.searchParams.get('theorem_name')
          : row.theorem_name.includes(url.searchParams.get('q'))));
      return response({ theorems: found, total: found.length });
    }
    const row = rows.find(row => url.pathname.endsWith('/' + row.theorem_id));
    assert.ok(row); details.push(row.theorem_id); return response(row);
  });
  const options = { cacheDir, sourceOnly: true };
  assert.deepEqual(await mirror(client, undefined, 'import Definitions.Def_Outer', target, options),
    ['Definitions.Def_Ns_Encoding', 'Definitions.Def_Outer']);
  assert.equal(searches.length, 3, 'exact searches plus dotted-name keyword fallback');
  assert.equal(searches[2].searchParams.get('q'), 'Encoding');
  searches.length = 0;
  await mirror(client, undefined, 'import Definitions.Def_Outer', target, options);
  assert.equal(searches.length, 0, 'resolved IDs are cached');
  assert.deepEqual(details, ['outer', 'encoding', 'outer', 'encoding'], 'cached IDs still fetch live source');
});

test('known dependency IDs skip search; missing IDs fall back to exact lookup', async t => {
  const dir = await temporary(t), cacheDir = join(dir, 'cache');
  await mkdir(join(dir, 'Definitions'));
  const row = { theorem_id: 'current', theorem_name: 'Count', status: 'Definition', mathlib_rev: rev, definition: 'def count : Nat := 3' };
  const calls = [];
  const client = {
    pages: async path => { calls.push('search'); assert.match(path, /theorem_name=Count/); return [row]; },
    request: async path => { calls.push(path); if (path.endsWith('/missing')) throw new ApiError(404, path); return row; },
  };
  await mirror(client, dir, 'import Definitions.Def_Count', target, {
    cacheDir, knownDependencies: [{ definition_id: 'current', definition_name: 'Count' }],
  });
  assert.deepEqual(calls, ['theorems/current']);
  calls.length = 0;
  await mirror(client, dir, 'import Definitions.Def_Count', target, {
    cacheDir, knownDependencies: [{ definition_id: 'missing', definition_name: 'Count' }],
  });
  assert.deepEqual(calls, ['theorems/missing', 'definitions/missing', 'search', 'theorems/current']);
});

test('fresh dependency checks preserve unchanged Lean files and update changed server source', async t => {
  const dir = await temporary(t), cacheDir = join(dir, 'cache');
  await mkdir(join(dir, 'Definitions'));
  const row = { theorem_id: 'def', theorem_name: 'Count', status: 'Definition', mathlib_rev: rev, definition: 'def count : Nat := 3' };
  let reads = 0;
  const client = { pages: async () => [row], request: async () => { reads++; return row; } };
  const file = join(dir, 'Definitions/Def_Count.lean');
  await mirror(client, dir, 'import Definitions.Def_Count', target, { cacheDir });
  const fixedTime = new Date('2020-01-01T00:00:00Z');
  await utimes(file, fixedTime, fixedTime);
  const before = (await stat(file)).mtimeMs;
  await mirror(client, dir, 'import Definitions.Def_Count', target, { cacheDir });
  assert.equal(reads, 2, 'the second mirror still checks live permissions and source');
  assert.equal((await stat(file)).mtimeMs, before, 'unchanged source keeps its incremental build');
  row.definition = 'def count : Nat := 4';
  await mirror(client, dir, 'import Definitions.Def_Count', target, { cacheDir });
  assert.equal(reads, 3);
  assert.equal(await readFile(file, 'utf8'), row.definition);
  assert.notEqual((await stat(file)).mtimeMs, before);
});

test('dotted theorem names and unavailable exact lookup use validated keyword fallback', async t => {
  const dir = await temporary(t);
  await mkdir(join(dir, 'Theorems'));
  const row = { theorem_id: 'helper', theorem_name: 'Ns.helper', status: 'Proved', mathlib_rev: rev, formal_statement: 'theorem Ns.helper : True := by sorry' };
  for (const failure of [null, 400, 500]) {
    const calls = [];
    const client = {
      pages: async path => {
        const url = new URL(path, 'https://prove2.me/api/v1/'); calls.push(url);
        if (url.searchParams.has('theorem_name')) {
          if (failure) throw new ApiError(failure, '/theorems');
          return [];
        }
        return [row, { ...row, theorem_id: 'other', theorem_name: 'Other.helper' }];
      }, request: async path => { assert.equal(path, 'theorems/helper'); return row; },
    };
    await mirror(client, dir, 'import Theorems.Thm_Ns_helper', target, { direct: true, cacheDir: join(dir, `cache-${failure}`) });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].searchParams.get('theorem_name'), 'Ns_helper');
    assert.equal(calls[0].searchParams.has('status'), false);
    assert.equal(calls[1].searchParams.get('q'), 'helper');
    assert.equal(calls[1].searchParams.has('status'), false);
  }
});

test('dependency cache never bypasses access checks and fallback never hides ambiguity', async t => {
  const dir = await temporary(t), cacheDir = join(dir, 'cache');
  await mkdir(join(dir, 'Definitions'));
  const row = { theorem_id: 'def', theorem_name: 'Count', status: 'Definition', mathlib_rev: rev, definition: 'def count : Nat := 3' };
  let searches = 0;
  const client = { pages: async () => { searches++; return [row]; }, request: async () => row };
  const source = 'import Definitions.Def_Count';
  await mirror(client, dir, source, target, { cacheDir });
  client.request = async () => { throw new ApiError(403, '/theorems/def'); };
  await assert.rejects(mirror(client, dir, source, target, { cacheDir }), error => error.status === 403 && /Def_Count/.test(error.message));
  assert.equal(searches, 1);
  client.request = async () => assert.fail('ambiguous matches must not be downloaded');
  client.pages = async () => [row, { ...row, theorem_id: 'other' }];
  await assert.rejects(mirror(client, dir, source, target, { cacheDir: join(dir, 'ambiguous') }), /Cannot uniquely resolve/);
});

test('poll returns accepted verdict or leaves a timed-out job pending', async () => {
  let n = 0;
  const client = { request: async () => ({ status: ++n === 1 ? 'PENDING' : 'ACCEPTED' }) };
  assert.equal((await poll(client, 'sub', 1, 1)).status, 'ACCEPTED');
  assert.equal((await poll({ request: async () => ({ status: 'PENDING' }) }, 'sub', 0)).status, 'PENDING');
});

async function harness(t) {
  const root = await temporary(t), workspace = join(root, 'workspace');
  await mkdir(join(workspace, 'Solutions'), { recursive: true });
  const options = { runs: join(root, 'runs'), workspaces: root, attempts: 2, pollTimeout: 1, lake: 'lake', verificationMode: 'local', pipeline: { attemptModels: [] } };
  let agents = 0, posts = 0, checks = 0;
  const uploads = [];
  const solution = join(workspace, 'Solutions/Sol_leaf_1.lean');
  const client = {
    request: async () => target,
    submit: async (id, source, explanation, proofType = 'prove') => {
      posts++; uploads.push({ id, source, explanation, proofType }); assert.equal(id, target.theorem_id);
      if (proofType === 'prove') { assert.match(source, /by rfl/); assert.equal(explanation, 'Reflexivity.'); }
      else { assert.equal(proofType, 'disprove'); assert.ok(explanation); }
      return { submission_id: 'sub-1' };
    },
  };
  const hooks = {
    preflight: async () => {},
    workspace: async () => workspace, mirror: async () => [],
    agent: async () => { agents++; await writeFile(solution, 'theorem solution (n : Nat) : n = n := by rfl'); return { ready: true, explanation: 'Reflexivity.', solution, module: 'Solutions.Sol_leaf_1' }; },
    command: async (_exe, args) => { checks++; assert.ok(args[0] === 'build' || args[0] === 'env'); },
    poll: async () => ({ status: 'ACCEPTED' }),
  };
  return { root, options, client, hooks, uploads, counts: () => ({ agents, posts, checks }), statePath: join(options.runs, target.theorem_id, 'state.json') };
}

const falseTarget = { ...target, formal_statement: 'theorem Ns.goal (n : Nat) : n = 0 := by sorry' };
const certificate = 'theorem solution : ¬ (∀ n : Nat, n = 0) := by intro h; cases h 1';
async function counterexampleHarness(t) {
  const h = await harness(t), generate = h.hooks.agent;
  h.client.request = async () => falseTarget;
  h.hooks.agent = async (...args) => {
    const result = await generate(...args);
    await writeFile(result.solution, certificate);
    return { ...result, kind: 'counterexample', ready: false, children: [], definitions: [], explanation: 'The witness is 1.' };
  };
  return h;
}

async function seedCounterexample(h) {
  const dir = dirname(h.statePath), solution = join(h.root, 'workspace/Solutions/Sol_leaf_1.lean');
  await mkdir(dir, { recursive: true });
  const snapshot = join(dir, 'counterexample-1.lean'), explanation = join(dir, 'counterexample-1.md');
  await writeFile(snapshot, certificate); await writeFile(explanation, 'The witness is 1.');
  const hash = text => createHash('sha256').update(text).digest('hex');
  await writeFile(h.statePath, JSON.stringify({ theorem_id: falseTarget.theorem_id, mathlib_rev: rev,
    status: 'COUNTEREXAMPLE', attempt_count: 1, submissions: [], feedback: 'The witness is 1.',
    counterexample: { attempt: 1, source_hash: hash(certificate), snapshot, explanation, solution, module: 'Solutions.Sol_leaf_1',
      target_hash: hash(JSON.stringify([falseTarget.theorem_name, falseTarget.formal_statement, falseTarget.preamble, rev], null, 2) + '\n') } }));
}

test('full workflow builds, compares type, submits exact bytes and saves verdict', async t => {
  const h = await harness(t);
  assert.equal(await solveLeaf(h.client, target, {}, environment, h.options, h.hooks), 'ACCEPTED');
  assert.deepEqual(h.counts(), { agents: 1, posts: 1, checks: 2 });
  const state = JSON.parse(await readFile(h.statePath, 'utf8'));
  assert.equal(state.status, 'ACCEPTED'); assert.equal(state.submission_id, 'sub-1');
  assert.deepEqual(state.attempts_by_model, { 'gpt-6-luna': 1 });
});

test('proof attempts are saved by model before invocation and remain selectable after restart', async t => {
  const h = await harness(t);
  h.options.attempts = 3; h.options.model = 'custom-model';
  const models = [];
  h.hooks.agent = async (_target, _workspace, _dir, attempt, _feedback, options) => {
    models.push(options.model);
    const saved = JSON.parse(await readFile(h.statePath, 'utf8'));
    assert.equal(saved.attempt_count, attempt);
    assert.equal(saved.attempts_by_model[options.model], models.filter(model => model === options.model).length);
    if (attempt === 1) throw new Error('model process crashed');
    return { ready: false, explanation: 'Unfinished proof.' };
  };
  assert.equal(await solveLeaf(h.client, target, {}, environment, h.options, h.hooks), 'READY');
  assert.deepEqual(models, ['custom-model', 'custom-model', 'custom-model']);
  const saved = JSON.parse(await readFile(h.statePath, 'utf8'));
  assert.equal(saved.attempt_count, 3);
  assert.deepEqual(saved.attempts_by_model, { 'custom-model': 3 });
  const { selectWork } = await import('../work-policy.mjs');
  const graph = { root: target, leaves: [target], states: { [target.theorem_id]: saved } };
  assert.equal(selectWork(graph).score, -33);
  assert.equal(selectWork(graph).totalAttempts, 3);

});

test('resumed server rejection yields a newly selected repair with preserved numbering', async t => {
  const h = await harness(t), generate = h.hooks.agent;
  h.hooks.poll = async () => ({ status: 'PENDING' });
  assert.equal(await solveLeaf(h.client, target, {}, environment, h.options, h.hooks), 'PENDING');
  let polls = 0;
  h.hooks.poll = async () => ++polls === 1 ? { status: 'REJECTED', error_message: 'server type mismatch' } : { status: 'ACCEPTED' };
  h.hooks.agent = async (...args) => {
    assert.match(args[4], /server type mismatch/);
    assert.equal(args[3], 2); assert.equal(args[5].model, 'gpt-6-luna');
    return generate(...args);
  };
  assert.equal(await solveLeaf(h.client, target, {}, environment, { ...h.options, attempts: 99, testRounds: 2, resumeOnly: true }, h.hooks), 'ACCEPTED');
  assert.equal(h.counts().posts, 2);
  const saved = JSON.parse(await readFile(h.statePath, 'utf8'));
  assert.equal(saved.attempt_count, 2); assert.equal(saved.attempt_budget, 2);
});

test('generated NULs are repaired locally before saving and submitting the explanation', async t => {
  const h = await harness(t), generate = h.hooks.agent;
  h.hooks.agent = async (...args) => ({ ...await generate(...args), explanation: 'Reflexivity.\0' });
  h.hooks.repairAnswer = async () => assert.fail('NUL cleanup should not require another agent');
  h.client.submit = async (_id, _source, explanation) => {
    assert.equal(explanation, 'Reflexivity. ');
    return { submission_id: 'sub-clean' };
  };
  assert.equal(await solveLeaf(h.client, target, {}, environment, h.options, h.hooks), 'ACCEPTED');
  assert.equal(await readFile(join(dirname(h.statePath), 'explanation-1.md'), 'utf8'), 'Reflexivity. ');
  assert.throws(() => gate('theorem solution : True := by\0 trivial', target), /NUL/);
});

test('formatting repair of a completed proof preserves its proof and never adds sorry', async t => {
  const h = await harness(t), generate = h.hooks.agent;
  let repairs = 0;
  h.hooks.agent = async (...args) => ({ ...await generate(...args), explanation: '' });
  h.hooks.repairAnswer = async (_target, _workspace, _dir, attempt, error, result) => {
    repairs++;
    assert.equal(attempt, 1); assert.match(error, /proof explanation/);
    const proof = await readFile(result.solution, 'utf8');
    assert.match(proof, /:= by rfl/); assert.ok(!proof.includes('sorry'));
    return { ...result, kind: 'proof', children: [], definitions: [], explanation: 'Reflexivity.' };
  };
  assert.equal(await solveLeaf(h.client, target, {}, environment, h.options, h.hooks), 'ACCEPTED');
  assert.deepEqual(h.counts(), { agents: 1, posts: 1, checks: 2 }); assert.equal(repairs, 1);
  assert.equal(JSON.parse(await readFile(h.statePath, 'utf8')).attempt_count, 1);
});

test('compile failure reaches Codex as feedback and prevents premature submission', async t => {
  const h = await harness(t); let n = 0;
  h.hooks.command = async (_exe, _args, { log }) => {
    if (++n === 1) { await writeFile(log, 'Lean: unsolved goals'); throw new Error('compile failed'); }
  };
  const generate = h.hooks.agent;
  h.hooks.agent = async (...args) => {
    assert.equal(args[5].model, 'gpt-6-luna');
    assert.equal(args[5].repairPrevious, false);
    if (args[3] === 2) assert.match(args[4], /unsolved goals/);
    return generate(...args);
  };
  assert.equal(await solveLeaf(h.client, target, {}, environment, h.options, h.hooks), 'ACCEPTED');
  assert.equal(h.counts().agents, 2); assert.equal(h.counts().posts, 1);
});

test('complete candidates with compiler failures yield after each selected round without uploading', async t => {
  const h = await harness(t), generate = h.hooks.agent, models = [];
  h.options.attempts = 3;
  h.hooks.command = async (_exe, _args, { log }) => {
    await writeFile(log, 'Lean: unsolved goals in complete candidate');
    throw new Error('runner compilation failed');
  };
  h.hooks.agent = async (...args) => {
    models.push(args[5].model);
    if (args[3] > 1) assert.match(args[4], /unsolved goals in complete candidate/);
    return generate(...args);
  };
  assert.equal(await solveLeaf(h.client, target, {}, environment, h.options, h.hooks), 'READY');
  assert.deepEqual(models, ['gpt-6-luna', 'gpt-6-luna', 'gpt-6-luna']);
  assert.equal(h.counts().agents, 3); assert.equal(h.counts().posts, 0);
  const saved = JSON.parse(await readFile(h.statePath, 'utf8'));
  assert.equal(saved.attempt_count, 3);
  assert.match(saved.feedback, /unsolved goals in complete candidate/);
});

test('rejected server verdict is repaired; accepted sketch is kept distinct', async t => {
  const h = await harness(t); let n = 0;
  h.hooks.poll = async () => ++n === 1 ? { status: 'WA', error_message: 'wrong target type' } : { status: 'SKETCH_ACCEPTED' };
  const generate = h.hooks.agent;
  h.hooks.agent = async (...args) => {
    assert.equal(args[5].model, 'gpt-6-luna');
    if (args[3] === 2) assert.match(args[4], /wrong target type/);
    return generate(...args);
  };
  assert.equal(await solveLeaf(h.client, target, {}, environment, h.options, h.hooks), 'SKETCH_ACCEPTED');
  assert.equal(h.counts().posts, 2);
});

test('pending state resumes polling without an agent or duplicate submission', async t => {
  const h = await harness(t);
  h.hooks.poll = async () => ({ status: 'PENDING' });
  assert.equal(await solveLeaf(h.client, target, {}, environment, h.options, h.hooks), 'PENDING');
  h.hooks.poll = async () => ({ status: 'ACCEPTED' });
  assert.equal(await solveLeaf(h.client, target, {}, environment, h.options, h.hooks), 'ACCEPTED');
  assert.deepEqual(h.counts(), { agents: 1, posts: 1, checks: 2 });
});

test('accepted state never starts another agent or duplicates a proof while the graph catches up', async t => {
  const h = await harness(t);
  assert.equal(await solveLeaf(h.client, target, {}, environment, h.options, h.hooks), 'ACCEPTED');
  assert.equal(await solveLeaf(h.client, target, {}, environment, h.options, h.hooks), 'ACCEPTED');
  assert.deepEqual(h.counts(), { agents: 1, posts: 1, checks: 2 });
});

test('ready jobs preserve feedback and continue with monotonic attempts on revisit', async t => {
  const h = await harness(t);
  h.options.attempts = 1;
  h.hooks.agent = async () => ({ ready: false, explanation: 'Need the induction step.' });
  assert.equal(await solveLeaf(h.client, target, {}, environment, h.options, h.hooks), 'READY');
  h.hooks.agent = async () => ({ ready: false, explanation: 'Need the induction step.' });
  assert.equal(await solveLeaf(h.client, target, {}, environment, { ...h.options, attempts: 99, testRounds: 2 }, h.hooks), 'READY');
  const saved = JSON.parse(await readFile(h.statePath, 'utf8'));
  assert.equal(saved.attempt_count, 3); assert.equal(saved.attempt_budget, 1);
  assert.equal(saved.feedback, 'Need the induction step.');
});

test('verified counterexamples upload exact saved bytes, retain evidence, and never repeat accepted disproofs', async t => {
  const h = await counterexampleHarness(t), mirrors = [], submit = h.client.submit;
  h.hooks.mirror = async (_client, _workspace, _source, _target, options) => { mirrors.push(options.direct); };
  h.client.submit = async (...args) => {
    const journal = JSON.parse(await readFile(h.statePath, 'utf8'));
    assert.equal(journal.status, 'SUBMITTING'); assert.equal(journal.proof_type, 'disprove');
    assert.equal(h.counts().checks, 2, 'compile and exact negation check precede upload');
    assert.equal(args[1], await readFile(journal.counterexample.snapshot, 'utf8'));
    return submit(...args);
  };
  assert.equal(await solveLeaf(h.client, falseTarget, {}, environment, h.options, h.hooks), 'DISPROVED');
  const state = JSON.parse(await readFile(h.statePath, 'utf8'));
  assert.equal(state.status, 'DISPROVED'); assert.equal(state.attempt_count, 1);
  assert.equal(state.verdict.status, 'ACCEPTED'); assert.equal(state.submission_id, 'sub-1');
  assert.equal(await readFile(state.counterexample.snapshot, 'utf8'), certificate);
  assert.equal(await readFile(state.counterexample.explanation, 'utf8'), 'The witness is 1.');
  assert.match(await readFile(join(dirname(h.statePath), 'CheckCounterexample.lean'), 'utf8'), /mkAppM ``Not/);
  await writeFile(state.counterexample.solution, 'stale workspace contents');
  assert.equal(await solveLeaf(h.client, falseTarget, {}, environment, h.options, h.hooks), 'DISPROVED');
  assert.deepEqual(h.counts(), { agents: 1, posts: 1, checks: 2 });
  assert.deepEqual(h.uploads, [{ id: target.theorem_id, source: certificate, explanation: 'The witness is 1.', proofType: 'disprove' }]);
  assert.deepEqual(mirrors, [undefined, true]);
});

test('legacy local counterexamples are independently rechecked and submitted without another agent', async t => {
  const h = await counterexampleHarness(t);
  await seedCounterexample(h);
  h.hooks.agent = async () => assert.fail('saved certificate recovery must not start an agent');
  assert.equal(await solveLeaf(h.client, falseTarget, {}, environment, { ...h.options, resumeOnly: true }, h.hooks), 'DISPROVED');
  assert.deepEqual(h.counts(), { agents: 0, posts: 1, checks: 2 });
  assert.equal(h.uploads[0].source, certificate);
});

test('counterexample recovery restores trusted snapshots into the new workspace without touching a legacy solution', async t => {
  const h = await counterexampleHarness(t);
  await seedCounterexample(h);
  const saved = JSON.parse(await readFile(h.statePath, 'utf8'));
  await writeFile(saved.counterexample.solution, 'legacy source must remain untouched');
  const isolated = join(h.root, 'isolated');
  await mkdir(join(isolated, 'Solutions'), { recursive: true });
  h.hooks.workspace = async () => isolated;
  h.hooks.agent = async () => assert.fail('recovery must not start a model');
  assert.equal(await solveLeaf(h.client, falseTarget, {}, environment, { ...h.options, resumeOnly: true }, h.hooks), 'DISPROVED');
  const recovered = JSON.parse(await readFile(h.statePath, 'utf8'));
  assert.equal(recovered.counterexample.solution, join(isolated, 'Solutions/Sol_leaf_1.lean'));
  assert.equal(await readFile(recovered.counterexample.solution, 'utf8'), certificate);
  assert.equal(await readFile(saved.counterexample.solution, 'utf8'), 'legacy source must remain untouched');
  assert.deepEqual(h.counts(), { agents: 0, posts: 1, checks: 2 });
});

test('pending disproofs resume polling without another upload, build, or agent', async t => {
  const h = await counterexampleHarness(t);
  h.hooks.poll = async () => ({ status: 'PENDING' });
  assert.equal(await solveLeaf(h.client, falseTarget, {}, environment, h.options, h.hooks), 'PENDING');
  assert.equal(JSON.parse(await readFile(h.statePath, 'utf8')).proof_type, 'disprove');
  h.hooks.poll = async () => ({ status: 'ACCEPTED' });
  assert.equal(await solveLeaf(h.client, falseTarget, {}, environment, { ...h.options, resumeOnly: true }, h.hooks), 'DISPROVED');
  assert.deepEqual(h.counts(), { agents: 1, posts: 1, checks: 2 });
});

for (const pending of [false, true]) test(`rejected ${pending ? 'resumed' : 'new'} disproofs receive repair feedback within their original budget`, async t => {
  const h = await counterexampleHarness(t), generate = h.hooks.agent;
  if (pending) {
    h.hooks.poll = async () => ({ status: 'PENDING' });
    assert.equal(await solveLeaf(h.client, falseTarget, {}, environment, h.options, h.hooks), 'PENDING');
  }
  let polls = 0;
  h.hooks.poll = async () => ++polls === 1 ? { status: 'WA', error_message: 'server type mismatch' } : { status: 'ACCEPTED' };
  h.hooks.agent = async (...args) => {
    if (args[3] === 2) assert.match(args[4], /server type mismatch/);
    return generate(...args);
  };
  assert.equal(await solveLeaf(h.client, falseTarget, {}, environment, { ...h.options, attempts: pending ? 99 : 2 }, h.hooks), 'DISPROVED');
  const saved = JSON.parse(await readFile(h.statePath, 'utf8'));
  assert.equal(saved.attempt_count, 2); assert.equal(saved.attempt_budget, 2);
  assert.equal(await solveLeaf(h.client, falseTarget, {}, environment, h.options, h.hooks), 'DISPROVED');
  assert.deepEqual(h.counts(), { agents: 2, posts: 2, checks: 4 });
});

test('lost disproof responses reject explicit mode mismatches and reconcile history without mode metadata', async t => {
  const h = await counterexampleHarness(t);
  let posts = 0;
  h.client.submit = async () => { posts++; throw new Error('connection lost after disproof POST'); };
  await assert.rejects(solveLeaf(h.client, falseTarget, {}, environment, h.options, h.hooks), /connection lost/);
  const state = JSON.parse(await readFile(h.statePath, 'utf8'));
  assert.equal(state.status, 'SUBMISSION_UNKNOWN'); assert.equal(state.proof_type, 'disprove');
  const inspected = [];
  h.client.request = async path => path.startsWith('submissions?page=') ? { total: 3, submissions: [
    { id: 'wrong-mode', theorem_id: target.theorem_id, proof_type: 'prove' },
    { id: 'older-proof', theorem_id: target.theorem_id },
    { id: 'recovered-disproof', theorem_id: target.theorem_id, proof_type: 'disprove' },
  ] } : path.endsWith('/solution') ? (inspected.push(path), { content: path === 'submissions/older-proof/solution' ? 'a different proof' : certificate }) : falseTarget;
  assert.equal(await solveLeaf(h.client, falseTarget, {}, environment, h.options, h.hooks), 'DISPROVED');
  assert.equal(posts, 1); assert.equal(h.counts().agents, 1);
  assert.deepEqual(inspected, ['submissions/older-proof/solution', 'submissions/recovered-disproof/solution']);
  assert.equal(JSON.parse(await readFile(h.statePath, 'utf8')).submission_id, 'recovered-disproof');
});

test('the live API history shape recovers a disproof by exact source bytes and its journaled mode', async t => {
  const h = await counterexampleHarness(t);
  let posts = 0;
  h.client.submit = async () => { posts++; throw new Error('connection lost after POST'); };
  await assert.rejects(solveLeaf(h.client, falseTarget, {}, environment, h.options, h.hooks), /connection lost/);
  h.client.request = async path => path.startsWith('submissions?page=')
    ? { total: 1, submissions: [{ id: 'recovered', theorem_id: target.theorem_id, status: 'ACCEPTED' }] }
    : path.endsWith('/solution') ? { content: certificate } : falseTarget;
  assert.equal(await solveLeaf(h.client, falseTarget, {}, environment, h.options, h.hooks), 'DISPROVED');
  assert.equal(posts, 1);
  const state = JSON.parse(await readFile(h.statePath, 'utf8'));
  assert.equal(state.submission_id, 'recovered'); assert.equal(state.proof_type, 'disprove');
});

test('missing disproof upload IDs remain uncertain and empty history never causes a resend', async t => {
  const h = await counterexampleHarness(t);
  let posts = 0;
  h.client.submit = async () => { posts++; return { status: 'PENDING' }; };
  await assert.rejects(solveLeaf(h.client, falseTarget, {}, environment, h.options, h.hooks), /response has no ID/);
  h.client.request = async () => ({ submissions: [], total: 0 });
  assert.equal(await solveLeaf(h.client, falseTarget, {}, environment, h.options, h.hooks), 'SUBMISSION_UNKNOWN');
  assert.equal(posts, 1); assert.equal(h.counts().agents, 1);
});

test('saved certificate upload and poll failures preserve recovery state instead of starting a proof', async t => {
  for (const stage of ['upload', 'poll']) await t.test(stage, async sub => {
    const h = await counterexampleHarness(sub);
    await seedCounterexample(h);
    h.hooks.agent = async () => assert.fail('no proof attempt during saved disproof recovery');
    if (stage === 'upload') h.client.submit = async () => { throw new Error('upload interrupted'); };
    else h.hooks.poll = async () => { throw new Error('poll interrupted'); };
    await assert.rejects(solveLeaf(h.client, falseTarget, {}, environment, h.options, h.hooks), /interrupted/);
    assert.equal(JSON.parse(await readFile(h.statePath, 'utf8')).status, stage === 'upload' ? 'SUBMISSION_UNKNOWN' : 'PENDING');
  });
});

test('HTTP-rejected disproof uploads retain their certificates and feed repairs', async t => {
  const h = await counterexampleHarness(t), submit = h.client.submit, generate = h.hooks.agent;
  let posts = 0;
  h.client.submit = async (...args) => { if (++posts === 1) throw new ApiError(400, '/verify'); return submit(...args); };
  h.hooks.agent = async (...args) => { if (args[3] === 2) assert.match(args[4], /400/); return generate(...args); };
  assert.equal(await solveLeaf(h.client, falseTarget, {}, environment, h.options, h.hooks), 'DISPROVED');
  assert.equal(posts, 2);
  assert.equal(await readFile(join(dirname(h.statePath), 'counterexample-1.lean'), 'utf8'), certificate);
  assert.equal(JSON.parse(await readFile(h.statePath, 'utf8')).attempt_count, 2);
});

test('disproofs with unsupported platform theorem imports are repaired before any upload', async t => {
  const h = await counterexampleHarness(t), generate = h.hooks.agent;
  h.hooks.agent = async (...args) => {
    const result = await generate(...args);
    if (args[3] === 1) await writeFile(result.solution, 'import Theorems.Thm_other\n' + certificate);
    else assert.match(args[4], /Disproof submissions cannot import platform theorem modules/);
    return result;
  };
  assert.equal(await solveLeaf(h.client, falseTarget, {}, environment, h.options, h.hooks), 'DISPROVED');
  assert.deepEqual(h.counts(), { agents: 2, posts: 1, checks: 2 });
});

test('an invalid counterexample receives repair feedback and never permanently blocks a leaf', async t => {
  const h = await harness(t), generate = h.hooks.agent;
  let calls = 0;
  h.hooks.agent = async (...args) => {
    const result = await generate(...args);
    if (++calls === 1) return { ...result, kind: 'counterexample', ready: false, children: [], definitions: [] };
    assert.match(args[4], /negation of target/);
    return result;
  };
  h.hooks.command = async (_exe, args, { log }) => {
    if (args[0] === 'env' && log.includes('counterexample-type')) {
      await writeFile(log, 'solution type does not match negation of target'); throw new Error('Lean check failed');
    }
  };
  assert.equal(await solveLeaf(h.client, target, {}, environment, h.options, h.hooks), 'ACCEPTED');
  assert.equal(calls, 2); assert.equal(h.counts().posts, 1);
  assert.equal(JSON.parse(await readFile(h.statePath, 'utf8')).counterexample, undefined);
});

for (const change of ['target', 'dependencies']) test(`legacy counterexamples yield for reassessment when ${change} change`, async t => {
  const h = await harness(t), generate = h.hooks.agent;
  await seedCounterexample(h);
  let current = falseTarget;
  if (change === 'target') {
    current = { ...target, preamble: '-- updated target' };
    h.client.request = async () => current;
  } else {
    h.client.request = async () => current;
    h.hooks.command = async (_exe, _args, { log }) => {
      if (log.includes('counterexample')) throw new Error('certificate invalid with updated dependencies');
    };
  }
  h.hooks.agent = async (...args) => {
    assert.match(args[4], change === 'target' ? /target or Lean environment changed/ : /Saved counterexample no longer verifies/);
    return generate(...args);
  };
  assert.equal(await solveLeaf(h.client, current, {}, environment, { ...h.options, testRounds: 1 }, h.hooks), 'READY');
  assert.equal(h.counts().agents, 0); assert.equal(h.counts().posts, 0);
  assert.equal(JSON.parse(await readFile(h.statePath, 'utf8')).attempt_count, 1);
});

test('legacy unresolved attempts retain a backup and resume without inventing historical outcomes', async t => {
  const h = await harness(t), dir = dirname(h.statePath);
  await mkdir(dir, { recursive: true });
  const legacy = { theorem_id: target.theorem_id, mathlib_rev: target.mathlib_rev, submissions: [],
    attempt_count: 2, feedback: 'Earlier counterexample.', status: 'UNRESOLVED' };
  await writeFile(h.statePath, JSON.stringify(legacy));
  await writeFile(join(dir, 'answer-2.json'), 'earlier answer');
  assert.equal(await solveLeaf(h.client, target, {}, environment, { ...h.options, attempts: 99, testRounds: 2 }, h.hooks), 'ACCEPTED');
  assert.deepEqual(JSON.parse(await readFile(h.statePath + '.legacy.json', 'utf8')), legacy);
  assert.equal(await readFile(join(dir, 'answer-2.json'), 'utf8'), 'earlier answer');
  const saved = JSON.parse(await readFile(h.statePath, 'utf8'));
  assert.equal(saved.attempt_count, 3); assert.equal(saved.attempt_budget, 0);
  assert.equal(saved.legacy_baseline.attempts, 2); assert.equal(saved.history.length, 2);
});

test('default Luna allows one stalled rescue while an explicit model override remains authoritative', async t => {
  for (const override of [undefined, 'custom-model']) {
    const h = await harness(t), models = [], repairs = [];
    h.options.attempts = 4;
    if (override) h.options.model = override;
    h.hooks.agent = async (...args) => {
      models.push(args[5].model);
      repairs.push(args[5].repairPrevious);
      return { ready: false, explanation: 'The unresolved coefficient identity requires finite expansion of ideal powers and homogeneous component products.' };
    };
    assert.equal(await solveLeaf(h.client, target, {}, environment, h.options, h.hooks), 'READY');
    assert.deepEqual(models, override ? Array(4).fill(override) : ['gpt-6-luna', 'gpt-6-luna', 'gpt-6.1-sol', 'gpt-6-luna']);
    assert.deepEqual(repairs, [false, false, false, false]);
    assert.equal(h.options.model, override, 'per-attempt selection does not mutate run options');
  }
});

test('deterministic declaration recovery changes only the exact target name outside comments and strings', () => {
  const prefix = '-- theorem Ns.goal in a comment\n/- nested /- theorem Ns.goal -/ comment -/\ndef note := "theorem Ns.goal"\n';
  const body = ' (n : Nat) : n = n := by rfl\n';
  assert.equal(normalizeSolutionDeclaration(prefix + 'theorem Ns.goal' + body, target), prefix + 'theorem solution' + body);
  for (const source of [
    'theorem other' + body,
    'namespace Ns\ntheorem goal' + body + 'end Ns',
    'private theorem Ns.goal' + body,
    'theorem Ns.goal' + body + 'theorem Ns.goal' + body,
    'theorem Ns.goal' + body + 'example (n : Nat) : n = n := Ns.goal n',
    'theorem solution' + body + 'theorem Ns.goal' + body,
  ]) assert.equal(normalizeSolutionDeclaration(source, target), source, 'ambiguous declarations stay untouched');
});

for (const scenario of ['hyphenated filename', 'mixed separators', 'unchanged canonical', 'rewritten alternate', 'canonical wins', 'stale alternate', 'stale mixed variant', 'ambiguous variants', 'unrelated file', 'target declaration', 'missing file', 'process failure']) {
  test(`agent normalizes solution artifacts before validation: ${scenario}`, async t => {
    const h = await harness(t), workspace = join(h.root, 'workspace'), dir = dirname(h.statePath);
    await mkdir(dir, { recursive: true });
    const invocationTarget = { ...target, theorem_id: 'leaf-1-2' };
    const canonical = join(workspace, 'Solutions/Sol_leaf_1_2.lean');
    const alternate = join(workspace, 'Solutions/Sol_leaf-1-2.lean');
    const proof = 'theorem solution (n : Nat) : n = n := by rfl';
    const missing = ['stale alternate', 'stale mixed variant', 'ambiguous variants', 'unrelated file', 'missing file'].includes(scenario);
    if (scenario === 'unchanged canonical') await writeFile(canonical, 'old incomplete proof');
    if (scenario === 'stale alternate') await writeFile(alternate, proof);
    if (scenario === 'stale mixed variant') await writeFile(join(workspace, 'Solutions/Sol_leaf_1-2.lean'), proof);
    if (scenario === 'rewritten alternate') await writeFile(alternate, '\uFEFF' + proof);
    const fake = join(h.root, 'fake-codex'), cliDir = join(fake, 'node_modules/@openai/codex/bin');
    await mkdir(cliDir, { recursive: true });
    const shim = join(fake, 'codex.cmd');
    await writeFile(shim, 'test shim');
    await writeFile(join(cliDir, 'codex.js'), `
      const { readFileSync, writeFileSync } = require('node:fs');
      const { join } = require('node:path');
      const args = process.argv.slice(2), scenario = ${JSON.stringify(scenario)};
      readFileSync(0, 'utf8');
      if (!['stale alternate', 'stale mixed variant', 'unrelated file', 'missing file'].includes(scenario)) {
        const filename = ['mixed separators', 'ambiguous variants'].includes(scenario) ? 'Solutions/Sol_leaf_1-2.lean' : 'Solutions/Sol_leaf-1-2.lean';
        const source = scenario === 'target declaration' ? ${JSON.stringify(proof.replace('theorem solution', 'theorem Ns.goal'))} : ${JSON.stringify(proof)};
        writeFileSync(join(process.cwd(), filename), '\\uFEFF' + source);
      }
      if (scenario === 'ambiguous variants') writeFileSync(join(process.cwd(), 'Solutions/Sol_leaf-1-2.lean'), ${JSON.stringify(proof + '\n-- different candidate')});
      if (scenario === 'unrelated file') writeFileSync(join(process.cwd(), 'Solutions/Sol_other.lean'), ${JSON.stringify(proof)});
      if (scenario === 'canonical wins') writeFileSync(join(process.cwd(), 'Solutions/Sol_leaf_1_2.lean'), ${JSON.stringify(proof + '\n-- canonical')});
      if (scenario === 'process failure') process.exit(7);
      writeFileSync(args[args.indexOf('--output-last-message') + 1], JSON.stringify({ ready: true, explanation: 'Reflexivity.' }));
    `);
    const invoke = () => agent(invocationTarget, workspace, dir, 1, '', { ...h.options, codex: shim, agentTimeout: 10 });
    if (missing) {
      await assert.rejects(invoke, /without writing the assigned solution file/);
      await assert.rejects(readFile(canonical), { code: 'ENOENT' });
      await assert.rejects(readFile(join(dir, 'solution-1.lean')), { code: 'ENOENT' });
      return;
    }
    if (scenario === 'process failure') await assert.rejects(invoke, /exited with 7/);
    else {
      const result = await invoke();
      assert.equal(result.solution, canonical);
      assert.equal(result.module, 'Solutions.Sol_leaf_1_2');
    }
    const expected = scenario === 'canonical wins' ? proof + '\n-- canonical' : proof;
    assert.equal(await readFile(canonical, 'utf8'), expected);
    assert.equal(await readFile(join(dir, 'solution-1.lean'), 'utf8'), expected);
    if (scenario === 'target declaration') assert.equal(await readFile(join(dir, 'solution-1-original.lean'), 'utf8'), proof.replace('theorem solution', 'theorem Ns.goal'));
  });
}

for (const failure of ['incomplete proof', 'process failure', 'invalid JSON', 'repair failure']) {
  test(`real agent invocation follows configured profiles with incomplete escalation for ${failure}`, async t => {
    const h = await harness(t), fake = join(h.root, 'fake-codex');
    h.options.attempts = 3;
    h.options.pipeline = { attemptModels: ['luna-6-high', 'luna-6-high', 'sol-6.1-medium'] };
    const cliDir = join(fake, 'node_modules/@openai/codex/bin');
    await mkdir(cliDir, { recursive: true });
    const shim = join(fake, 'codex.cmd');
    await writeFile(shim, 'test shim; executable() launches the adjacent JS through Node');
    await writeFile(join(cliDir, 'codex.js'), `
      const assert = require('node:assert/strict');
      const { readFileSync, writeFileSync } = require('node:fs');
      const { join, dirname } = require('node:path');
      const args = process.argv.slice(2);
      const answer = args[args.indexOf('--output-last-message') + 1];
      const dir = dirname(answer), attempt = Number(answer.match(/answer-(\\d+)\\.json$/)[1]);
      const prompt = readFileSync(0, 'utf8');
      const solution = join(process.cwd(), 'Solutions/Sol_leaf_1.lean');
      assert.equal(args[args.indexOf('--model') + 1], attempt <= 2 ? 'gpt-6-luna' : 'gpt-6.1-sol');
      assert.equal(args[args.indexOf('--config') + 1], attempt <= 2 ? 'model_reasoning_effort="high"' : 'model_reasoning_effort="medium"');
      writeFileSync(join(dir, 'args-' + attempt + '.json'), JSON.stringify(args));
      if (attempt === 1) {
        writeFileSync(solution, 'theorem solution (n : Nat) : n = n := by sorry');
        console.log('Luna explored induction but did not complete it.');
        if (${JSON.stringify(failure)} === 'process failure') process.exit(7);
        writeFileSync(answer, ${JSON.stringify(failure)} === 'invalid JSON' ? '{invalid' : JSON.stringify({ ready: false, explanation: 'Need the induction step.' }));
      } else {
        const snapshot = join(dir, 'solution-' + (attempt - 1) + '.lean'), log = join(dir, 'codex-' + (attempt - 1) + '.log');
        assert.ok(prompt.includes(snapshot)); assert.ok(!prompt.includes(log));
        const packet = JSON.parse(readFileSync(join(dir, 'worker-context-' + attempt + '.json'), 'utf8'));
        const contextText = JSON.stringify(packet);
        if (attempt === 2) {
          assert.ok(prompt.includes(join(dir, 'answer-1.json')));
          assert.ok(!prompt.includes(join(dir, 'lean-1.log')));
          assert.ok(!prompt.includes(join(dir, 'type-1.log')));
          assert.match(prompt, /compact worker context/);
          assert.match(prompt, /preamble fields contain only Lean/);
        }
        assert.match(readFileSync(snapshot, 'utf8'), /by sorry/);
        assert.match(readFileSync(log, 'utf8'), attempt === 2 ? /Luna explored induction/ : /Luna repair needs/);
        assert.match(contextText, ${failure === 'process failure' ? '/exited with 7/' : failure === 'invalid JSON' ? '/Invalid Codex answer JSON/' : '/Need the induction step/'});
        if (attempt === 2 && ${JSON.stringify(failure)} === 'repair failure') {
          console.log('Luna repair needs the induction step.');
          writeFileSync(answer, JSON.stringify({ ready: false, explanation: 'Need the induction step after repair.' }));
          return;
        }
        if (attempt === 3) {
          assert.ok(!prompt.includes(join(dir, 'codex-2.log')));
          assert.match(readFileSync(join(dir, 'codex-2.log'), 'utf8'), /Luna repair needs/);
        }
        writeFileSync(solution, 'theorem solution (n : Nat) : n = n := by rfl');
        writeFileSync(answer, JSON.stringify({ ready: true, explanation: 'Reflexivity.' }));
      }
    `);
    h.options.codex = shim; h.options.agentTimeout = 10;
    h.hooks.agent = agent;
    assert.equal(await solveLeaf(h.client, target, {}, environment, h.options, h.hooks), 'ACCEPTED');
    const dir = join(h.options.runs, target.theorem_id);
    assert.match(await readFile(join(dir, 'solution-1.lean'), 'utf8'), /by sorry/);
    const finalAttempt = failure === 'repair failure' ? 3 : 2;
    assert.match(await readFile(join(dir, `solution-${finalAttempt}.lean`), 'utf8'), /by rfl/);
    for (let attempt = 1; attempt <= finalAttempt; attempt++) {
      const args = JSON.parse(await readFile(join(dir, `args-${attempt}.json`), 'utf8'));
      assert.equal(args[args.indexOf('--model') + 1], attempt <= 2 ? 'gpt-6-luna' : 'gpt-6.1-sol');
      assert.ok(args.some(value => value.startsWith('sandbox_workspace_write.writable_roots=') && value.includes('leaf-1')));
      if (process.platform === 'win32') assert.ok(args.includes('windows.sandbox=mxc'));
    }
    assert.equal(h.counts().posts, 1);
  });
}

async function schedulerHarness(t, { milestoneScope = false } = {}) {
  const runs = await temporary(t), events = [], delays = [];
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', () => {});
  const scope = { kind: milestoneScope ? 'milestone' : 'mission', name: 'Target', root: 'root', id: 'scope', mission };
  if (milestoneScope) scope.milestone = milestone;
  const root = { ...target, theorem_id: 'root', theorem_name: 'Root' };
  const client = {
    request: async path => {
      events.push(path);
      if (path === 'environments') return { environments: [environment] };
      if (path.endsWith('/decompositions')) return { decompositions: [] };
      return { ...target, theorem_id: path.split('/').at(-1) };
    },
    pages: async path => { events.push(path); return []; },
  };
  const options = { runs, attempts: 1, refreshInterval: 2, graphRefreshInterval: 2 };
  let clock = Date.now();
  const hooks = { now: () => clock, wait: async delay => { delays.push(delay); clock += delay; } };
  const leaf = (id, closability = 0) => ({ theorem_id: id, theorem_name: id, status: 'Open', closability });
  return { runs, events, delays, scope, root, client, options, hooks, leaf };
}

test('scheduler rebuilds the actual graph, reranks work, and discovers new leaves until the selected root is proved', async t => {
  const h = await schedulerHarness(t), solved = [], proved = new Set();
  const a = h.leaf('a'), b = h.leaf('b'), c = h.leaf('c');
  h.client.request = async path => {
    h.events.push(path);
    if (path === 'environments') return { environments: [environment] };
    if (path === 'theorems/root') return { ...h.root, status: proved.has('c') ? 'Proved' : 'Open' };
    if (path.endsWith('/decompositions')) {
      if (path !== 'theorems/root/decompositions') return { decompositions: [] };
      const children = proved.has('a') ? [b, c] : [a, b];
      return { decompositions: [{ submission_id: 'reduction', children: children.map(row => ({ ...row, status: proved.has(row.theorem_id) ? 'Proved' : 'Open' })) }] };
    }
    return { ...target, theorem_id: path.split('/').at(-1) };
  };
  h.hooks.solveLeaf = async (_client, theorem) => {
    solved.push(theorem.theorem_id); proved.add(theorem.theorem_id); return 'ACCEPTED';
  };
  const summary = await runTarget(h.client, h.scope, h.options, h.hooks);
  assert.deepEqual(solved, ['a', 'b', 'c']);
  assert.equal(summary.completed, true); assert.equal(summary.root_status, 'Proved');
  assert.equal(h.events.filter(path => path === 'theorems/root').length, 4);
  assert.equal(JSON.parse(await readFile(join(h.runs, 'last-run.json'), 'utf8')).status, 'COMPLETE');
});

test('scheduler reselects unsuccessful leaves, resumes verdicts, and refreshes milestone context', async t => {
  const h = await schedulerHarness(t, { milestoneScope: true }), solved = [], calls = new Map();
  const leaves = [h.leaf('difficult', 10), h.leaf('pending', 5), h.leaf('easy')];
  h.hooks.frontier = async (_client, rootId) => {
    assert.equal(rootId, h.scope.root);
    return { root: { ...h.root, status: h.delays.length === 2 ? 'Proved' : 'Open' }, leaves };
  };
  h.hooks.solveLeaf = async (_client, theorem, context) => {
    const id = theorem.theorem_id, visit = (calls.get(id) ?? 0) + 1;
    calls.set(id, visit); solved.push(id);
    assert.equal(context.scope.kind, 'milestone');
    return visit === 1 && id !== 'easy' ? id === 'pending' ? 'PENDING' : 'READY' : 'ACCEPTED';
  };
  const summary = await runTarget(h.client, h.scope, h.options, h.hooks);
  assert.equal(summary.completed, true); assert.equal(summary.status, 'COMPLETE');
  assert.deepEqual(solved, ['difficult', 'difficult', 'pending', 'easy', 'pending']);
  assert.deepEqual(h.delays, [2000, 2000]);
  assert.equal(h.events.filter(path => path === 'milestones/scope/history').length, 5);
});

test('scheduler waits for authoritative root completion without resubmitting accepted leaves', async t => {
  const h = await schedulerHarness(t); let refreshes = 0, attempts = 0;
  h.hooks.frontier = async () => ({ root: { ...h.root, status: ++refreshes === 4 ? 'Proved' : 'Open' }, leaves: [h.leaf('a')] });
  h.hooks.solveLeaf = async () => { attempts++; return 'ACCEPTED'; };
  const summary = await runTarget(h.client, h.scope, h.options, h.hooks);
  assert.equal(summary.completed, true); assert.equal(attempts, 1);
  assert.deepEqual(h.delays, [2000, 2000]);
});

test('scheduler continues other leaves after an accepted disproof and waits for new work when blocked', async t => {
  const h = await schedulerHarness(t), solved = [];
  h.hooks.frontier = async () => ({ root: { ...h.root, status: solved.includes('new') ? 'Proved' : 'Open' },
    leaves: h.delays.length ? [h.leaf('new')] : [h.leaf('false', 10), h.leaf('true')] });
  h.hooks.wait = async delay => {
    h.delays.push(delay);
    const saved = JSON.parse(await readFile(join(h.runs, 'last-run.json'), 'utf8'));
    assert.equal(saved.status, 'RUNNING'); assert.match(saved.waiting_reason, /pending work|propagation/);
  };
  h.hooks.solveLeaf = async (_client, theorem) => {
    solved.push(theorem.theorem_id); return theorem.theorem_id === 'false' ? 'DISPROVED' : 'ACCEPTED';
  };
  const summary = await runTarget(h.client, h.scope, h.options, h.hooks);
  assert.deepEqual(solved, ['false', 'true', 'new']); assert.deepEqual(h.delays, [2000]);
  assert.equal(summary.status, 'COMPLETE'); assert.equal(summary.completed, true);
  assert.equal(summary.root_status, 'Proved');
  assert.deepEqual(summary.results.map(row => row.status), ['DISPROVED', 'ACCEPTED', 'ACCEPTED']);
});

test('a server-disproved root stops without reporting proof completion or starting a solver', async t => {
  const h = await schedulerHarness(t);
  h.hooks.frontier = async () => ({ root: { ...h.root, status: 'Disproved' }, leaves: [] });
  h.hooks.solveLeaf = async () => assert.fail('a disproved root must not start another solver');
  h.hooks.wait = async () => assert.fail('a disproved root must not wait for another refresh');
  const summary = await runTarget(h.client, h.scope, h.options, h.hooks);
  assert.equal(summary.status, 'DISPROVED'); assert.equal(summary.completed, false);
  assert.equal(summary.root_status, 'Disproved'); assert.equal(summary.visits, 0);
  assert.ok(summary.finished_at);
  assert.equal(JSON.parse(await readFile(join(h.runs, 'last-run.json'), 'utf8')).status, 'DISPROVED');
});

test('scheduler refreshes ranking after each visit and revisits failed leaves', async t => {
  const h = await schedulerHarness(t), solved = []; let refreshes = 0;
  h.hooks.frontier = async () => ({ root: { ...h.root, status: solved.length === 4 ? 'Proved' : 'Open' },
    leaves: h.delays.length ? [h.leaf('d')] : ++refreshes === 1 ? [h.leaf('a'), h.leaf('b'), h.leaf('c')] : [h.leaf('c', 10), h.leaf('b'), h.leaf('a')] });
  h.hooks.solveLeaf = async (_client, theorem) => {
    solved.push(theorem.theorem_id);
    if (solved.length === 1) throw new Error('worker crashed');
    return 'ACCEPTED';
  };
  const summary = await runTarget(h.client, h.scope, h.options, h.hooks);
  assert.deepEqual(solved, ['a', 'c', 'b', 'a']);
  assert.equal(summary.completed, true); assert.equal(summary.status, 'COMPLETE');
  assert.deepEqual(summary.results.map(row => row.status), ['ACCEPTED', 'ACCEPTED', 'ACCEPTED']);
  assert.deepEqual(h.delays, []);
});

test('scheduler retries exhausted transient graph reads and inconsistent snapshots', async t => {
  const h = await schedulerHarness(t); let refreshes = 0;
  h.hooks.frontier = async () => {
    if (++refreshes === 1) throw new ApiError(503, '/theorems/root');
    if (refreshes === 2) throw new Error('Theorem changed during frontier discovery; rerun');
    if (refreshes <= 6) throw new ApiError(404, '/theorems/root/decompositions');
    return { root: { ...h.root, status: 'Proved' }, leaves: [] };
  };
  assert.equal((await runTarget(h.client, h.scope, h.options, h.hooks)).completed, true);
  assert.deepEqual(h.delays, [2000, 2000, 2000, 2000, 2000, 2000]);
});

test('a final graph refresh confirms completion after accepted work', async t => {
    const h = await schedulerHarness(t); let refreshes = 0;
    h.hooks.frontier = async () => ({ root: { ...h.root, status: ++refreshes > 1 ? 'Proved' : 'Open' }, leaves: [h.leaf('a')] });
    h.hooks.solveLeaf = async () => 'ACCEPTED';
    const summary = await runTarget(h.client, h.scope, h.options, h.hooks);
    assert.equal(summary.completed, true);
    assert.equal(summary.status, 'COMPLETE');
    assert.equal(summary.visits, 1); assert.equal(refreshes, 2);
});

test('empty, dead, deprecated, and malformed frontiers never silently mark an open target complete', async t => {
  const h = await schedulerHarness(t); let refreshes = 0;
  h.hooks.frontier = async () => ({ root: { ...h.root, status: ++refreshes === 2 ? 'Proved' : 'Open' }, leaves: [] });
  assert.equal((await runTarget(h.client, h.scope, h.options, h.hooks)).completed, true);
  assert.deepEqual(h.delays, [2000]);
  for (const root of [{ ...h.root, status: 'Dead' }, { ...h.root, status: 'Proved', deprecated_at: 'today' }]) {
    h.hooks.frontier = async () => ({ root, leaves: [] });
    await assert.rejects(runTarget(h.client, h.scope, h.options, h.hooks), /not proved/);
    const saved = JSON.parse(await readFile(join(h.runs, 'last-run.json'), 'utf8'));
    assert.equal(saved.status, 'ERROR'); assert.equal(saved.completed, false);
  }
  h.hooks.frontier = async () => { throw new Error('Invalid frontier decompositions'); };
  await assert.rejects(runTarget(h.client, h.scope, h.options, h.hooks), /Invalid frontier/);
});

test('proof CLI reports root completion and releases its runner lock', async t => {
  for (const useConfig of [false, true]) await t.test(useConfig ? 'explicit overrides' : 'project defaults', async sub => {
    const complete = true;
    const dir = await temporary(sub), runner = join(dir, 'prove2me.mjs');
    for (const file of ['prove2me.mjs', 'credentials-store.mjs', 'codex-sandbox-recovery.mjs', 'theorem-library.mjs', 'theorem-library-mcp.mjs', 'work-selection.mjs', 'graph-updates.mjs', 'api-errors.mjs', 'api-recovery.mjs', 'recovery-policy.mjs', 'proof-storage-recovery.mjs', 'agent-prompts.mjs', 'agent-control.mjs', 'job-stages.mjs', 'remote-actions.mjs', 'runner-state.mjs', 'lean-artifacts.mjs', 'shared-resources.mjs', 'compiled-dependencies.mjs', 'isolated-workspaces.mjs', 'workspace-updates.mjs', 'serial-jobs.mjs', 'codex-quota.mjs', 'pipeline.mjs', 'pipeline-config.mjs', 'runtime-settings.mjs', 'runner-config-store.mjs', 'mission-control-commands.mjs', 'job-store.mjs', 'attempt-history.mjs', 'work-policy.mjs', 'graph-cycles.mjs', 'mission-research.mjs', 'research-resources.mjs', 'publication-store.mjs', 'verification-mode.mjs', 'model-policy.mjs', 'worker-context.mjs', 'prompt-experiment.mjs', 'runner-config.json']) {
      await writeFile(join(dir, file), await readFile(new URL(`../${file}`, import.meta.url), 'utf8'));
    }
    const { pathToFileURL } = await import('node:url');
    const defaultsPath = join(dir, 'runner-config.json');
    const defaults = JSON.parse(await readFile(defaultsPath, 'utf8'));
    Object.assign(defaults, { verificationMode: 'server-only', maxActiveJobs: 5, maxRemoteJobs: 9, apiConcurrency: 3 });
    await writeFile(defaultsPath, JSON.stringify(defaults));
    const config = join(dir, 'pipeline.json');
    await writeFile(config, JSON.stringify({ maxActiveJobs: 2, apiConcurrency: 2, queues: { codex: { concurrency: 1 } } }));
    const script = `
      import { main } from ${JSON.stringify(pathToFileURL(runner).href)};
      import { readFile, access } from 'node:fs/promises';
      let rootReads = 0;
      globalThis.fetch = async url => {
        let body;
        if (url.pathname.endsWith('/agent/refresh')) body = { access_token: 'test-token', expires_at: Date.now() / 1000 + 3600 };
        else if (url.pathname.endsWith('/missions')) body = { missions: [{ id: 'mission', name: 'Target', main_theorem: { theorem_id: 'root' } }], total: 1 };
        else if (url.pathname.endsWith('/decompositions')) body = { decompositions: url.pathname.endsWith('/root/decompositions') ? [{ submission_id: 'reduction', children: [{ theorem_id: 'leaf', theorem_name: 'Leaf', status: 'Open' }] }] : [] };
        else if (url.pathname.endsWith('/theorems/root')) body = { theorem_id: 'root', theorem_name: 'Root', status: ++rootReads > 1 && ${complete} ? 'Proved' : 'Open' };
        else if (url.pathname.endsWith('/theorems/leaf')) body = { theorem_id: 'leaf', theorem_name: 'Leaf', status: 'Proved' };
        else throw new Error('Unexpected request: ' + url.pathname);
        return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
      };
      console.log = () => {}; console.table = () => {};
      await main(['--mission', 'Target', ...${JSON.stringify(useConfig ? ['--config', config, '--verification-mode', 'local', '--max-remote-jobs', '12'] : [])}, '--codex-concurrency', '3', '--codex', process.execPath, '--lake', ${useConfig ? 'process.execPath' : JSON.stringify(join(dir, 'no-lake-installed'))}]);
      const exitCode = process.exitCode ?? 0; process.exitCode = 0;
      const summary = JSON.parse(await readFile(${JSON.stringify(join(dir, '.runs/last-run.json'))}, 'utf8'));
      let locked = true;
      try { await access(${JSON.stringify(join(dir, '.runs/runner.lock'))}); } catch (error) { if (error.code === 'ENOENT') locked = false; else throw error; }
      process.stdout.write(JSON.stringify({ exitCode, summary, locked, rootReads }));
    `;
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], {
      cwd: tmpdir(), env: { ...childEnv(), PROVE2ME_API_KEY: 'test-key' }, timeout: 10000,
    });
    const output = JSON.parse(stdout);
    assert.equal(output.exitCode, complete ? 0 : 1);
    assert.equal(output.summary.completed, complete);
    assert.equal(output.summary.status, 'COMPLETE');
    assert.equal(output.locked, false); assert.equal(output.rootReads, 2);
    assert.equal(output.summary.limits.queues.CODEX.concurrency, 3);
    assert.equal(output.summary.limits.maxActiveJobs, useConfig ? 2 : 5);
    assert.equal(output.summary.limits.apiConcurrency, useConfig ? 2 : 3);
    assert.equal(output.summary.limits.verificationMode, useConfig ? 'local' : 'server-only');
    assert.equal(output.summary.limits.maxRemoteJobs, useConfig ? 12 : 9);
  });
});

test('unknown POST is recorded and recovered from own history without resending', async t => {
  const h = await harness(t);
  h.client.submit = async () => { throw new Error('connection lost after POST'); };
  await assert.rejects(solveLeaf(h.client, target, {}, environment, h.options, h.hooks), /connection lost/);
  const unknown = JSON.parse(await readFile(h.statePath, 'utf8'));
  assert.equal(unknown.status, 'SUBMISSION_UNKNOWN');
  assert.equal(unknown.submission_error.message, 'connection lost after POST');
  assert.ok(unknown.submission_started_at);
  h.client.request = async path => path.startsWith('submissions?page=') ? { submissions: [{ id: 'sub-recovered', theorem_id: target.theorem_id }], total: 1 } :
    path.endsWith('/solution') ? { content: 'theorem solution (n : Nat) : n = n := by rfl' } : target;
  assert.equal(await solveLeaf(h.client, target, {}, environment, h.options, h.hooks), 'ACCEPTED');
  assert.equal(h.counts().agents, 1);
  assert.equal(JSON.parse(await readFile(h.statePath, 'utf8')).submission_id, 'sub-recovered');
  assert.deepEqual(JSON.parse(await readFile(h.statePath, 'utf8')).submissions, ['sub-recovered']);
});

test('missing submission ID is journaled and an empty history never triggers a resend', async t => {
  const h = await harness(t);
  let posts = 0;
  h.client.submit = async () => { posts++; return { status: 'PENDING' }; };
  await assert.rejects(solveLeaf(h.client, target, {}, environment, h.options, h.hooks), /response has no ID/);
  const saved = JSON.parse(await readFile(h.statePath, 'utf8'));
  assert.equal(saved.status, 'SUBMISSION_UNKNOWN');
  assert.match(saved.submission_error.message, /response has no ID/);
  h.client.request = async () => ({ submissions: [], total: 0 });
  assert.equal(await solveLeaf(h.client, target, {}, environment, h.options, h.hooks), 'SUBMISSION_UNKNOWN');
  assert.equal(posts, 1);
  assert.equal(h.counts().agents, 1);
});

test('saved upload diagnostics redact API credentials', async t => {
  const h = await harness(t);
  h.client.key = 'private-key'; h.client.token = 'private-token';
  h.client.submit = async () => { throw new Error('connection lost with private-key and private-token'); };
  await assert.rejects(solveLeaf(h.client, target, {}, environment, h.options, h.hooks));
  const saved = await readFile(h.statePath, 'utf8');
  assert.doesNotMatch(saved, /private-key|private-token/);
  assert.match(saved, /\[redacted\]/);
});

test('missing proof never gets submitted; API rejection does not trigger another POST', async t => {
  const h = await harness(t);
  h.hooks.agent = async () => ({ ready: false, explanation: 'Still proving the analytic estimate.' });
  assert.equal(await solveLeaf(h.client, target, {}, environment, h.options, h.hooks), 'READY');
  assert.equal(h.counts().posts, 0);
  const h2 = await harness(t);
  let posts = 0; h2.client.submit = async () => { posts++; throw new ApiError(429, '/verify'); };
  assert.equal(await solveLeaf(h2.client, target, {}, environment, h2.options, h2.hooks), 'API_WAIT');
  assert.equal(posts, 1);
});

test('prove2.me credentials are stripped from child environments', () => {
  process.env.PROVE2ME_TEST_SECRET = 'secret';
  try { assert.equal(childEnv().PROVE2ME_TEST_SECRET, undefined); }
  finally { delete process.env.PROVE2ME_TEST_SECRET; }
});

test('process runner passes Unicode stdin without a shell and records output', async t => {
  const dir = await temporary(t), log = join(dir, 'process.log');
  await command(process.execPath, ['-e', 'process.stdin.setEncoding("utf8"); process.stdin.on("data", s => process.stdout.write(s));'], { cwd: dir, log, input: 'π has exponent 2\n', quiet: true, timeout: 5000 });
  assert.equal(await readFile(log, 'utf8'), 'π has exponent 2\n');
  await assert.rejects(command(process.execPath, ['-e', 'process.exit(7)'], { cwd: dir, log, quiet: true, timeout: 5000 }), /exited with 7/);
});

test('local Codex launches without PATH from another directory and preserves explicit overrides', async t => {
  const dir = await temporary(t), log = join(dir, 'codex.log');
  const runner = new URL('../prove2me.mjs', import.meta.url);
  const cli = fileURLToPath(new URL('../node_modules/@openai/codex/bin/codex.js', import.meta.url));
  const script = `
    import assert from 'node:assert/strict';
    import { executable, command } from ${JSON.stringify(runner.href)};
    assert.deepEqual(await executable('codex'), [process.execPath, ${JSON.stringify(cli)}]);
    assert.deepEqual(await executable(process.execPath), [process.execPath]);
    await assert.rejects(executable('./missing-codex'), /Cannot find/);
    await command('codex', ['--version'], {
      cwd: ${JSON.stringify(dir)}, log: ${JSON.stringify(log)}, quiet: true, timeout: 10000
    });
  `;
  await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], {
    cwd: dir, env: { ...childEnv(), PATH: '' }, timeout: 15000
  });
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const version = (await readFile(log, 'utf8')).match(/codex-cli (\d+\.\d+\.\d+)/)?.[1];
  assert.equal(version, manifest.dependencies['@openai/codex'], 'runner launches the exact project package version');
});

test('Windows local npm Codex shim launches through Node', { skip: process.platform !== 'win32' }, async () => {
  const { executable } = await import('../prove2me.mjs');
  const shim = fileURLToPath(new URL('../node_modules/.bin/codex.cmd', import.meta.url));
  const cli = fileURLToPath(new URL('../node_modules/@openai/codex/bin/codex.js', import.meta.url));
  assert.deepEqual(await executable(shim), [process.execPath, cli]);
});

test('missing project Codex never falls back to an executable on PATH', async t => {
  const dir = await temporary(t), fakeBin = join(dir, 'bin');
  await mkdir(fakeBin);
  const fakeCodex = join(fakeBin, process.platform === 'win32' ? 'codex.exe' : 'codex');
  await writeFile(fakeCodex, 'unrelated global CLI');
  const runner = join(dir, 'prove2me.mjs');
  for (const file of ['prove2me.mjs', 'credentials-store.mjs', 'codex-sandbox-recovery.mjs', 'theorem-library.mjs', 'theorem-library-mcp.mjs', 'work-selection.mjs', 'graph-updates.mjs', 'api-errors.mjs', 'api-recovery.mjs', 'recovery-policy.mjs', 'proof-storage-recovery.mjs', 'agent-prompts.mjs', 'agent-control.mjs', 'job-stages.mjs', 'remote-actions.mjs', 'runner-state.mjs', 'lean-artifacts.mjs', 'shared-resources.mjs', 'compiled-dependencies.mjs', 'isolated-workspaces.mjs', 'workspace-updates.mjs', 'serial-jobs.mjs', 'codex-quota.mjs', 'pipeline.mjs', 'pipeline-config.mjs', 'runtime-settings.mjs', 'runner-config-store.mjs', 'mission-control-commands.mjs', 'job-store.mjs', 'attempt-history.mjs', 'work-policy.mjs', 'graph-cycles.mjs', 'mission-research.mjs', 'research-resources.mjs', 'publication-store.mjs', 'verification-mode.mjs', 'model-policy.mjs', 'worker-context.mjs', 'prompt-experiment.mjs', 'runner-config.json']) {
    await writeFile(join(dir, file), await readFile(new URL(`../${file}`, import.meta.url), 'utf8'));
  }
  const { pathToFileURL } = await import('node:url');
  const script = `
    import assert from 'node:assert/strict';
    import { executable } from ${JSON.stringify(pathToFileURL(runner).href)};
    await assert.rejects(executable('codex'), /Project Codex dependency is missing/);
    assert.deepEqual(await executable(${JSON.stringify(fakeCodex)}), [${JSON.stringify(fakeCodex)}]);
  `;
  await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], {
    cwd: dir, env: { ...childEnv(), PATH: fakeBin }, timeout: 10000,
  });
});

test('real Lean accepts the exact goal and rejects a compiling proof of another type', { skip: !process.env.LEAN_TEST_BINARY }, async t => {
  const dir = await temporary(t), path = join(dir, 'Check.lean');
  const compiler = promisify(execFile);
  const source = solution => typeCheckSource(target, 'Solutions.Sample').replace('import Solutions.Sample', solution);
  await writeFile(path, source('theorem solution (n : Nat) : n = n := by rfl'));
  await compiler(process.env.LEAN_TEST_BINARY, ['-DautoImplicit=false', path], { cwd: dir });
  await writeFile(path, source('theorem solution : True := by trivial'));
  await assert.rejects(compiler(process.env.LEAN_TEST_BINARY, ['-DautoImplicit=false', path], { cwd: dir }), error => error.stdout.includes('solution type does not match target'));
});

test('real Lean checks the negation of the entire target and rejects unrelated or axiom-backed certificates', { skip: !process.env.LEAN_TEST_BINARY }, async t => {
  const dir = await temporary(t), path = join(dir, 'Counterexample.lean'), compiler = promisify(execFile);
  const goal = { ...target, formal_statement: 'theorem Ns.goal (n : Nat) : n = 0 := by sorry' };
  const source = solution => typeCheckSource(goal, 'Solutions.Sample', [], { counterexample: true }).replace('import Solutions.Sample', solution);
  await writeFile(path, source('theorem solution : ¬ (∀ n : Nat, n = 0) := by intro h; cases h 1'));
  await compiler(process.env.LEAN_TEST_BINARY, ['-DautoImplicit=false', path], { cwd: dir });
  for (const solution of ['theorem solution : ¬ False := not_false',
    'theorem solution : ∃ n : Nat, n ≠ 0 := ⟨1, Nat.one_ne_zero⟩']) {
    await writeFile(path, source(solution));
    await assert.rejects(compiler(process.env.LEAN_TEST_BINARY, ['-DautoImplicit=false', path], { cwd: dir }),
      error => error.stdout.includes('solution type does not match negation of target'));
  }
  await writeFile(path, source('axiom bad : ¬ (∀ n : Nat, n = 0)\ntheorem solution : ¬ (∀ n : Nat, n = 0) := bad'));
  await assert.rejects(compiler(process.env.LEAN_TEST_BINARY, ['-DautoImplicit=false', path], { cwd: dir }),
    error => error.stdout.includes('counterexample depends on untrusted axiom: bad'));
  await writeFile(path, source('theorem solution : ¬ (∀ n : Nat, n = 0) := by sorry'));
  await assert.rejects(compiler(process.env.LEAN_TEST_BINARY, ['-DautoImplicit=false', path], { cwd: dir }),
    error => error.stdout.includes('counterexample depends on untrusted axiom: sorryAx'));
});
