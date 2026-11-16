import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, copyFile, readFile, writeFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { credentialStatus, loadApiKey, saveApiKey } from '../credentials-store.mjs';
import { MissionControl, createMissionControlServer } from '../mission-control-server.mjs';

async function fixture(t) {
  const runs = await mkdtemp(join(tmpdir(), 'p2m-credentials-'));
  t.after(() => rm(runs, { recursive: true, force: true }));
  return { runs, path: join(runs, 'credentials.json') };
}

test('missing, malformed, empty and placeholder keys lead to setup; saved keys survive restart', async t => {
  const { path } = await fixture(t);
  for (const content of [null, '{', '{}', 'null', '{"api_key":123}', '{"api_key":"YOUR_PROVE2ME_API_KEY"}', '{"api_key":"a b"}']) {
    if (content !== null) await writeFile(path, content);
    assert.equal((await credentialStatus(path, {})).configured, false);
    await assert.rejects(loadApiKey(path, {}), /Open Mission Control/);
  }
  for (const invalid of ['', ' ', 'bad key', 12, 'x'.repeat(4097)]) await assert.rejects(saveApiKey(path, invalid), /Enter a Prove2.me API key/);
  await saveApiKey(path, '  private-saved-key  ');
  assert.equal(await loadApiKey(path, {}), 'private-saved-key');
  assert.deepEqual(await credentialStatus(path, {}), { configured: true, source: 'file', editable: true });
  if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600);
  await saveApiKey(path, 'private-replacement-key');
  assert.equal(await loadApiKey(path, {}), 'private-replacement-key');
  assert.deepEqual(await readdir(join(path, '..')), ['credentials.json']);
  assert.equal(await loadApiKey(path, { PROVE2ME_API_KEY: 'env-private-key' }), 'env-private-key');
  assert.deepEqual(await credentialStatus(path, { PROVE2ME_API_KEY: 'env-private-key' }), { configured: true, source: 'environment', editable: false });
});

test('authenticated setup saves privately, then starts the same mission using its configured credential file', async t => {
  const { runs, path } = await fixture(t);
  const previousKey = process.env.PROVE2ME_API_KEY;
  delete process.env.PROVE2ME_API_KEY;
  t.after(() => { if (previousKey !== undefined) process.env.PROVE2ME_API_KEY = previousKey; else delete process.env.PROVE2ME_API_KEY; });
  const configPath = join(runs, 'config.json');
  await copyFile(new URL('../runner-config.json', import.meta.url), configPath);
  const children = [];
  const control = new MissionControl({ runs, configPath, credentialsPath: path,
    resolveTarget: async argv => ({ kind: 'mission', name: argv[1], root: argv[1].replaceAll(' ', '-') }), spawnRunner: argv => {
    const child = new EventEmitter(); child.argv = argv; child.pid = 900000;
    child.send = () => queueMicrotask(() => child.emit('exit', 0));
    children.push(child); return child;
  } });
  const app = await createMissionControlServer({ control, port: 0, sampling: false });
  t.after(() => app.close());
  const request = (path, init) => fetch(app.address + path, init);
  const token = new URL(app.url).hash.split('=')[1];
  const login = await request('/api/session', { method: 'POST', headers: { Origin: app.address, Authorization: `Bearer ${token}` } });
  const { csrf } = await login.json();
  const headers = { Cookie: login.headers.get('set-cookie').split(';')[0], Origin: app.address, 'X-CSRF-Token': csrf };
  const post = (path, body, overrides = headers) => request(path, { method: 'POST', headers: overrides, body: JSON.stringify(body) });
  assert.equal((await post('/api/credentials', {}, { Origin: app.address })).status, 401);
  assert.equal((await post('/api/credentials', {}, { ...headers, Origin: 'https://other.example' })).status, 403);
  assert.equal((await post('/api/credentials', {}, { ...headers, 'X-CSRF-Token': '' })).status, 403);
  assert.equal((await post('/api/refresh-missions', {}, { Origin: app.address })).status, 401);
  assert.equal((await post('/api/refresh-missions', {}, { ...headers, Origin: 'https://other.example' })).status, 403);
  assert.equal((await post('/api/refresh-missions', {}, { ...headers, 'X-CSRF-Token': '' })).status, 403);
  assert.equal((await post('/api/credentials', { apiKey: '' })).status, 400);
  const invalidJson = await request('/api/credentials', { method: 'POST', headers, body: 'private-malformed-key' });
  assert.equal(invalidJson.status, 400);
  assert.ok(!(await invalidJson.text()).includes('private-malformed-key'));
  assert.equal((await post('/api/credentials', { apiKey: 'x'.repeat(9000) })).status, 413);

  const command = body => control.command({ id: randomUUID(), revision: control.registry.revision, ...body });
  const added = await command({ action: 'add', query: 'Test mission', start: true });
  const missionId = added.result.missionId;
  assert.equal(added.result.status, 'CREDENTIALS_REQUIRED');
  assert.equal(children.length, 0);
  assert.equal(control.findMission(missionId).status, 'REGISTERED');
  assert.equal((await control.state()).credentials.configured, false);

  const key = 'private-ui-key';
  const saved = await post('/api/credentials', { missionId, apiKey: key });
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).configured, true);
  assert.equal(await loadApiKey(path), key);
  const started = await command({ action: 'start', missionId });
  assert.equal(started.result.status, 'STARTED');
  assert.equal(children.length, 1);
  assert.ok(children[0].argv.includes(path));
  control.findMission(missionId).error = `Example diagnostic ${key}`;
  for (const url of ['/api/state', '/api/export']) {
    const response = await request(url, { headers });
    assert.equal(response.status, 200);
    assert.ok(!(await response.text()).includes(key));
  }
  assert.equal((await request('/credentials.json', { headers })).status, 404);
  assert.ok(!(await readFile(control.path, 'utf8')).includes(key));
  for (const file of await readdir(join(control.base, 'commands'))) assert.ok(!(await readFile(join(control.base, 'commands', file), 'utf8')).includes(key));

  // Trusted CLI custom paths are used; browser-provided paths are ignored.
  const customPath = join(runs, 'custom.json');
  const custom = await command({ action: 'add', query: 'Custom', argv: ['--mission', 'Custom', '--credentials', customPath] });
  const customId = custom.result.missionId;
  await post('/api/credentials', { missionId: customId, apiKey: 'custom-private-key', path: '/ignored' });
  assert.equal(await loadApiKey(customPath), 'custom-private-key');
  assert.equal(await loadApiKey(path), key);
  assert.equal((await post('/api/credentials', { missionId: 'missing', apiKey: key })).status, 404);
  process.env.PROVE2ME_API_KEY = 'environment-private-key';
  assert.equal((await post('/api/credentials', { missionId, apiKey: 'replacement' })).status, 409);
  assert.equal(await loadApiKey(path, {}), key);
});

test('saving a replacement key retries failed discovery with fresh authentication and persists the resolved title', async t => {
  const { runs, path } = await fixture(t);
  const previousKey = process.env.PROVE2ME_API_KEY;
  delete process.env.PROVE2ME_API_KEY;
  t.after(() => { if (previousKey !== undefined) process.env.PROVE2ME_API_KEY = previousKey; else delete process.env.PROVE2ME_API_KEY; });
  const configPath = join(runs, 'config.json');
  await copyFile(new URL('../runner-config.json', import.meta.url), configPath);
  await saveApiKey(path, 'old-rejected-private-key');
  let spawns = 0;
  const control = new MissionControl({ runs, configPath, credentialsPath: path, spawnRunner: () => { spawns++; } });
  await control.init();
  const query = 'https://prove2.me/missions/Recovered_mission';
  const added = await control.command({ id: randomUUID(), revision: control.registry.revision, action: 'add', query });
  const missionId = added.result.missionId;
  const mission = control.findMission(missionId);
  Object.assign(mission, { status: 'ERROR', error: 'Prove2.me authentication failed (HTTP 401)' });
  await control.persist();
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push(url.pathname);
    if (url.pathname === '/api/v1/agent/refresh') {
      assert.equal(JSON.parse(init.body).api_key, 'replacement-private-key');
      return Response.json({ access_token: 'replacement-token', expires_at: Date.now() / 1000 + 3600 });
    }
    assert.equal(url.pathname, '/api/v1/missions');
    assert.equal(url.searchParams.get('name'), 'Recovered mission');
    assert.equal(init.headers.Authorization, 'Bearer replacement-token');
    return Response.json({ missions: [{ id: 'recovered-mission', name: 'Recovered mission', main_theorem: { theorem_id: 'recovered-root' } }], total: 1 });
  });
  const result = await control.saveCredentials({ missionId, apiKey: 'replacement-private-key' });
  assert.equal(result.missionRefreshError, undefined);
  assert.deepEqual(calls, ['/api/v1/agent/refresh', '/api/v1/missions']);
  const state = await control.state({ missionId });
  assert.equal(state.selected.mission.name, 'Recovered mission');
  assert.equal(state.selected.mission.target.root, 'recovered-root');
  assert.equal(state.selected.mission.processStatus, 'REGISTERED');
  assert.equal(state.missions[0].mission.error, null);
  assert.equal(spawns, 0);
  assert.ok(!JSON.stringify(state).includes('replacement-private-key'));
  const restored = new MissionControl({ runs, configPath, credentialsPath: path });
  await restored.init();
  assert.equal(restored.findMission(missionId).name, 'Recovered mission');
  assert.equal(restored.findMission(missionId).status, 'REGISTERED');
});

test('lookup failures remain actionable; successful key updates preserve unrelated run failures and active runs', async t => {
  const { runs, path } = await fixture(t);
  const previousKey = process.env.PROVE2ME_API_KEY;
  delete process.env.PROVE2ME_API_KEY;
  t.after(() => { if (previousKey !== undefined) process.env.PROVE2ME_API_KEY = previousKey; else delete process.env.PROVE2ME_API_KEY; });
  const configPath = join(runs, 'config.json');
  await copyFile(new URL('../runner-config.json', import.meta.url), configPath);
  let fail = true, lookups = 0;
  const control = new MissionControl({ runs, configPath, credentialsPath: path,
    resolveTarget: async (argv, key) => {
      lookups++;
      assert.equal(key, fail ? 'rejected-private-key' : 'working-private-key');
      if (fail) throw new Error(`Rejected rejected-private-key (HTTP 401)`);
      return { kind: 'mission', name: 'Resolved mission', root: 'root' };
    } });
  await control.init();
  const added = await control.command({ id: randomUUID(), revision: control.registry.revision, action: 'add', query: 'Mission' });
  const missionId = added.result.missionId, mission = control.findMission(missionId);
  let result = await control.saveCredentials({ missionId, apiKey: 'rejected-private-key' });
  assert.match(result.missionRefreshError, /HTTP 401/);
  assert.ok(!result.missionRefreshError.includes('rejected-private-key'));
  assert.equal(mission.status, 'ERROR');
  fail = false;
  await control.saveCredentials({ missionId, apiKey: 'working-private-key' });
  assert.equal(mission.status, 'REGISTERED');
  assert.equal(mission.error, null);
  Object.assign(mission, { status: 'ERROR', error: 'Workspace build failed' });
  await control.saveCredentials({ missionId, apiKey: 'working-private-key' });
  assert.equal(mission.status, 'ERROR');
  assert.equal(mission.error, 'Workspace build failed');
  Object.assign(mission, { status: 'ERROR', error: 'Prove2.me HTTP 403 at /api/v1/missions' });
  await control.saveCredentials({ missionId, apiKey: 'working-private-key' });
  assert.equal(mission.status, 'REGISTERED');
  assert.equal(mission.error, null);
  mission.status = 'RUNNING';
  const before = lookups;
  await control.saveCredentials({ missionId, apiKey: 'working-private-key' });
  assert.equal(mission.status, 'RUNNING');
  assert.equal(lookups, before);
});

test('reopening retries saved unresolved and authentication failures with current credentials and preserves other missions', async t => {
  const { runs, path } = await fixture(t);
  const previousKey = process.env.PROVE2ME_API_KEY;
  delete process.env.PROVE2ME_API_KEY;
  t.after(() => { if (previousKey !== undefined) process.env.PROVE2ME_API_KEY = previousKey; else delete process.env.PROVE2ME_API_KEY; });
  const configPath = join(runs, 'config.json'), customPath = join(runs, 'custom.json');
  await copyFile(new URL('../runner-config.json', import.meta.url), configPath);
  await saveApiKey(path, 'current-saved-key');
  await saveApiKey(customPath, 'custom-saved-key');
  const control = new MissionControl({ runs, configPath, credentialsPath: path });
  await control.init();
  control.registry.missions = [
    { id: 'unresolved', name: 'https://prove2.me/missions/Unresolved', status: 'ERROR', error: 'Old discovery failed', argv: ['--mission', 'Unresolved'] },
    { id: 'auth', name: 'Auth', status: 'ERROR', error: 'Prove2.me HTTP 401', target: { root: 'auth-root' }, argv: ['--mission', 'Auth'] },
    { id: 'custom', name: 'Custom', status: 'REGISTERED', argv: ['--mission', 'Custom', '--credentials', customPath] },
    { id: 'missing', name: 'Missing', status: 'ERROR', error: 'Prove2.me API key required', argv: ['--mission', 'Missing', '--credentials', join(runs, 'missing.json')] },
    { id: 'healthy', name: 'Healthy', status: 'COMPLETE', target: { root: 'healthy-root' }, argv: ['--mission', 'Healthy'] },
    { id: 'build', name: 'Build', status: 'ERROR', error: 'Workspace build failed', target: { root: 'build-root' }, argv: ['--mission', 'Build'] },
  ];
  await control.persist();
  const calls = [];
  let spawns = 0;
  const restored = new MissionControl({ runs, configPath, credentialsPath: path,
    spawnRunner: () => { spawns++; },
    resolveTarget: async (argv, key) => {
      calls.push(argv[1]);
      assert.equal(key, argv[1] === 'Custom' ? 'custom-saved-key' : 'current-saved-key');
      return { kind: 'mission', name: `${argv[1]} resolved`, root: `${argv[1].toLowerCase()}-root` };
    } });
  await restored.init();
  const first = restored.refreshMissions();
  assert.equal(restored.refreshMissions(), first, 'overlapping opens share the same refresh');
  await first;
  assert.deepEqual(calls, ['Unresolved', 'Auth', 'Custom']);
  for (const id of ['unresolved', 'auth', 'custom']) {
    assert.equal(restored.findMission(id).status, 'REGISTERED');
    assert.equal(restored.findMission(id).error, null);
    assert.match(restored.findMission(id).name, /resolved$/);
  }
  assert.equal(restored.findMission('healthy').status, 'COMPLETE');
  assert.equal(restored.findMission('build').error, 'Workspace build failed');
  assert.equal(restored.findMission('missing').error, 'Prove2.me API key required');
  await restored.refreshMissions();
  assert.equal(calls.length, 3, 'healthy missions do not trigger another lookup');
  assert.equal(spawns, 0);

  // Active/external work must not be rediscovered or modified by reopening.
  restored.findMission('unresolved').error = 'Prove2.me HTTP 401';
  restored.findMission('unresolved').status = 'RUNNING';
  await restored.refreshMissions();
  assert.equal(calls.length, 3);
  restored.findMission('unresolved').status = 'ERROR';
  restored.externalRunner = async () => ({ alive: true });
  await restored.refreshMissions();
  assert.equal(calls.length, 3);
});
