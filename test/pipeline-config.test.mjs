import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readdir, copyFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipelineLimits } from '../pipeline.mjs';
import { main, Client } from '../prove2me.mjs';
import defaults from '../runner-config.json' with { type: 'json' };

test('default file edits are reread by the same supervisor and every new startup', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'prove2me-fresh-config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const source = new URL('../', import.meta.url);
  for (const file of await readdir(source)) if (file.endsWith('.mjs') || file === 'runner-config.json') {
    await copyFile(new URL(file, source), join(dir, file));
  }
  await promisify(execFile)(process.execPath, ['--input-type=module', '--eval', `
    import assert from 'node:assert/strict';
    import { main } from './prove2me.mjs';
    import { MissionControl } from './mission-control-server.mjs';
    import { readJson, save } from './runner-state.mjs';
    import { pipelineLimits } from './pipeline-config.mjs';
    const control = new MissionControl();
    await control.init();
    const added = await control.command({ id: 'register', action: 'add', query: 'Fresh config', revision: control.registry.revision });
    const missionId = added.result.missionId;
    await main(['--mission', 'Fresh config'], { validateOnly: true });
    await control.state();
    const file = await readJson('runner-config.json');
    for (const profile of ['astra-6-max', 'sol-6.1-high']) {
      file.attemptModels = [profile];
      file.queues.codex.concurrency++;
      await save('runner-config.json', file);
      const next = await main(['--mission', 'Fresh config'], { validateOnly: true });
      assert.deepEqual(next.options.pipeline.attemptModels, [profile]);
      assert.equal(next.options.pipeline.queues.CODEX.concurrency, file.queues.codex.concurrency);
      assert.deepEqual(pipelineLimits().attemptModels, [profile]);
      const view = (await control.state({ missionId })).selected;
      assert.deepEqual(view.configSettings.values.attemptModels, [profile]);
    }
    await control.close();
  `], { cwd: dir, windowsHide: true, timeout: 15000 });
});

test('pipeline and verification defaults come from the project configuration without shared mutable queues', async () => {
  const limits = pipelineLimits();
  assert.equal(limits.verificationMode, defaults.verificationMode);
  assert.equal(limits.promptVariant, defaults.promptVariant);
  assert.equal(limits.windowsSandboxRecovery, defaults.windowsSandboxRecovery);
  assert.equal(pipelineLimits({ windowsSandboxRecovery: 'protected' }).windowsSandboxRecovery, 'protected');
  assert.throws(() => pipelineLimits({ windowsSandboxRecovery: 'typo' }), /windowsSandboxRecovery/);
  assert.equal(pipelineLimits({ promptVariant: 'proof_first' }).promptVariant, 'proof_first');
  assert.equal(pipelineLimits({ promptVariant: 'balanced' }).promptVariant, 'balanced');
  assert.equal(pipelineLimits({ promptVariant: 'original' }).promptVariant, 'balanced');
  assert.throws(() => pipelineLimits({ promptVariant: 'ab_test' }), /promptVariant/);
  assert.equal(pipelineLimits({ promptVariant: 'proofOnly' }).promptVariant, 'proofOnly');
  assert.equal(limits.maxActiveJobs, defaults.maxActiveJobs);
  assert.equal(limits.maxRemoteJobs, defaults.maxRemoteJobs);
  assert.equal(limits.apiConcurrency, defaults.apiConcurrency);
  assert.equal(limits.missionReviewEvery, 100);
  assert.equal(pipelineLimits({ missionReviewEvery: 0 }).missionReviewEvery, 0);
  for (const [name, queue] of Object.entries(defaults.queues)) assert.deepEqual(limits.queues[name.toUpperCase()], queue);
  limits.queues.CODEX.concurrency = 99;
  assert.equal(pipelineLimits().queues.CODEX.concurrency, defaults.queues.codex.concurrency);
  const { verificationMode } = await import('../verification-mode.mjs');
  assert.equal(verificationMode(), defaults.verificationMode);
});

test('configuration validates every field and keeps independent waiting and worker caps', () => {
  const settings = { maxActiveJobs: 6, apiConcurrency: 3, queues: {
    codex: { maxSize: 1, concurrency: 4 }, server: { maxSize: 2, concurrency: 2 } } };
  const limits = pipelineLimits(settings);
  assert.equal(limits.queues.CODEX.maxSize, 1);
  assert.equal(limits.queues.CODEX.concurrency, 4);
  assert.equal(limits.queues.SERVER.concurrency, 2);
  assert.equal(limits.apiConcurrency, 3);
  assert.equal(limits.queues.PREPARE.concurrency, defaults.queues.prepare.concurrency);
  assert.equal(limits.verificationMode, defaults.verificationMode); assert.equal(limits.maxRemoteJobs, defaults.maxRemoteJobs);
  assert.equal(pipelineLimits({ verificationMode: 'server-only', maxRemoteJobs: 8 }).verificationMode, 'server-only');
  assert.deepEqual(settings.queues.codex, { maxSize: 1, concurrency: 4 }, 'validation does not mutate caller settings');
  for (const invalid of [null, [], false, 'settings', { queues: null }, { queues: [] },
    { queues: { codex: null } }, { queues: { codex: [] } }, { queues: { remote: {} } },
    { queues: { codex: { workers: 2 } } }, { queues: { codex: {}, CODEX: {} } },
    { maxActiveJobs: null }, { maxActiveJobs: 1.5 }, { apiConcurrency: 0 }, { apiConcurrency: '4' },
    { maxRemoteJobs: 0 }, { maxRemoteJobs: 1.5 }, { verificationMode: null }, { verificationMode: 'server' },
    ...[null, '', 'proof-first', false, 1, []].map(promptVariant => ({ promptVariant })),
    { queues: { validate: { concurrency: 2 } } }, { queues: { codex: { concurrency: 0 } } },
    { queues: { codex: { maxSize: null } } }, { apiConcurrency: 1 },
    { apiConcurrency: 2, queues: { server: { concurrency: 2 } } },
    { missionReviewEvery: -1 }, { missionReviewEvery: 1.5 }, { missionReviewEvery: '100' },
    { missionReviewModel: null }, { missionReviewModel: '' }, { missionReviewModel: 'luna-6-impossible' }, { unexpected: true },
    { recovery: null }, { recovery: [] }, { recovery: { unexpected: 1 } },
    { recovery: { initialDelayMs: 0 } }, { recovery: { maxDelayMs: '100' } },
    { recovery: { initialDelayMs: 100, maxDelayMs: 10 } }]) {
    assert.throws(() => pipelineLimits(invalid), undefined, JSON.stringify(invalid));
  }
});

test('CLI rejects removed limits and invalid configuration before credentials, API, lock or workspace work', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'prove2me-config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  t.mock.method(globalThis, 'fetch', () => assert.fail('invalid arguments must not reach the API'));
  const config = join(dir, 'config.json'), credentials = join(dir, 'absent-credentials.json');
  const base = ['--mission', 'Target', '--credentials', credentials];
  for (const legacy of [['--max-leaves', '1'], ['--max-leaves=0'], ['--max-leaves=1', '--help']]) {
    await assert.rejects(main([...base, ...legacy]), /--max-leaves has been removed.*Ctrl\+C/);
  }
  for (const value of ['0', '-1', '1.5', 'no', 'Infinity', '']) {
    await assert.rejects(main([...base, `--codex-concurrency=${value}`]), /positive integer/);
    await assert.rejects(main([...base, `--max-remote-jobs=${value}`]), /positive integer/);
    await assert.rejects(main([...base, `--graph-refresh-interval=${value}`]), /--graph-refresh-interval must be a positive integer/);
  }
  await assert.rejects(main([...base, '--config', '']), /must not be empty/);
  await assert.rejects(main([...base, '--verification-mode', 'remote']), /local or server-only/);
  await assert.rejects(main([...base, '--config', join(dir, 'missing.json')]), /Cannot load pipeline configuration/);
  await writeFile(config, '{');
  await assert.rejects(main([...base, '--config', config]), /Cannot load pipeline configuration/);
  await writeFile(config, JSON.stringify({ queues: { codex: { concurrency: 0 } } }));
  await assert.rejects(main([...base, '--config', config, '--codex-concurrency', '2']), /positive integers/);
  await writeFile(config, JSON.stringify({ promptVariant: 'typo' }));
  await assert.rejects(main([...base, '--config', config]), /promptVariant/);
});

test('API client uses the configured permit count', async () => {
  let release, live = 0, peak = 0, started = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const client = new Client('key', async () => {
    started++; peak = Math.max(peak, ++live); await gate; live--;
    return new Response('{}');
  }, { apiConcurrency: 2 });
  const requests = Array.from({ length: 5 }, (_, i) => client.raw(`theorems/${i}`));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(started, 2); assert.equal(peak, 2);
  release(); await Promise.all(requests); assert.equal(peak, 2);
  assert.throws(() => new Client('key', fetch, { apiConcurrency: 0 }), /positive integer/);
});
