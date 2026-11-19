import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { fork } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, symlink, readdir, copyFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { MissionControl, createMissionControlServer, launchMissionControl, openMissionControlBrowser } from '../mission-control-server.mjs';
import { buildMissionView, artifactList, readArtifact, redact } from '../mission-control-data.mjs';
import { MissionCommands } from '../mission-control-commands.mjs';
import { Pipeline } from '../pipeline.mjs';
import { readJson, save } from '../runner-state.mjs';
import { attemptModel, incompleteEvidence } from '../model-policy.mjs';
import { main } from '../prove2me.mjs';
import { readRunnerConfig } from '../runner-config-store.mjs';

async function fixture(t) {
  const runs = await mkdtemp(join(tmpdir(), 'mission-control-'));
  const configPath = join(runs, 'runner-config.json');
  await copyFile(new URL('../runner-config.json', import.meta.url), configPath);
  const children = [];
  const spawnRunner = argv => {
    const child = new EventEmitter();
    child.pid = 900000 + children.length;
    child.argv = argv;
    child.send = message => {
      if (message.type === 'stop') queueMicrotask(() => child.emit('exit', 130));
      if (message.type === 'command') queueMicrotask(() => child.emit('message', { type: 'receipt', id: message.command.id,
        receipt: { id: message.command.id, status: 'APPLIED' } }));
    };
    children.push(child); return child;
  };
  const control = new MissionControl({ runs, configPath, spawnRunner, validateArgs: async argv => {
    if (argv.some(arg => typeof arg !== 'string')) throw new Error('Invalid argument');
    return { query: argv[1], options: { pipeline: {} } };
  }, sampleLimits: async () => ({ ordinaryUsageAllowed: true, rateLimits: { primary: { usedPercent: 34, windowDurationMins: 300, resetsAt: 1900000000 } } }) });
  control.credentials = async () => ({ configured: true, source: 'file', editable: true });
  await control.init();
  t.after(async () => { await control.close(); await rm(runs, { recursive: true, force: true }); });
  const command = body => control.command({ id: randomUUID(), revision: control.registry.revision, ...body });
  return { runs, configPath, control, children, command };
}

test('site opens with no mission and makes no runner or model invocation', async t => {
  const h = await fixture(t);
  const state = await h.control.state();
  assert.deepEqual(state.missions, []);
  assert.equal(state.selected, null);
  assert.equal(h.children.length, 0);
  assert.deepEqual(state.totals, { proofs: 0, sketches: 0, sketched_theorems: 0, uniqueOpenLeaves: 0, pending: 0 });
});

test('default and explicit UI launches wait for a mission to be added and started', async t => {
  for (const argv of [[], ['--ui']]) {
    await t.test(argv.length ? '--ui' : 'no arguments', async t => {
      const h = await fixture(t);
      h.control.validateArgs = argv => main(argv, { validateOnly: true });
      let openedUrl;
      const app = await launchMissionControl(argv, {
        control: h.control, port: 0, sampling: false,
        openBrowser: async url => { openedUrl = url; },
      });
      t.after(() => app.close());
      assert.equal(openedUrl, app.url);
      assert.equal((await fetch(app.address)).status, 200);
      assert.deepEqual((await h.control.state()).missions, []);
      assert.equal(h.children.length, 0);

      const added = await h.command({ action: 'add', query: 'Chosen in the UI', start: false });
      assert.equal(added.status, 'APPLIED');
      assert.equal(h.children.length, 0);
      assert.equal((await h.control.state()).selected.mission.name, 'Chosen in the UI');

      const started = await h.command({ action: 'start', missionId: added.result.missionId });
      assert.equal(started.status, 'APPLIED');
      assert.equal(h.children.length, 1);
      assert.deepEqual(h.children[0].argv, ['--mission', 'Chosen in the UI', '--config', h.configPath]);
    });
  }
});

test('the default dashboard opens the running mission, last checkpoint, or latest saved mission', async t => {
  const h = await fixture(t);
  const first = (await h.command({ action: 'add', query: 'First mission' })).result.missionId;
  const second = (await h.command({ action: 'add', query: 'Latest mission' })).result.missionId;
  let state = await h.control.state();
  assert.equal(state.selected.mission.id, second);
  assert.ok(state.selected.configSettings, 'default dashboard includes editable run settings');
  h.control.findMission(first).target = { kind: 'mission', name: 'First mission', root: 'root' };
  await save(join(h.runs, 'last-run.json'), { target: { root: 'root' } });
  assert.equal((await h.control.state()).selected.mission.id, first);
  await h.command({ action: 'start', missionId: second });
  assert.equal((await h.control.state()).selected.mission.id, second);
  assert.equal((await h.control.state({ missionId: 'outdated-bookmark' })).selected.mission.id, second);
  assert.equal((await h.control.state({ missionId: first })).selected.mission.id, first);
});

test('browser launch uses the platform opener without taking over console streams', async t => {
  const url = 'http://127.0.0.1:4317/#session=test-token';
  for (const [platform, executable] of [['win32', 'powershell.exe'], ['darwin', 'open'], ['linux', 'xdg-open']]) {
    await t.test(platform, async () => {
      let calls = 0;
      await openMissionControlBrowser(url, { platform, spawnProcess: (command, args, options) => {
        calls++;
        assert.equal(command, executable);
        assert.equal(options.stdio, 'ignore');
        assert.equal(options.windowsHide, true);
        assert.equal(options.timeout, 10000);
        if (platform === 'win32') {
          assert.equal(options.env.PROVE2ME_UI_URL, url);
          assert.ok(args.includes('Hidden'));
          assert.equal(args.at(-1), 'Start-Process -FilePath $env:PROVE2ME_UI_URL');
        } else assert.deepEqual(args, [url]);
        const child = new EventEmitter();
        queueMicrotask(() => child.emit('exit', 0, null));
        return child;
      } });
      assert.equal(calls, 1);
    });
  }
});

test('missing or failed browser openers report failure', async () => {
  for (const event of ['error', 'exit']) {
    await assert.rejects(openMissionControlBrowser('http://127.0.0.1:4317/', { spawnProcess: () => {
      const child = new EventEmitter();
      queueMicrotask(() => event === 'error' ? child.emit('error', new Error('opener missing')) : child.emit('exit', 1, null));
      return child;
    } }), /opener missing|exited with 1/);
  }
});

test('mission command opens the authenticated UI after listening and starts the requested runner', async t => {
  const h = await fixture(t);
  let openedUrl;
  const app = await launchMissionControl(['--mission', 'Your mission'], {
    control: h.control, port: 0, sampling: false,
    openBrowser: url => { openedUrl = url; return new Promise(() => {}); },
  });
  t.after(() => app.close());
  assert.equal(openedUrl, app.url);
  assert.match(openedUrl, /\/#session=[a-f0-9]+$/);
  assert.equal((await fetch(openedUrl)).status, 200);
  assert.equal(h.children.length, 1, 'runner startup does not wait for the browser');
  assert.deepEqual(h.children[0].argv, ['--mission', 'Your mission', '--config', h.configPath]);
});

test('browser failure keeps the mission running and prints the manual fallback', async t => {
  const h = await fixture(t);
  const messages = [], warnings = [];
  t.mock.method(console, 'log', message => messages.push(message));
  t.mock.method(console, 'warn', message => warnings.push(message));
  const app = await launchMissionControl(['--mission', 'Your mission'], {
    control: h.control, port: 0, sampling: false,
    openBrowser: async () => { throw new Error('No browser installed'); },
  });
  t.after(() => app.close());
  assert.equal(h.children.length, 1);
  assert.ok(app.server.listening);
  assert.ok(messages.some(message => message.includes(app.url) && message.includes('Console logs continue here')));
  assert.ok(warnings.some(message => message.includes('Open the Mission Control URL printed above')));
});

test('register, launch, reject concurrent launch, stop and restart preserve arguments and idempotence', async t => {
  const h = await fixture(t);
  const add = await h.command({ action: 'add', query: 'First mission', milestone: 'A milestone', start: true });
  assert.equal(add.status, 'APPLIED'); assert.equal(h.children.length, 1);
  assert.deepEqual(h.children[0].argv, ['--mission', 'First mission', '--milestone', 'A milestone', '--config', h.configPath]);
  const firstId = add.result.missionId;
  assert.equal((await h.control.command({ id: add.id, action: 'add' })).status, 'APPLIED');
  assert.equal(h.children.length, 1, 'redelivery cannot launch again');
  const next = await h.command({ action: 'add', query: 'Second mission' });
  const blocked = await h.command({ action: 'start', missionId: next.result.missionId });
  assert.equal(blocked.status, 'REJECTED'); assert.match(blocked.error, /One mission/);
  const stale = h.control.registry.revision - 1;
  await assert.rejects(h.control.command({ id: randomUUID(), action: 'start', missionId: firstId, revision: stale }), /Refresh/);
  h.children[0].emit('message', { type: 'ready', runId: 'run-1' });
  await h.control.writer;
  const pause = await h.command({ action: 'pause-dispatch', missionId: firstId, runId: 'run-1', controlRevision: 0 });
  assert.equal(pause.status, 'APPLIED');
  const stop = await h.command({ action: 'stop', missionId: firstId, runId: 'run-1' });
  assert.equal(stop.status, 'APPLIED');
  await h.control.writer;
  assert.equal(h.control.active, null);
  const restart = await h.command({ action: 'start', missionId: firstId });
  assert.equal(restart.status, 'APPLIED'); assert.equal(h.children.length, 2);
  assert.deepEqual(h.children[1].argv, h.children[0].argv);
});

test('existing live or stale runner lock blocks launch and is never removed', async t => {
  const h = await fixture(t);
  await writeFile(join(h.runs, 'runner.lock'), String(process.pid));
  const blocked = await h.command({ action: 'add', query: 'Locked mission', start: true });
  assert.equal(blocked.status, 'REJECTED'); assert.match(blocked.error, /existing runner/);
  assert.equal(h.children.length, 0);
  await writeFile(join(h.runs, 'runner.lock'), '99999999');
  const stale = await h.command({ action: 'start', missionId: h.control.registry.missions[0].id });
  assert.equal(stale.status, 'REJECTED'); assert.match(stale.error, /saved runner lock/);
});

test('operator pauses persist, have independent scope, reject stale run/revision, and deduplicate', async t => {
  const h = await fixture(t);
  let wakes = 0;
  const p = { options: { runs: h.runs }, target: { root: 'root' }, runId: 'run-1', signal: new AbortController().signal, wake: () => wakes++ };
  const commands = new MissionCommands(p); await commands.load();
  const pause = { id: randomUUID(), action: 'pause-admission', runId: 'run-1', revision: 0 };
  await commands.execute(pause); await commands.execute(pause);
  assert.equal(commands.state.admissionPaused, true); assert.equal(wakes, 1);
  await assert.rejects(commands.execute({ ...pause, id: randomUUID() }), /Refresh/);
  await assert.rejects(commands.execute({ ...pause, id: randomUUID(), runId: 'old', revision: 1 }), /Refresh/);
  await commands.execute({ id: randomUUID(), action: 'pause-dispatch', runId: 'run-1', revision: 1 });
  await commands.execute({ id: randomUUID(), action: 'resume-admission', runId: 'run-1', revision: 2 });
  const restored = new MissionCommands({ ...p, runId: 'run-2' }); await restored.load();
  assert.equal(restored.state.admissionPaused, false); assert.equal(restored.state.dispatchPaused, true);
});

test('agent stop survives restart and resume preserves admission, dispatch and quota pauses', async t => {
  const h = await fixture(t);
  const p = new Pipeline({}, { root: 'root' }, { runs: h.runs });
  await p.operator.load();
  const command = action => p.operator.execute({ id: randomUUID(), action, runId: p.runId, revision: p.operator.state.revision });
  await command('pause-admission'); await command('pause-dispatch');
  p.quota.state = { status: 'WAITING', next_check_at: 123 };
  const stop = { id: randomUUID(), action: 'stop-agents', runId: p.runId, revision: 2 };
  await p.operator.execute(stop); await p.operator.execute(stop);
  assert.equal(p.operator.state.revision, 3);
  const restored = new Pipeline({}, { root: 'root' }, { runs: h.runs });
  await restored.operator.load();
  assert.equal(restored.operator.state.agentsStopped, true);
  await command('resume-agents');
  assert.equal(p.operator.state.agentsStopped, false);
  assert.equal(p.operator.state.admissionPaused, true);
  assert.equal(p.operator.state.dispatchPaused, true);
  assert.equal(p.quota.state.status, 'WAITING');
});

test('prompt settings validate, persist across runner restarts, and reject stale changes', async t => {
  const h = await fixture(t);
  const p = new Pipeline({}, { root: 'root' }, { runs: h.runs, configPath: h.configPath });
  await p.operator.load();
  await p.operator.execute({ id: randomUUID(), action: 'set-prompt-variant', promptVariant: 'proofOnly', runId: p.runId, revision: 0 });
  assert.equal(p.limits.promptVariant, 'proofOnly');
  await assert.rejects(p.operator.execute({ id: randomUUID(), action: 'set-prompt-variant', promptVariant: 'typo', runId: p.runId, revision: 1 }), /promptVariant/);
  assert.equal(p.operator.state.revision, 1);
  const restored = new Pipeline({}, { root: 'root' }, { runs: h.runs, configPath: h.configPath, pipeline: (await readRunnerConfig(h.configPath)).values });
  await restored.operator.load();
  assert.equal(restored.limits.promptVariant, 'proofOnly');
  const mission = { id: 'saved-root', name: 'Root', target: { root: 'root' }, argv: ['--mission', 'Root'], status: 'SAVED' };
  h.control.registry.missions.push(mission);
  let view = (await h.control.state({ missionId: mission.id })).selected;
  assert.equal(view.promptSettings.promptVariant, 'proofOnly');
  const change = { action: 'set-prompt-variant', missionId: mission.id, promptVariant: 'proof_first', controlRevision: view.promptSettings.revision };
  assert.equal((await h.command(change)).status, 'APPLIED');
  assert.equal((await h.command(change)).status, 'REJECTED');
  view = (await h.control.state({ missionId: mission.id })).selected;
  assert.equal(view.promptSettings.promptVariant, 'proof_first');
  await restored.operator.load();
  assert.equal(restored.limits.promptVariant, 'proofOnly', 'loading controls cannot change the running settings');
  assert.equal((await readRunnerConfig(h.configPath)).values.promptVariant, 'proof_first');
});

test('live model and queue changes persist, reach copied worker options, and reject invalid or stale changes', async t => {
  const h = await fixture(t);
  const p = new Pipeline({}, { root: 'root' }, { runs: h.runs, configPath: h.configPath, model: 'luna-6-high' });
  await p.operator.load();
  const workerOptions = { ...p.options };
  const command = { id: randomUUID(), action: 'set-runtime-settings', runId: p.runId, revision: 0, promptVariant: 'proofOnly',
    settings: { attemptModels: ['astra-6-max'], queues: { CODEX: { concurrency: 2, maxSize: 7 } }, maxActiveJobs: 9 } };
  const receipt = await p.operator.execute(command);
  assert.equal(receipt.status, 'APPLIED');
  assert.equal(p.limits.queues.CODEX.concurrency, 2);
  assert.equal(p.limits.promptVariant, 'proofOnly');
  assert.equal(attemptModel(2, workerOptions).model, 'gpt-6-astra');
  assert.equal(attemptModel(2, workerOptions).reasoningEffort, 'max');
  await p.operator.execute(command);
  assert.equal(p.operator.state.revision, 1);
  await assert.rejects(p.operator.execute({ ...command, id: randomUUID() }), /Refresh/);
  await assert.rejects(p.operator.execute({ ...command, id: randomUUID(), revision: 1, settings: null }), /object/);
  await assert.rejects(p.operator.execute({ ...command, id: randomUUID(), revision: 1, promptVariant: 'typo', settings: { maxActiveJobs: 99 } }), /promptVariant/);
  assert.equal(p.limits.maxActiveJobs, 9);
  assert.equal(p.operator.state.revision, 1);
  await assert.rejects(p.operator.execute({ ...command, id: randomUUID(), revision: 1, settings: { queues: { CODEX: { concurrency: 0 } } } }), /positive/);
  const restored = new Pipeline({}, { root: 'root' }, { runs: h.runs, configPath: h.configPath, pipeline: (await readRunnerConfig(h.configPath)).values });
  await restored.operator.load();
  assert.equal(restored.limits.queues.CODEX.maxSize, 7);
  assert.equal(restored.limits.maxActiveJobs, 9);
  assert.equal(restored.limits.promptVariant, 'proofOnly');
  assert.equal(attemptModel(1, restored.options).model, 'gpt-6-astra');
  h.control.registry.missions.push({ id: 'saved-runtime', name: 'Root', target: { root: 'root' }, argv: ['--mission', 'Root'], status: 'SAVED' });
  const selected = (await h.control.state({ missionId: 'saved-runtime' })).selected;
  assert.equal(selected.configSettings.values.attemptModels[0], 'astra-6-max');
  assert.equal(selected.configSettings.revision, 1);
});

test('live escalation settings reach copied workers, persist across restart, and reject invalid changes', async t => {
  const h = await fixture(t);
  const initialEscalation = (await readRunnerConfig(h.configPath)).values.incompleteEscalation;
  const p = new Pipeline({}, { root: 'root' }, { runs: h.runs, configPath: h.configPath,
    pipeline: { attemptModels: ['luna-6-high'], incompleteEscalation: { after: 2, model: 'sol-6.1-high', maxAttempts: null } } });
  await p.operator.load();
  const workerOptions = { ...p.options, pipeline: structuredClone(p.options.pipeline) };
  const stalled = { context_id: 'initial', history: [1, 2].map(attempt => ({ event_type: 'attempt', attempt,
    attempt_id: `attempt-${attempt}`, context_id: 'initial', result: 'incomplete',
    failure: { category: 'incomplete_argument', stagnation: incompleteEvidence({
      explanation: 'The unresolved coefficient identity requires finite expansion of ideal powers and homogeneous component products.' }, null, 'gpt-6-luna', null) } })) };
  assert.equal(attemptModel(3, workerOptions, stalled).model, 'gpt-6.1-sol');
  const change = settings => p.operator.execute({ id: randomUUID(), action: 'set-runtime-settings',
    runId: p.runId, revision: p.operator.state.revision, settings: { incompleteEscalation: settings } });
  await change({ after: 0 });
  assert.equal(attemptModel(3, workerOptions, stalled).model, 'gpt-6-luna');
  assert.deepEqual((await readRunnerConfig(h.configPath)).values.incompleteEscalation,
    { ...initialEscalation, after: 0 });
  await change({ after: 2, model: 'astra-6-max', maxAttempts: 1 });
  const rescue = attemptModel(3, workerOptions, stalled);
  assert.equal(rescue.model, 'gpt-6-astra');
  assert.equal(rescue.reasoningEffort, 'max');
  stalled.history.push({ event_type: 'attempt', attempt: 3, attempt_id: 'attempt-3', context_id: 'initial',
    result: 'started', model: rescue.model, escalation: rescue.escalation });
  assert.equal(attemptModel(4, workerOptions, stalled).model, 'gpt-6-luna', 'the configured rescue cap is enforced');
  const saved = await readRunnerConfig(h.configPath);
  assert.deepEqual(saved.values.incompleteEscalation, { after: 2, model: 'astra-6-max', maxAttempts: 1 });
  const restored = new Pipeline({}, { root: 'root' }, { runs: h.runs, configPath: h.configPath,
    pipeline: { ...saved.values, attemptModels: ['luna-6-high'] } });
  await restored.operator.load();
  assert.deepEqual(restored.limits.incompleteEscalation, p.limits.incompleteEscalation);
  assert.equal(attemptModel(4, restored.options, stalled).model, 'gpt-6-luna');
  await assert.rejects(change({ after: -1 }), /nonnegative/);
  assert.equal(p.operator.state.revision, 2);
  assert.equal((await readRunnerConfig(h.configPath)).revision, saved.revision);
  await change({ maxAttempts: null });
  assert.equal(attemptModel(4, workerOptions, stalled).model, 'gpt-6-astra', 'unlimited rescues resume on the next selection');
});

test('a mission can save model and queue settings before its first start without launching a process', async t => {
  const h = await fixture(t);
  const added = await h.command({ action: 'add', query: 'New settings' });
  const missionId = added.result.missionId;
  const saved = await h.command({ action: 'set-runtime-settings', missionId, promptVariant: 'proofOnly',
    settings: { attemptModels: ['sol-6.1-medium'], incompleteEscalation: { after: 0, model: 'astra-6-high', maxAttempts: 3 },
      queues: { CODEX: { concurrency: 3 } } } });
  assert.equal(saved.status, 'APPLIED');
  assert.equal(h.children.length, 0);
  const config = await readJson(h.configPath);
  assert.equal(config.attemptModels[0], 'sol-6.1-medium');
  assert.equal(config.queues.codex.concurrency, 3);
  assert.equal(config.promptVariant, 'proofOnly');
  assert.deepEqual(config.incompleteEscalation, { after: 0, model: 'astra-6-high', maxAttempts: 3 });
  assert.equal((await h.control.state({ missionId })).selected.configSettings.values.promptVariant, 'proofOnly');
});

test('saved model and effort are read back from the real mission config after repeated saves and a supervisor restart', async t => {
  const h = await fixture(t);
  h.control.validateArgs = argv => main(argv, { validateOnly: true });
  const missionId = (await h.command({ action: 'add', query: 'Settings round trip' })).result.missionId;
  for (const profile of ['sol-6.1-ultra', 'luna-6-high']) {
    const before = await h.control.state({ missionId });
    const result = await h.command({ action: 'set-runtime-settings', missionId, revision: before.revision,
      controlRevision: before.selected.configSettings.revision, promptVariant: 'proof_first',
      settings: { attemptModels: [profile], queues: { CODEX: { concurrency: 3 } } } });
    assert.equal(result.status, 'APPLIED', result.error);
    const after = await h.control.state({ missionId });
    assert.deepEqual(after.selected.configSettings.values.attemptModels, [profile]);
    assert.equal(after.selected.configSettings.values.promptVariant, 'proof_first');
    assert.equal(after.selected.configSettings.values.queues.CODEX.concurrency, 3);
  }
  const restored = new MissionControl({ runs: h.runs, configPath: h.configPath });
  await restored.init();
  t.after(() => restored.close());
  const afterRestart = await restored.state({ missionId });
  assert.deepEqual(afterRestart.selected.configSettings.values.attemptModels, ['luna-6-high']);
  assert.equal(afterRestart.selected.configSettings.values.promptVariant, 'proof_first');
  assert.equal(h.children.length, 0);
});

test('supervisor forwards prompt settings to the active coordinator with its control revision', async t => {
  const h = await fixture(t);
  const added = await h.command({ action: 'add', query: 'Live prompt', start: true });
  const missionId = added.result.missionId;
  const p = new Pipeline({}, { root: 'root' }, { runs: h.runs, configPath: h.configPath });
  await p.operator.load();
  h.children[0].emit('message', { type: 'target', target: { root: 'root', name: 'Live prompt' } });
  h.children[0].emit('message', { type: 'ready', runId: p.runId });
  await h.control.writer;
  h.children[0].send = message => {
    if (message.type === 'stop') queueMicrotask(() => h.children[0].emit('exit', 0));
    else p.operator.execute(message.command).then(receipt => h.children[0].emit('message', { type: 'receipt', id: message.command.id, receipt }));
  };
  const result = await h.command({ action: 'set-prompt-variant', missionId, promptVariant: 'proofOnly', runId: p.runId, controlRevision: 0 });
  assert.equal(result.status, 'APPLIED');
  assert.equal(p.limits.promptVariant, 'proofOnly');
  assert.equal((await h.control.state({ missionId })).selected.promptSettings.promptVariant, 'proofOnly');
  const settings = await h.command({ action: 'set-runtime-settings', missionId, runId: p.runId, controlRevision: 1, promptVariant: 'proof_first',
    settings: { attemptModels: ['terra-6.1-max'], queues: { CODEX: { concurrency: 3 } } } });
  assert.equal(settings.status, 'APPLIED');
  assert.equal(p.limits.queues.CODEX.concurrency, 3);
  assert.equal(p.limits.promptVariant, 'proof_first');
  assert.equal(attemptModel(1, p.options).model, 'gpt-6.1-terra');
  assert.equal((await h.control.state({ missionId })).selected.configSettings.values.attemptModels[0], 'terra-6.1-max');
  assert.equal((await h.control.state({ missionId })).selected.promptSettings.promptVariant, 'proof_first');
});

test('UI saves update the shared file and preserve settings outside the form', async t => {
  const h = await fixture(t);
  const original = await readJson(h.configPath);
  const first = (await h.command({ action: 'add', query: 'First settings' })).result.missionId;
  const second = (await h.command({ action: 'add', query: 'Shared settings' })).result.missionId;
  const before = (await h.control.state({ missionId: first })).selected.configSettings;
  const result = await h.command({ action: 'set-runtime-settings', missionId: first,
    configRevision: before.configRevision, promptVariant: 'proof_first', settings: {
      attemptModels: ['sol-6.1-high'], queues: { CODEX: { concurrency: 3 } },
    } });
  assert.equal(result.status, 'APPLIED', result.error);
  const saved = await readJson(h.configPath);
  assert.deepEqual(saved._comment, original._comment);
  assert.deepEqual(saved.recovery, original.recovery);
  assert.deepEqual(saved.incompleteEscalation, original.incompleteEscalation);
  assert.equal(saved.queues.codex.concurrency, 3);
  assert.equal(saved.queues.codex.maxSize, original.queues.codex.maxSize);
  assert.equal(Object.hasOwn(saved.queues, 'CODEX'), false);
  assert.equal(h.control.findMission(first).nextArgv, undefined);
  const other = (await h.control.state({ missionId: second })).selected.configSettings;
  assert.equal(other.path, h.configPath);
  assert.deepEqual(other.values.attemptModels, ['sol-6.1-high']);
  assert.equal(other.values.promptVariant, 'proof_first');
  assert.equal(h.children.length, 0);
});

test('legacy per-mission settings and generated configs never override the file; pauses survive', async t => {
  const h = await fixture(t);
  const missionId = (await h.command({ action: 'add', query: 'Legacy settings' })).result.missionId;
  const mission = h.control.findMission(missionId);
  mission.target = { root: 'legacy-root', name: 'Legacy settings' };
  const legacyConfig = join(h.control.base, 'configs', missionId + '.json');
  await save(legacyConfig, { attemptModels: ['astra-6-max'] });
  mission.nextArgv = [...mission.argv, '--config', legacyConfig];
  await save(join(h.control.base, 'controls', 'legacy-root.json'), { revision: 7,
    admissionPaused: true, dispatchPaused: true, receipts: [],
    promptVariant: 'invalid legacy value', runtimeSettings: { maxActiveJobs: -1 } });
  const file = await readJson(h.configPath);
  file.attemptModels = ['terra-6.1-medium'];
  file.promptVariant = 'balanced';
  await save(h.configPath, file);
  const configured = await main(h.control.runnerArgs(mission.nextArgv), { validateOnly: true });
  const p = new Pipeline({}, mission.target, { ...configured.options, runs: h.runs });
  await p.operator.load();
  assert.equal(p.limits.promptVariant, 'balanced');
  assert.deepEqual(p.limits.attemptModels, ['terra-6.1-medium']);
  assert.equal(p.operator.state.admissionPaused, true);
  assert.equal(p.operator.state.dispatchPaused, true);
  assert.equal(p.operator.state.revision, 7);
  assert.equal(Object.hasOwn(p.operator.state, 'runtimeSettings'), false);
  const view = (await h.control.state({ missionId })).selected;
  assert.equal(view.promptSettings.promptVariant, 'balanced');
  assert.deepEqual(view.configSettings.values.attemptModels, ['terra-6.1-medium']);
  assert.equal((await h.command({ action: 'start', missionId })).status, 'APPLIED');
  assert.ok(!h.children[0].argv.includes(legacyConfig));
});

test('an explicit config is edited in place and saving replaces matching CLI overrides', async t => {
  const h = await fixture(t);
  h.control.validateArgs = argv => main(argv, { validateOnly: true });
  const custom = join(h.runs, 'custom.json');
  await save(custom, { attemptModels: ['terra-6.1-medium'], apiConcurrency: 12,
    queues: { server: { concurrency: 8 } } });
  const missionId = (await h.command({ action: 'add', query: 'Custom settings', argv: ['--mission', 'Custom settings',
    '--config', h.configPath, `--config=${custom}`, '--model=astra-6-max', '--codex-concurrency', '5', '--max-remote-jobs=60'] })).result.missionId;
  const before = (await h.control.state({ missionId })).selected.configSettings;
  assert.equal(before.path, custom);
  assert.deepEqual(before.values.attemptModels, ['terra-6.1-medium']);
  assert.equal(before.overrides['--model'], 'astra-6-max');
  const result = await h.command({ action: 'set-runtime-settings', missionId, configRevision: before.configRevision,
    settings: { attemptModels: ['sol-6.1-high'], queues: { CODEX: { concurrency: 3 }, SERVER: { concurrency: 8 } }, maxRemoteJobs: 42 } });
  assert.equal(result.status, 'APPLIED', result.error);
  assert.deepEqual((await readJson(custom)).attemptModels, ['sol-6.1-high']);
  assert.equal((await readJson(h.configPath)).attemptModels[0], 'astra-6.2-max');
  const argv = h.control.findMission(missionId).argv;
  assert.ok(argv.includes(`--config=${custom}`));
  assert.ok(!argv.some(value => /^--(model|codex-concurrency|max-remote-jobs)(=|$)/.test(value)));
  const next = await main(argv, { validateOnly: true });
  assert.equal(next.options.pipeline.queues.CODEX.concurrency, 3);
  assert.equal(next.options.pipeline.maxRemoteJobs, 42);
  assert.equal(next.options.model, undefined);
});

test('file edits appear immediately, stale live saves reject, and pending changes compare with the actual runner', async t => {
  const h = await fixture(t);
  const missionId = (await h.command({ action: 'add', query: 'Running settings', start: true })).result.missionId;
  const p = new Pipeline({}, { root: 'live-root' }, { runs: h.runs, configPath: h.configPath,
    pipeline: (await readRunnerConfig(h.configPath)).values });
  await p.operator.load();
  const child = h.children[0];
  child.emit('message', { type: 'target', target: { root: 'live-root', name: 'Running settings' } });
  child.emit('message', { type: 'ready', runId: p.runId, limits: structuredClone(p.limits) });
  await h.control.writer;
  child.send = message => {
    if (message.type === 'stop') queueMicrotask(() => child.emit('exit', 0));
    else p.operator.execute(message.command).then(
      receipt => child.emit('message', { type: 'receipt', id: message.command.id, receipt }),
      error => child.emit('message', { type: 'receipt', id: message.command.id, error: error.message }));
  };
  const before = (await h.control.state({ missionId })).selected.configSettings;
  const edited = await readJson(h.configPath);
  edited.attemptModels = ['sol-6.1-high'];
  edited.apiConcurrency++;
  await save(h.configPath, edited);
  const updated = (await h.control.state({ missionId })).selected.configSettings;
  assert.equal(updated.pending, true);
  assert.deepEqual(updated.values.attemptModels, ['sol-6.1-high']);
  assert.deepEqual(updated.runningValues.attemptModels, before.values.attemptModels);
  assert.deepEqual(p.limits.attemptModels, before.values.attemptModels);
  const stale = await h.command({ action: 'set-runtime-settings', missionId, runId: p.runId, controlRevision: 0,
    configRevision: before.configRevision, settings: { attemptModels: ['astra-6-max'] } });
  assert.equal(stale.status, 'REJECTED');
  assert.match(stale.error, /Configuration file changed/);
  assert.equal(p.operator.state.revision, 0);
  assert.deepEqual((await readJson(h.configPath)).attemptModels, ['sol-6.1-high']);
  const fresh = await h.command({ action: 'set-runtime-settings', missionId, runId: p.runId, controlRevision: 0,
    configRevision: updated.configRevision, settings: { attemptModels: ['sol-6.1-high'] } });
  assert.equal(fresh.status, 'APPLIED', fresh.error);
  const after = (await h.control.state({ missionId })).selected.configSettings;
  assert.deepEqual(after.changedKeys, ['apiConcurrency']);
  assert.deepEqual(p.limits.attemptModels, ['sol-6.1-high']);
  const controls = await readJson(p.operator.path);
  assert.equal(Object.hasOwn(controls, 'runtimeSettings'), false);
  assert.equal(Object.hasOwn(controls, 'promptVariant'), false);
});

test('admission and Codex/research dispatch obey independent operator gates without changing quota', async t => {
  const h = await fixture(t);
  const p = new Pipeline({}, { root: 'root' }, { runs: h.runs });
  assert.equal(p.canAdmit(new Map()), true);
  p.operator.state.admissionPaused = true; assert.equal(p.canAdmit(new Map()), false);
  p.operator.state.admissionPaused = false; p.operator.state.dispatchPaused = true;
  assert.equal(p.canAdmit(new Map()), true, 'dispatch pause does not implicitly pause admission');
  let dispatched = false;
  const job = await p.store.ensure('leaf');
  Object.assign(job, { job_status: 'ACTIVE', stage: 'CODEX', operation: 'implement', dispatch_state: 'QUEUED' });
  await p.store.replace(job, job.revision);
  p.controls.set('leaf', { waiting: { state: job, resolve: () => { dispatched = true; }, reject: assert.fail,
    persist: async () => { await p.store.replace(job, job.revision); } } });
  await p.routeAndDispatch(); assert.equal(dispatched, false);
  assert.equal(p.quota.state, null);
  p.operator.state.dispatchPaused = false;
  await p.routeAndDispatch(); assert.equal(dispatched, true);
});

test('results deduplicate server IDs, filter verdict observations, exclude corrected attempts, and honor event root attribution', () => {
  const at = '2026-10-27T10:00:00Z';
  const graph = { root: { theorem_id: 'root', status: 'Open', reductions: [] }, nodes: [{ theorem_id: 'leaf', theorem_name: 'Bridge', status: 'Open', reductions: [] }], leaves: [] };
  const events = [
    { event_id: 'a', event_type: 'attempt', attempt: 1, attempt_id: 'a', root_id: 'root', result: 'proof_accepted', submission_id: 'sub-1', observed_at: at },
    { event_id: 'duplicate', event_type: 'attempt', attempt: 2, attempt_id: 'b', root_id: 'root', result: 'proof_accepted', submission_id: 'sub-1', observed_at: at },
    { event_id: 'child', event_type: 'attempt', attempt: 3, attempt_id: 'c', root_id: 'root', result: 'disproof_accepted', submission_id: 'sub-2', observed_at: at },
    { event_id: 'other', event_type: 'attempt', attempt: 4, attempt_id: 'd', root_id: 'other-root', result: 'proof_accepted', submission_id: 'sub-3', observed_at: at },
    { event_id: 'corrected', event_type: 'attempt', attempt: 5, attempt_id: 'e', root_id: 'root', result: 'proof_accepted', submission_id: 'sub-4', observed_at: at },
    { event_id: 'exclusion', event_type: 'attempt_exclusion', attempt: 5 },
    { event_type: 'attempt', attempt: 6, root_id: 'root', result: 'sketch_accepted', submission_id: 'sketch-1', observed_at: at },
    { event_type: 'attempt', attempt: 7, root_id: 'root', result: 'sketch_accepted', submission_id: 'sketch-1', observed_at: at },
    { event_type: 'attempt', attempt: 8, root_id: 'root', result: 'sketch_accepted', submission_id: 'sketch-2', observed_at: at },
    { event_type: 'attempt', attempt: 9, root_id: 'root', result: 'sketch_accepted', submission_id: 'old-sketch', observed_at: '2026-10-26T10:00:00Z' },
    { event_type: 'attempt', attempt: 10, root_id: 'other-root', result: 'sketch_accepted', submission_id: 'other-sketch', observed_at: at },
  ];
  const view = buildMissionView({ mission: { target: { root: 'root' } }, summary: { target: { root: 'root' }, root_status: 'Open' }, graph,
    jobs: [{ theorem_id: 'leaf', history: events, job_id: 'job', status: 'SUBMISSION_UNKNOWN', remote_operations: [{ operation_id: 'op', status: 'SUBMITTING' }] }],
    since: Date.parse('2026-10-27T09:00:00Z'), until: Date.parse('2026-10-27T11:00:00Z') });
  assert.equal(view.counts.proofs, 1); assert.equal(view.counts.disproofs, 1);
  assert.equal(view.counts.proved_theorems, 1); assert.equal(view.counts.unknown, 1);
  assert.equal(view.counts.reductions, 2); assert.equal(view.counts.sketched_theorems, 1);
  assert.equal(view.summary.root_status, 'Open', 'a child disproof is not a root outcome');
  assert.equal(JSON.stringify(view.results).includes('sub-3'), false); assert.equal(JSON.stringify(view.results).includes('sub-4'), false);
});

test('account sampler deduplicates reads and retains previous percentages after failure', async t => {
  const h = await fixture(t);
  let reads = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const sample = h.control.sampleLimits;
  h.control.sampleLimits = async () => { reads++; await gate; return sample(); };
  const first = h.control.checkLimits(), second = h.control.checkLimits();
  release(); await Promise.all([first, second]); assert.equal(reads, 1);
  const checked = h.control.account.checkedAt;
  h.control.sampleLimits = async () => { throw new Error('Reader unavailable'); };
  await h.control.checkLimits();
  assert.equal(h.control.account.windows.primary.used_percent, 34);
  assert.equal(h.control.account.checkedAt, checked); assert.equal(h.control.account.error, 'Reader unavailable');
});

test('delayed infrastructure failures and readiness logs remain visible without exposing arbitrary files', async t => {
  const h = await fixture(t);
  const jobs = [{ theorem_id: 'leaf', root_id: 'root', job_status: 'ACTIVE', stage: 'PREPARE',
    dispatch_state: 'DELAYED', infrastructure_wait: 'Windows sandbox resources unavailable' }];
  const build = () => buildMissionView({ mission: { target: { root: 'root' } }, jobs });
  assert.equal(build().jobs[0].waiting_reason, jobs[0].infrastructure_wait);
  jobs[0].dispatch_state = 'RUNNING';
  assert.equal(build().jobs[0].waiting_reason, null, 'a running retry is not reported as blocked');
  await mkdir(join(h.runs, 'leaf'));
  await writeFile(join(h.runs, 'leaf', 'environment-3-1.log'), '0x800705AA');
  await writeFile(join(h.runs, 'leaf', 'failure-3.json'), '{"feedback":"dependency disproved"}');
  await writeFile(join(h.runs, 'leaf', 'private.txt'), 'not an artifact');
  const names = (await artifactList(h.runs, 'leaf')).map(row => row.name);
  assert.ok(names.includes('environment-3-1.log'));
  assert.ok(names.includes('failure-3.json'));
  assert.ok(!names.includes('private.txt'));
  assert.equal((await readArtifact(h.runs, 'leaf', 'environment-3-1.log')).content, '0x800705AA');
});

test('HTTP session authentication, same-origin/CSRF checks, static isolation, export, and artifact boundaries', async t => {
  const h = await fixture(t);
  const app = await createMissionControlServer({ port: 0, control: h.control, sampling: false });
  t.after(() => new Promise(resolve => app.server.close(resolve)));
  const request = (path, init) => fetch(app.address + path, init);
  assert.equal((await request('/')).status, 200);
  assert.equal((await request('/api/state')).status, 401);
  assert.equal((await request('/api/diagnostics?missionId=missing')).status, 401);
  const token = new URL(app.url).hash.split('=')[1];
  const session = await request('/api/session', { method: 'POST', headers: { Origin: app.address, Authorization: `Bearer ${token}` } });
  assert.equal(session.status, 200);
  const cookie = session.headers.get('set-cookie').split(';')[0];
  const { csrf } = await session.json();
  const headers = { Cookie: cookie, Origin: app.address, 'X-CSRF-Token': csrf };
  assert.equal((await request('/api/state', { headers })).status, 200);
  for (const path of ['/model-picker.js', '/mission-settings.js']) {
    const module = await request(path);
    assert.equal(module.status, 200);
    assert.match(module.headers.get('content-type'), /text\/javascript/);
  }
  assert.equal((await request('/api/command', { method: 'POST', headers: { ...headers, Origin: 'https://evil.example' }, body: '{}' })).status, 403);
  assert.equal((await request('/api/command', { method: 'POST', headers: { Cookie: cookie, Origin: app.address }, body: '{}' })).status, 403);
  assert.equal((await request('/api/command', { method: 'POST', headers, body: JSON.stringify({ argv: ['--credentials', 'elsewhere'] }) })).status, 400);
  assert.equal((await request('/credentials.json', { headers })).status, 404);
  assert.equal((await request('/api/artifacts?missionId=missing&theorem=leaf&name=context.json', { headers })).status, 404);
  assert.equal((await request('/api/export', { headers })).status, 400);
  const added = await request('/api/command', { method: 'POST', headers, body: JSON.stringify({ id: randomUUID(), revision: h.control.registry.revision, action: 'add', query: 'From browser', start: false }) });
  const receipt = await added.json(); assert.equal(receipt.status, 'APPLIED');
  const exported = await request(`/api/export?missionId=${receipt.result.missionId}`, { headers });
  assert.equal(exported.status, 200);
  assert.equal(JSON.stringify(await exported.json()).includes('argv'), false);
  assert.equal((await request('/api/diagnostics?missionId=missing', { headers })).status, 404);
  const diagnostics = await request(`/api/diagnostics?missionId=${receipt.result.missionId}`, { headers });
  assert.equal(diagnostics.status, 200);
  assert.equal(diagnostics.headers.get('cache-control'), 'no-store');
  const report = await diagnostics.json();
  assert.equal(report.filename, 'leaf-runner-diagnostics.txt');
  assert.equal(JSON.parse(report.content).mission.id, receipt.result.missionId);
  assert.equal(report.content.includes('argv'), false);
});

test('artifacts are bounded, redaction removes credentials, and paths outside the job are rejected', async t => {
  const h = await fixture(t);
  await mkdir(join(h.runs, 'leaf'));
  await writeFile(join(h.runs, 'leaf', 'codex-1.log'), 'x'.repeat(300000) + 'Bearer abc.secret.token');
  const artifact = await readArtifact(h.runs, 'leaf', 'codex-1.log');
  assert.equal(artifact.truncated, true); assert.equal(artifact.content.length, 256 * 1024);
  assert.match(redact(artifact.content), /Bearer \[REDACTED\]/);
  assert.equal(redact('private abcdefghijkl secret', ['abcdefghijkl']), 'private [REDACTED] secret');
  await assert.rejects(readArtifact(h.runs, '..', 'context.json'), /Unknown artifact/);
  await assert.rejects(readArtifact(h.runs, 'leaf', '../credentials.json'), /Unknown artifact/);
  await writeFile(join(h.runs, 'credentials.json'), '{}');
  try {
    await symlink(join(h.runs, 'credentials.json'), join(h.runs, 'leaf', 'answer-2.json'));
    await assert.rejects(readArtifact(h.runs, 'leaf', 'answer-2.json'), /Unknown artifact|outside/);
  } catch (error) { if (error.code !== 'EPERM') throw error; }
});

test('saved missions are restored without starting processes and retain their own checkpoints', async t => {
  const h = await fixture(t);
  const target = { root: 'root', name: 'Saved mission', kind: 'mission', mission: { id: 'm', name: 'Saved mission' } };
  await save(join(h.runs, 'last-run.json'), { target, run_id: 'old', status: 'RUNNING', root_status: 'Open', updated_at: '2026-10-27T10:00:00Z' });
  const restored = new MissionControl({ runs: h.runs }); await restored.init();
  const saved = (await restored.state()).missions[0];
  assert.equal(saved.mission.running, false); assert.equal(saved.rootStatus, 'Open');
  await restored.archiveCurrent();
  await save(join(h.runs, 'last-run.json'), { target: { root: 'other' }, status: 'RUNNING' });
  restored.cache = null;
  const view = (await restored.state({ missionId: saved.mission.id })).selected;
  assert.equal(view.summary.run_id, 'old');
  assert.equal((await readJson(join(h.runs, 'mission-control', 'registry.json'))).missions.length, 1);
});

test('two web supervisors cannot own the same registry, even on different ports', async t => {
  const h = await fixture(t);
  const app = await createMissionControlServer({ control: h.control, port: 0, sampling: false });
  t.after(() => new Promise(resolve => app.server.close(resolve)));
  const duplicate = new MissionControl({ runs: h.runs });
  await assert.rejects(createMissionControlServer({ control: duplicate, port: 0, sampling: false }), /already owns this checkout/);
});

test('restoring duplicate roots keeps one mission and preserves links to both entries', async t => {
  const h = await fixture(t);
  const target = { root: 'root', name: 'Same mission', kind: 'mission', id: 'mission', mission: { id: 'mission', name: 'Same mission' } };
  await save(h.control.path, { revision: 3, missions: [
    { id: 'saved-root', name: target.name, target, status: 'SAVED', argv: ['--mission-id', 'mission'] },
    { id: 'managed', name: target.name, target, status: 'RUNNING', argv: ['--mission', target.name] },
  ] });
  const restored = new MissionControl({ runs: h.runs }); await restored.init();
  for (const missionId of ['saved-root', 'managed']) {
    const state = await restored.state({ missionId });
    assert.equal(state.missions.length, 1);
    assert.equal(state.selected.mission.id, 'managed');
    assert.equal(state.totals.uniqueOpenLeaves, null, 'unobserved graphs are not zero open leaves');
  }
  const again = new MissionControl({ runs: h.runs }); await again.init();
  assert.equal((await again.state({ missionId: 'saved-root' })).selected.mission.id, 'managed');
});

test('adding a saved mission by name reuses its ID and starts with the requested arguments', async t => {
  const h = await fixture(t);
  const target = { root: 'root', name: 'Same mission', kind: 'mission', id: 'mission', mission: { id: 'mission', name: 'Same mission' } };
  h.control.registry.missions.push({ id: 'saved-root', name: target.name, target, status: 'SAVED', argv: ['--mission-id', 'mission'] });
  await h.control.persist();
  const receipt = await h.command({ action: 'add', query: target.name, start: true, argv: ['--mission', target.name, '--model', 'gpt-6-luna'] });
  assert.equal(receipt.status, 'APPLIED');
  assert.equal(receipt.result.missionId, 'saved-root');
  assert.equal(h.control.registry.missions.length, 1);
  assert.deepEqual(h.children[0].argv, ['--mission', target.name, '--model', 'gpt-6-luna', '--config', h.configPath]);
});

test('target resolution merges name or URL aliases into the managed entry without losing its process', async t => {
  const h = await fixture(t);
  const target = { root: 'root', name: 'Same mission', kind: 'mission', mission: { id: 'mission', name: 'Same mission' } };
  h.control.registry.missions.push({ id: 'saved-root', name: target.name, target, status: 'SAVED', argv: ['--mission-id', 'mission'] });
  await h.control.persist();
  const receipt = await h.command({ action: 'add', query: 'https://prove2.me/missions/Same_mission', start: true });
  h.children[0].emit('message', { type: 'target', target });
  await h.control.writer;
  h.children[0].emit('message', { type: 'ready', runId: 'run' });
  await h.control.writer;
  const state = await h.control.state({ missionId: 'saved-root' });
  assert.equal(state.missions.length, 1);
  assert.equal(state.selected.mission.id, receipt.result.missionId);
  assert.equal(state.selected.mission.managed, true);
  assert.equal(state.selected.mission.running, true);
  const pause = await h.command({ action: 'pause-admission', missionId: 'saved-root', runId: 'run', controlRevision: 0 });
  assert.equal(pause.status, 'APPLIED');
});

test('successive observations refresh graph counts, results and active theorems without a registry event', async t => {
  const h = await fixture(t);
  const target = { root: 'root', name: 'Live mission', kind: 'mission', mission: { id: 'mission', name: 'Live mission' } };
  const receipt = await h.command({ action: 'add', query: target.name, start: true });
  const missionId = receipt.result.missionId;
  h.children[0].emit('message', { type: 'target', target }); await h.control.writer;
  h.children[0].emit('message', { type: 'ready', runId: 'run' }); await h.control.writer;
  const revision = h.control.registry.revision;
  const leaf = { theorem_id: 'leaf', theorem_name: 'Bridge theorem', status: 'Open', reductions: [] };
  const root = { theorem_id: 'root', theorem_name: 'Root', status: 'Open', reductions: [{ submission_id: 'reduction', children: [leaf] }] };
  const graph = { root, nodes: [root, leaf], leaves: [leaf], updated_at: '2026-10-27T10:00:00Z' };
  const summary = { target, run_id: 'run', started_at: '2026-01-01T00:00:00Z', root_status: 'Open',
    live_workers: [{ theorem_id: 'leaf', stage: 'CODEX', model: 'gpt-6-luna' }] };
  const job = { theorem_id: 'leaf', root_id: 'root', run_id: 'run', job_status: 'ACTIVE', stage: 'CODEX', dispatch_state: 'RUNNING', history: [] };
  await save(join(h.runs, 'graphs', 'root.json'), graph);
  await save(join(h.runs, 'last-run.json'), summary);
  await save(join(h.runs, 'leaf', 'state.json'), job);
  const first = await h.control.state({ missionId });
  assert.equal(first.selected.frontier.leaves, 1);
  assert.equal(first.missions[0].currentWork[0].running, true);
  assert.equal(first.missions[0].currentWork[0].theorem_name, 'Bridge theorem');

  const nextLeaf = { theorem_id: 'next', theorem_name: 'New bridge', status: 'Open', reductions: [] };
  leaf.status = 'Proved'; root.reductions[0].children.push(nextLeaf);
  graph.nodes.push(nextLeaf); graph.leaves = [nextLeaf]; graph.updated_at = '2026-10-27T10:00:04Z';
  Object.assign(job, { job_status: 'DONE', status: 'ACCEPTED', history: [{ event_type: 'attempt', event_id: 'accepted',
    attempt: 1, attempt_id: 'attempt', result: 'proof_accepted', submission_id: 'proof', root_id: 'root', observed_at: new Date().toISOString() }] });
  job.history.push(...['sketch-1', 'sketch-1', 'sketch-2'].map((submission_id, index) => ({
    event_type: 'attempt', attempt: index + 2, result: 'sketch_accepted', submission_id,
    root_id: 'root', observed_at: new Date().toISOString(),
  })));
  await save(join(h.runs, 'graphs', 'root.json'), graph);
  await save(join(h.runs, 'leaf', 'state.json'), job);
  await save(join(h.runs, 'next', 'state.json'), { ...job, theorem_id: 'next', job_status: 'ACTIVE', status: 'PREPARED',
    history: [], dispatch_state: 'QUEUED' });
  const next = await h.control.state({ missionId });
  assert.deepEqual(next.selected.frontier.leafIds, ['next']);
  assert.equal(next.selected.graph.observed_at, graph.updated_at);
  assert.equal(next.selected.counts.proofs, 1);
  assert.equal(next.totals.sketches, 2);
  assert.equal(next.totals.sketched_theorems, 1);
  assert.equal(next.selected.counts.reductions, 2);
  assert.equal(next.selected.counts.sketched_theorems, 1);
  assert.equal(next.selected.jobs.find(j => j.theorem_id === 'leaf').running, false, 'old worker checkpoint cannot keep a finished job running');
  assert.deepEqual(next.missions[0].currentWork.map(j => j.theorem_name), ['New bridge']);
  assert.equal(h.control.registry.revision, revision);
  nextLeaf.status = 'Proved';
  await save(join(h.runs, 'graphs', 'root.json'), graph);
  assert.equal((await h.control.state({ missionId })).selected.frontier.leaves, 0);
});

for (const action of ['pause-dispatch', 'stop-agents']) test(`${action} arriving during dispatch persistence releases the slot without invoking a model`, async t => {
  const h = await fixture(t);
  const p = new Pipeline({}, { root: 'root' }, { runs: h.runs });
  const job = await p.store.ensure('leaf');
  Object.assign(job, { job_status: 'ACTIVE', stage: 'CODEX', operation: 'implement', dispatch_state: 'QUEUED' });
  await p.store.replace(job, job.revision);
  let dispatched = 0, interruptSave = true;
  const control = { waiting: { state: job, resolve: () => { dispatched++; }, reject: assert.fail, persist: async () => {
    await p.store.replace(job, job.revision);
    if (interruptSave) {
      interruptSave = false;
      await p.operator.execute({ id: randomUUID(), action, runId: p.runId, revision: 0 });
    }
  } } };
  p.controls.set('leaf', control);
  await p.routeAndDispatch();
  assert.equal(dispatched, 0); assert.equal(p.counts(await p.store.index()).queues.CODEX.running, 0);
  await p.operator.execute({ id: randomUUID(), action: action === 'stop-agents' ? 'resume-agents' : 'resume-dispatch', runId: p.runId, revision: 1 });
  await p.routeAndDispatch(); assert.equal(dispatched, 1);
});

test('sandbox recovery and elevated failure logs are available in the artifact inspector', async t => {
  const { runs } = await fixture(t), id = 'leaf';
  await mkdir(join(runs, id), { recursive: true });
  for (const file of ['environment-15-3-elevated.log', 'environment-codex-recovery-unelevated.log']) {
    await writeFile(join(runs, id, file), 'sandbox diagnostic');
  }
  assert.deepEqual((await artifactList(runs, id)).map(x => x.name),
    ['environment-15-3-elevated.log', 'environment-codex-recovery-unelevated.log']);
  assert.equal((await readArtifact(runs, id, 'environment-codex-recovery-unelevated.log')).content, 'sandbox diagnostic');
});

test('preparation retry waits expose the saved error and retry time even with zero active jobs', () => {
  const job = { theorem_id: 'leaf', root_id: 'root', job_status: 'READY', stage: 'PREPARE',
    retry_after: new Date(Date.now() + 60000).toISOString(),
    recovery_failure: { message: 'Cannot copy Mathlib', stage: 'PREPARE', operation: 'reconstruct', code: 'ENOSPC', count: 6 } };
  const build = () => buildMissionView({ mission: { running: true, target: { root: 'root' } }, jobs: [job] }).jobs[0];
  assert.equal(build().running, false);
  assert.equal(build().preparation, null);
  assert.equal(build().next_poll_at, job.retry_after);
  assert.match(build().waiting_reason, /Previous PREPARE failure \(ENOSPC\): Cannot copy Mathlib/);
  delete job.recovery_failure.stage; delete job.recovery_failure.code;
  assert.match(build().waiting_reason, /Previous job failure: Cannot copy Mathlib/, 'legacy saved errors are visible too');
  job.retry_after = new Date(Date.now() - 1).toISOString();
  assert.equal(build().waiting_reason, null, 'expired waits no longer block the UI');
  job.retry_after = new Date(Date.now() + 60000).toISOString(); job.job_status = 'ACTIVE';
  assert.equal(build().waiting_reason, null, 'a new claim does not show the previous retry wait');
});

test('workspace progress belongs only to a matching live preparation worker', () => {
  const preparation = { phase: 'copy', message: 'Copying Mathlib', files_copied: 120, bytes_copied: 1024,
    started_at: new Date().toISOString(), updated_at: new Date().toISOString(), private_path: 'must not expose' };
  const mission = { running: true, target: { root: 'root' } };
  const job = { theorem_id: 'leaf', root_id: 'root', run_id: 'run', stage: 'PREPARE', job_status: 'ACTIVE', dispatch_state: 'RUNNING' };
  const worker = { theorem_id: 'leaf', stage: 'PREPARE', preparation };
  const summary = { run_id: 'run', live_workers: [worker] };
  const build = () => buildMissionView({ mission, summary, jobs: [job] }).jobs[0];
  assert.equal(build().preparation.files_copied, 120);
  assert.equal(build().preparation.private_path, undefined);
  mission.running = false; assert.equal(build().preparation, null); mission.running = true;
  job.run_id = 'old'; assert.equal(build().preparation, null); job.run_id = 'run';
  job.dispatch_state = 'QUEUED'; assert.equal(build().preparation, null); job.dispatch_state = 'RUNNING';
  job.stage = worker.stage = 'CODEX'; assert.equal(build().preparation, null);
});

test('publication operations are counted distinctly and delayed jobs and handoffs remain single rows', () => {
  const view = buildMissionView({ mission: { target: { root: 'root' } }, graph: null, summary: { target: { root: 'root' } }, jobs: [{
    theorem_id: 'leaf', root_id: 'root', job_id: 'job', status: 'PUBLISH_PENDING', job_status: 'ACTIVE', dispatch_state: 'HANDOFF_PENDING',
    publications: { childA: { status: 'PENDING', job_id: 'pub-a', operations: [{ operation_id: 'op-a', job_id: 'pub-a', status: 'PENDING' }] },
      childB: { status: 'UNKNOWN', operations: [{ operation_id: 'op-b', status: 'UNKNOWN' }] },
      done: { status: 'PUBLISHED', job_id: 'pub-done' } },
  }] });
  assert.equal(view.jobs.length, 1); assert.equal(view.counts.pending, 2); assert.equal(view.counts.unknown, 1);
});

test('real managed child acknowledges a coordinator pause then stops, checkpoints, disconnects and releases its lock', { timeout: 15000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'mission-control-child-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = new URL('../', import.meta.url);
  for (const entry of await readdir(source)) if (entry.endsWith('.mjs') || entry === 'runner-config.json') {
    await copyFile(new URL(entry, source), join(root, entry));
  }
  const script = `
    import { main } from './prove2me.mjs';
    globalThis.fetch = async url => {
      let body;
      if (url.pathname.endsWith('/agent/refresh')) body = { access_token: 'test-token', expires_at: Date.now() / 1000 + 3600 };
      else if (url.pathname.endsWith('/missions')) body = { missions: [{ id: 'mission', name: 'Target', main_theorem: { theorem_id: 'root' } }], total: 1 };
      else if (url.pathname.endsWith('/theorems/root')) body = { theorem_id: 'root', theorem_name: 'Root', status: 'Open', formal_statement: 'True' };
      else if (url.pathname.endsWith('/root/decompositions')) body = { decompositions: [{ submission_id: 'reduction', children: [{ theorem_id: 'proved', theorem_name: 'Proved child', status: 'Proved' }] }] };
      else throw new Error('Unexpected network/model activity: ' + url.pathname);
      return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
    };
    await main(['--mission', 'Target', '--codex', process.execPath, '--verification-mode', 'server-only']).catch(() => {});
  `;
  await writeFile(join(root, 'fixture.mjs'), script);
  const child = fork(join(root, 'fixture.mjs'), [], { cwd: root, windowsHide: true,
    env: { ...process.env, PROVE2ME_API_KEY: 'test-key' }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const exited = once(child, 'exit');
  let diagnostics = ''; child.stderr.on('data', bytes => { diagnostics += bytes; });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const waitMessage = predicate => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.off('message', listener); reject(new Error(`Child IPC timed out: ${diagnostics}`)); }, 6000);
    const listener = message => { if (predicate(message)) { clearTimeout(timer); child.off('message', listener); resolve(message); } };
    child.on('message', listener);
  });
  const ready = await waitMessage(message => message.type === 'ready');
  const receiptPromise = waitMessage(message => message.type === 'receipt');
  child.send({ type: 'command', command: { id: 'pause-command', runId: ready.runId, revision: 0, action: 'pause-admission' } });
  const receipt = await receiptPromise;
  assert.equal(receipt.error, undefined, diagnostics + JSON.stringify(receipt));
  assert.equal(receipt.receipt.status, 'APPLIED');
  child.send({ type: 'stop' });
  await exited;
  const summary = await readJson(join(root, '.runs', 'last-run.json'));
  assert.equal(summary.status, 'INTERRUPTED', diagnostics + summary.error); assert.equal(summary.operator.admissionPaused, true);
  await assert.rejects(access(join(root, '.runs', 'runner.lock')), { code: 'ENOENT' });
});
