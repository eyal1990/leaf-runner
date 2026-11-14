import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTarget, Client, ApiError } from '../prove2me.mjs';
import { Pipeline, pipelineLimits, neededTheorems } from '../pipeline.mjs';
import { JobStore, JobPersistenceError } from '../job-store.mjs';
import { RetiredJob } from '../serial-jobs.mjs';
import { WorkSelection } from '../work-selection.mjs';
import { CodexQuotaError, codexQuotaFailure, QUOTA_CHECK_INTERVAL as HOUR } from '../codex-quota.mjs';
import { validHistory } from '../attempt-history.mjs';
import defaults from '../runner-config.json' with { type: 'json' };
import { readJson } from '../runner-state.mjs';
import { ProofStoragePaused } from '../proof-storage-recovery.mjs';

const barrier = () => {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  return { promise, release };
};

for (const formatting of [false, true]) for (const restart of [false, true]) {
  test(`stop agents cancels ${formatting ? 'formatting' : 'proof'} work while validation and server work drain${restart ? ' across restart' : ''}`, async t => {
    const h = await fixture(t, ['a', 'b']), validation = barrier();
    let p, started = false, cancelled = false, drained = false, calls = 0, validationSignal;
    h.hooks.onControlReady = pipeline => { p = pipeline; };
    const generate = h.hooks.agent;
    const partial = 'theorem solution : True := by\n  trivial\n';
    h.hooks.command = async (_exe, _args, options) => {
      if (!formatting && options.cwd.includes('workspace-a')) { validationSignal = options.signal; await validation.promise; }
    };
    const interrupt = async (workspace, dir, attempt, options) => {
      calls++;
      if (calls > 1) {
        if (!formatting) assert.equal(await readFile(join(workspace, 'Solutions/Sol_b.lean'), 'utf8'), partial);
        return;
      }
      if (!formatting) {
        await writeFile(join(workspace, 'Solutions/Sol_b.lean'), partial);
        await writeFile(join(dir, `solution-${attempt}.lean`), partial);
      }
      started = true;
      await new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => {
        cancelled = true; reject(options.signal.reason);
      }, { once: true }));
    };
    h.hooks.agent = async (...args) => {
      if (args[0].theorem_id !== 'b') return generate(...args);
      if (!formatting) await interrupt(args[1], args[2], args[3], args[5]);
      const candidate = await generate(...args);
      return formatting ? { ...candidate, explanation: '' } : candidate;
    };
    h.hooks.repairAnswer = async (_target, workspace, dir, attempt, _feedback, candidate, options) => {
      await interrupt(workspace, dir, attempt, options);
      return { ...candidate, explanation: 'Trivial.' };
    };
    const poll = h.hooks.poll;
    h.hooks.poll = async (...args) => {
      if (formatting && args[1] === 'sub-a') { validationSignal = p.signal; await validation.promise; }
      if (args[1] === 'sub-a') { assert.equal(p.operator.state.agentsStopped, true); drained = true; }
      return poll(...args);
    };
    const command = action => p.operator.execute({ id: `cmd-${p.operator.state.revision}`, action,
      runId: p.runId, revision: p.operator.state.revision });
    let run = h.run(), controller = h.controller;
    try {
      await until(() => started && validationSignal);
      await command('stop-agents');
      assert.equal(cancelled, true);
      assert.equal(validationSignal.aborted, false);
      assert.equal(p.signal.aborted, false);
      validation.release();
      await until(async () => drained && (await h.store.read('b'))?.operator_dispatch_wait && !p.controls.get('b')?.running);
      assert.equal(calls, 1);
      const saved = await h.store.read('b'), attemptId = saved.attempt_id;
      assert.equal(saved.attempt_count, 1);
      assert.equal(saved.history.filter(e => e.result === 'interrupted').length, 0);
      if (restart) {
        controller.abort(new Error('restart stopped agents')); await assert.rejects(run, /restart stopped agents/);
        controller = new AbortController(); h.options.signal = controller.signal;
        p = null; run = h.run();
        await until(() => p?.operator.state.agentsStopped);
        assert.equal(calls, 1);
      }
      await command('resume-agents');
      assert.equal((await run).completed, true);
      const finished = await h.store.read('b');
      assert.equal(finished.attempt_id, attemptId);
      assert.equal(finished.attempt_count, 1);
      assert.equal(calls, 2);
    } finally { validation.release(); controller.abort(new Error('cleanup')); await run.catch(() => {}); }
  });
}

test('stop agents cancels research without publishing it and allows the same review after resume', async t => {
  const h = await fixture(t, ['a']), validation = barrier();
  h.options.pipeline.missionReviewEvery = 1;
  let p, started = 0, cancelled = false;
  h.hooks.onControlReady = pipeline => { p = pipeline; };
  h.hooks.command = async () => validation.promise;
  h.hooks.reviewMission = async (_request, { signal }) => {
    started++;
    if (started === 1) await new Promise((_resolve, reject) => signal.addEventListener('abort', () => {
      cancelled = true; reject(signal.reason);
    }, { once: true }));
    return { notes: 'Useful review.', resources: [] };
  };
  const run = h.run();
  try {
    await until(() => started === 1);
    const stop = { id: 'stop-research', action: 'stop-agents', runId: p.runId, revision: 0 };
    await p.operator.execute(stop); await p.operator.execute(stop);
    await until(() => !p.reviewing);
    assert.equal(cancelled, true); assert.equal(p.research.state.latest, null);
    assert.equal(p.researchError, undefined); assert.equal(started, 1);
    await p.operator.execute({ id: 'resume-research', action: 'resume-agents', runId: p.runId, revision: 1 });
    await until(() => p.research.state.latest);
    assert.equal(started, 2);
    validation.release(); assert.equal((await run).completed, true);
  } finally { validation.release(); h.controller.abort(new Error('cleanup')); await run.catch(() => {}); }
});

for (const restart of [false, true]) test(`proof storage failures pause all new Codex work until every saved proof recovers${restart ? ' across restart' : ''}`, async t => {
  const h = await fixture(t, ['a', 'b', 'c', 'd']);
  h.options.verificationMode = 'server-only';
  h.options.pipeline = { maxActiveJobs: 2, maxRemoteJobs: 2, missionReviewEvery: 0, queues: { codex: { concurrency: 1 } } };
  h.options.recovery = { initialDelayMs: 10, maxDelayMs: 40 };
  let clock = 1800000000000, pipeline;
  h.hooks.now = () => clock;
  h.hooks.onControlReady = p => { pipeline = p; };
  const generate = h.hooks.agent, uploads = [], counts = new Map(), completed = new Set();
  h.hooks.agent = async (...args) => {
    assert.equal(pipeline.proofStorageRecovery.waiting, false, 'no proof, repair or formatting invocation during storage recovery');
    return generate(...args);
  };
  h.client.submit = async (id, source, explanation, mode) => {
    const count = (counts.get(id) ?? 0) + 1; counts.set(id, count);
    uploads.push({ id, source, explanation, mode });
    return { submission_id: `sub-${id}-${count}` };
  };
  h.hooks.poll = async (_client, submissionId) => {
    const [, id, number] = submissionId.split('-');
    if (['a', 'b'].includes(id)) {
      if (number === '1') {
        await until(() => h.models.length >= 2);
        return { status: 'ERROR', error_message: 'Could not enqueue the submission: could not store the proof file: Gateway Timeout. Retry unchanged.' };
      }
      if (!completed.has(id)) return { status: 'PENDING' };
    }
    h.done.add(id); return { status: 'ACCEPTED' };
  };
  let controller = h.controller, run = h.run();
  try {
    await until(() => pipeline?.proofStorageRecovery.jobs.size === 2);
    assert.equal(h.models.length, 2);
    assert.equal(pipeline.canAdmit(await h.store.index()), false);
    await pipeline.checkpoint();
    assert.equal((await readJson(join(h.runs, 'last-run.json'))).proof_storage_recovery.waiting, true);
    if (restart) {
      controller.abort(new Error('storage restart'));
      await assert.rejects(run, /storage restart/);
      controller = new AbortController(); h.options.signal = controller.signal;
      run = h.run();
      await until(() => pipeline?.proofStorageRecovery.jobs.size === 2 && !pipeline.signal.aborted);
      assert.equal(h.models.length, 2, 'restart dispatches no model before loading the durable pause');
    }
    clock += 20; pipeline.wake();
    await until(() => counts.get('a') === 2 && counts.get('b') === 2);
    assert.equal(pipeline.proofStorageRecovery.waiting, true, 'PENDING replacements keep the pause');
    for (const id of ['a', 'b']) {
      const saved = uploads.filter(u => u.id === id);
      assert.deepEqual(saved[0], saved[1], 'same proof, explanation and proof type');
      assert.equal((await h.store.read(id)).attempt_count, 1);
    }
    completed.add('a'); clock += 100; pipeline.wake();
    await until(() => !pipeline.proofStorageRecovery.jobs.has('a'));
    assert.equal(pipeline.proofStorageRecovery.waiting, true);
    assert.equal(h.models.length, 2, 'another affected proof still blocks dispatch');
    completed.add('b'); clock += 100; pipeline.wake();
    assert.equal((await run).completed, true);
    assert.equal(h.models.length, 4); assert.equal(pipeline.proofStorageRecovery.waiting, false);
    assert.equal(h.models.every(m => m.attempt === 1), true, 'storage retries spend no extra attempts');
  } finally { controller.abort(new Error('cleanup')); await run.catch(() => {}); }
});

for (const formatting of [false, true]) test(`a storage pause at the final ${formatting ? 'formatting' : 'proof'} invocation check retains the same attempt`, async t => {
  const h = await fixture(t, ['a']), generate = h.hooks.agent;
  let p, paused = false, invocations = 0;
  const blocker = { theorem_id: 'remote', proof_storage_retry: { failures: 1 } };
  h.hooks.onControlReady = pipeline => { p = pipeline; };
  const stopBeforeInvocation = options => {
    if (!paused) {
      paused = true; p.proofStorageRecovery.block(blocker);
      options.assertModelSlot();
      assert.fail('closed gate must reject the final invocation check');
    }
  };
  h.hooks.agent = async (...args) => {
    if (!formatting) stopBeforeInvocation(args[5]);
    const result = await generate(...args);
    return formatting ? { ...result, explanation: '' } : result;
  };
  h.hooks.repairAnswer = async (_target, _workspace, _dir, _attempt, _feedback, candidate, options) => {
    invocations++; stopBeforeInvocation(options);
    return { ...candidate, explanation: 'Trivial.' };
  };
  const run = h.run();
  try {
    await until(async () => paused && (await h.store.read('a'))?.dispatch_state !== 'RUNNING');
    const waiting = await h.store.read('a');
    assert.equal(waiting.attempt_count, 1);
    assert.equal(waiting.history.filter(e => e.event_type === 'attempt' && e.result === 'started').length, 1);
    if (formatting) assert.ok(waiting.format_repair_input, 'formatting input survives a late pause');
    p.proofStorageRecovery.clear(blocker); p.wake();
    assert.equal((await run).completed, true);
    assert.equal(h.models.length, 1); assert.equal(h.models[0].attempt, 1);
    assert.equal((await h.store.read('a')).attempt_count, 1);
    if (formatting) assert.equal(invocations, 2);
  } finally { h.controller.abort(new Error('cleanup')); await run.catch(() => {}); }
});

test('startup adopts recent storage failures from unknown uploads before allowing new model dispatch', async t => {
  const h = await fixture(t, ['a']), state = await h.store.ensure('a', { attempts: 2, rootId: 'root' });
  Object.assign(state, { status: 'SUBMISSION_UNKNOWN', stage: 'SERVER', operation: 'submit',
    submission_started_at: '2026-11-02T21:10:00Z', source_hash: 'saved-hash', proof_type: 'prove',
    remote_operations: [{ operation_id: 'op', status: 'SUBMISSION_UNKNOWN' }] });
  await h.store.replace(state, state.revision);
  const request = h.client.request;
  h.client.request = path => path.startsWith('submissions?') ? {
    submissions: [{ id: 'failed-upload', theorem_id: 'a', created_at: '2026-11-02T21:10:03Z', status: 'ERROR',
      error_message: 'Could not enqueue the submission: could not store the proof file: Gateway Timeout. Retry unchanged.' }], total: 1,
  } : request(path);
  const p = new Pipeline(h.client, h.target, h.options);
  await p.restoreProofStorageRecovery();
  assert.equal(p.proofStorageRecovery.waiting, true);
  assert.equal(p.canAdmit(await h.store.index()), false);
  const saved = await h.store.read('a');
  assert.equal(saved.submission_id, 'failed-upload'); assert.equal(saved.operation, 'retry_storage');
  assert.equal(saved.remote_operations[0].submission_id, 'failed-upload');
  assert.equal(saved.attempt_budget, 2); assert.equal(saved.attempt_count, 0);
  assert.equal(h.models.length, 0); assert.equal(h.posts.length, 0);
});

test('storage failure arriving during dispatch persistence closes Codex and research slots immediately', async t => {
  const h = await fixture(t, ['a']), p = new Pipeline(h.client, h.target, h.options);
  const state = await h.store.ensure('a'); state.stage = 'CODEX'; state.operation = 'implement';
  await h.store.replace(state, state.revision);
  let dispatched = false;
  const blocker = { theorem_id: 'remote', proof_storage_retry: { failures: 1 } };
  p.controls.set('a', { running: null, waiting: { state, resolve: () => { dispatched = true; }, reject: assert.fail,
    persist: async () => {
      assert.equal(await h.store.replace(state, state.revision), true);
      p.proofStorageRecovery.block(blocker);
    } } });
  await p.routeAndDispatch(); assert.equal(dispatched, false);
  assert.equal(p.controls.get('a').running, null);
  p.reviewModelActive = true;
  assert.throws(() => p.assertReviewSlot(), ProofStoragePaused);
  p.reviewModelActive = false;
  p.proofStorageRecovery.clear(blocker);
  p.controls.get('a').waiting.persist = async () => { assert.equal(await h.store.replace(state, state.revision), true); };
  await p.routeAndDispatch(); assert.equal(dispatched, true);
});

test('restored Sol jobs queue one at a time while Luna bypasses the busy Sol slot', async t => {
  const h = await fixture(t, ['a', 'b', 'c']);
  const pipeline = new Pipeline(h.client, h.target, { ...h.options, pipeline: {
    attemptModels: ['luna-6-high', 'sol-6.1-high'], queues: { codex: { concurrency: 4 } },
  } });
  const dispatched = [];
  for (const id of ['a', 'b', 'c']) {
    const state = await h.store.ensure(id);
    Object.assign(state, { stage: 'CODEX', operation: 'implement', attempt_count: id === 'c' ? 0 : 1,
      legacy_baseline: { attempts: id === 'c' ? 0 : 1, context_id: 'initial' } });
    await h.store.replace(state, state.revision);
    const control = { running: null, waiting: { state, resolve: () => dispatched.push(id), reject: assert.fail,
      persist: async () => assert.equal(await h.store.replace(state, state.revision), true) } };
    pipeline.controls.set(id, control);
  }
  await pipeline.routeAndDispatch();
  assert.deepEqual(dispatched, ['a', 'c']); assert.equal(pipeline.solRunning(), 1);
  await pipeline.routeAndDispatch();
  assert.deepEqual(dispatched, ['a', 'c']); assert.equal(pipeline.solRunning(), 1);
  await pipeline.routeAndDispatch();
  assert.deepEqual(dispatched, ['a', 'c']);
  const queued = await h.store.read('b');
  assert.equal(queued.attempt_count, 1, 'waiting for Sol spends no new attempt');
  const first = await h.store.read('a'); first.job_status = 'DONE'; first.status = 'ACCEPTED';
  await h.store.replace(first, first.revision);
  pipeline.controls.get('a').running = null;
  await pipeline.routeAndDispatch();
  assert.deepEqual(dispatched, ['a', 'c', 'b']); assert.equal(pipeline.solRunning(), 1);
});

test('changing the prompt during a live model call applies to the next mathematical attempt', async t => {
  const h = await fixture(t, ['a', 'b']);
  h.options.pipeline.promptVariant = 'balanced';
  h.options.pipeline.queues = { codex: { concurrency: 1 } };
  let pipeline;
  h.hooks.onControlReady = p => { pipeline = p; };
  const generate = h.hooks.agent, assignments = [];
  h.hooks.agent = async (...args) => {
    assignments.push(args[5].promptExperiment.variant);
    if (assignments.length === 1) {
      await pipeline.operator.execute({ id: 'change-prompt', action: 'set-prompt-variant', promptVariant: 'proof_first',
        runId: pipeline.runId, revision: 0 });
      assert.equal(args[5].promptExperiment.variant, 'balanced');
    }
    return generate(...args);
  };
  assert.equal((await h.run()).completed, true);
  assert.deepEqual(assignments, ['balanced', 'proof_first']);
  const jobs = await Promise.all(['a', 'b'].map(id => h.store.read(id)));
  assert.deepEqual(jobs.map(j => j.prompt_experiment.variant).sort(), ['balanced', 'proof_first']);
});

test('production model invocations serialize Sol even with four Codex workers', async t => {
  const h = await fixture(t, ['a', 'b', 'c']), gate = barrier();
  h.options.model = 'sol-6.1-high';
  h.options.pipeline = { queues: { codex: { concurrency: 4 } } };
  const generate = h.hooks.agent;
  let active = 0, peak = 0, calls = 0;
  h.hooks.agent = async (...args) => {
    assert.equal(args[5].model, 'gpt-6.1-sol');
    args[5].assertModelSlot('gpt-6.1-sol');
    active++; peak = Math.max(peak, active); calls++;
    try {
      if (calls === 1) await gate.promise;
      return await generate(...args);
    } finally { active--; }
  };
  const run = h.run();
  try {
    // Workspace preparation may finish before the first model enters its gate.
    await until(() => h.workspaces.length === 3 && calls > 0);
    assert.equal(calls, 1); assert.equal(peak, 1);
    gate.release();
    const result = await run;
    assert.equal(result.completed, true); assert.equal(calls, 3); assert.equal(peak, 1);
  } finally { gate.release(); h.controller.abort(new Error('cleanup')); await run.catch(() => {}); }
});

test('acknowledged live model changes reach the next production invocation', async t => {
  const h = await fixture(t, ['a', 'b']);
  h.options.model = 'luna-6-high';
  h.options.pipeline.queues = { codex: { concurrency: 1 } };
  let pipeline;
  h.hooks.onControlReady = p => { pipeline = p; };
  const generate = h.hooks.agent, models = [];
  h.hooks.agent = async (...args) => {
    models.push(args[5].model);
    if (models.length === 1) {
      await pipeline.operator.execute({ id: 'change-model', action: 'set-runtime-settings',
        settings: { attemptModels: ['astra-6-medium'] }, runId: pipeline.runId, revision: 0 });
      assert.equal(args[5].model, 'gpt-6-luna');
    }
    return generate(...args);
  };
  assert.equal((await h.run()).completed, true);
  assert.deepEqual(models, ['gpt-6-luna', 'gpt-6-astra']);
});

test('lowering live Codex capacity drains existing owners before dispatching another invocation', async t => {
  const h = await fixture(t, ['a', 'b', 'c']), gate = barrier();
  h.options.model = 'luna-6-high';
  h.options.pipeline.queues = { codex: { concurrency: 2 } };
  let pipeline, live = 0, calls = 0;
  h.hooks.onControlReady = p => { pipeline = p; };
  const generate = h.hooks.agent;
  h.hooks.agent = async (...args) => {
    live++; calls++;
    try {
      if (calls <= 2) {
        await gate.promise;
        args[5].assertModelSlot('gpt-6-luna');
      } else assert.equal(live, 1, 'new dispatch waits for existing owners to drain');
      return await generate(...args);
    } finally { live--; }
  };
  const run = h.run();
  try {
    await until(() => live === 2);
    await pipeline.operator.execute({ id: 'lower-cap', action: 'set-runtime-settings',
      settings: { queues: { CODEX: { concurrency: 1 } } }, runId: pipeline.runId, revision: 0 });
    assert.equal(live, 2, 'existing owners are retained');
    gate.release();
    assert.equal((await run).completed, true);
    assert.equal(calls, 3);
  } finally { gate.release(); h.controller.abort(new Error('cleanup')); await run.catch(() => {}); }
});
async function until(check) {
  const deadline = Date.now() + 5000;
  while (!await check()) {
    assert.ok(Date.now() < deadline, 'barrier condition timed out');
    await new Promise(resolve => setTimeout(resolve, 2));
  }
}
async function fixture(t, ids = ['a', 'b']) {
  t.mock.method(console, 'log', () => {});
  const root = await mkdtemp(join(tmpdir(), 'prove2me-pipeline-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('test timed out')), 10000);
  t.after(() => clearTimeout(timeout));
  const runs = join(root, 'runs'), store = new JobStore(runs);
  const configPath = join(root, 'runner-config.json');
  await writeFile(configPath, JSON.stringify(defaults));
  const environment = { mathlib_rev: 'a'.repeat(40), toolchain: 'leanprover/lean4:v4.33.1' };
  const theorem = id => ({ theorem_id: id, theorem_name: `Goal${id}`, status: 'Open',
    mathlib_rev: environment.mathlib_rev, preamble: '', formal_statement: `theorem Goal${id} : True := by sorry` });
  const done = new Set(), models = [], posts = [], workspaces = [], checks = [], events = [];
  let liveModels = 0, liveBuilds = 0, externalRootStatus;
  const hooks = {
    frontier: async () => {
      const leaves = ids.filter(id => !done.has(id)).map(theorem);
      return { root: { ...theorem('root'), status: externalRootStatus ?? (done.size === ids.length ? 'Proved' : 'Open') },
        leaves, nodes: [theorem('root'), ...leaves] };
    },
    workspace: async (_env, options) => {
      const id = options.workspaceOwner;
      const path = join(root, `workspace-${id}-${workspaces.length}`);
      await mkdir(join(path, 'Solutions'), { recursive: true }); workspaces.push(id); return path;
    },
    mirror: async () => {},
    preflight: async target => {
      events.push(`ready:${target.theorem_id}`);
    },
    command: async (_exe, args, options) => {
      assert.equal(++liveBuilds, 1, 'one shared build slot'); checks.push(options.cwd);
      await new Promise(resolve => setImmediate(resolve)); liveBuilds--;
    },
    agent: async (target, workspace, _dir, attempt, feedback) => {
      assert.ok(++liveModels <= (options.pipeline?.queues?.codex?.concurrency ?? 2), 'global Codex dispatch cap');
      models.push({ id: target.theorem_id, attempt, feedback }); events.push(`model:${target.theorem_id}`);
      await new Promise(resolve => setImmediate(resolve));
      const module = `Solutions.Sol_${target.theorem_id}`, solution = join(workspace, `${module.replaceAll('.', '/')}.lean`);
      await writeFile(solution, 'theorem solution : True := by trivial'); liveModels--;
      return { kind: 'proof', ready: true, explanation: 'Trivial.', children: [], definitions: [], module, solution };
    },
    poll: async (_client, submissionId) => {
      const id = submissionId.slice(4); done.add(id); return { status: 'ACCEPTED' };
    },
  };
  const client = {
    request: async path => path === 'environments' ? { environments: [environment] } :
      path === 'theorems/root' ? { ...theorem('root'), status: externalRootStatus ?? (done.size === ids.length ? 'Proved' : 'Open') } :
      path.endsWith('/decompositions') ? { decompositions: [] } : theorem(path.split('/').at(-1)),
    pages: async () => [],
    submit: async id => { posts.push(id); events.push(`submit:${id}`); return { submission_id: `sub-${id}` }; },
  };
  const options = { runs, configPath, attempts: 3, lake: 'lake', verificationMode: 'local', refreshInterval: 0.02, graphRefreshInterval: 0.02, pipeline: { attemptModels: [], missionReviewModel: 'luna-6-high', queues: { codex: { concurrency: 1 } } },
    serverPollInterval: 10, signal: controller.signal };
  const target = { name: 'Mission', kind: 'mission', root: 'root' };
  return { root, store, runs, options, target, hooks, client, models, posts, workspaces, checks, events,
    done, controller, proveRoot: () => { externalRootStatus = 'Proved'; },
    disproveRoot: () => { externalRootStatus = 'Disproved'; },
    run: () => runTarget(client, target, options, hooks) };
}

test('quota waits stop Codex dispatch, continue server work, and recover after an early hourly reset with one probe', async t => {
  const h = await fixture(t, ['a', 'b', 'c']), server = barrier(), probe = barrier();
  let now = 1800000000000, reads = 0, reset = false, serverWaiting = false, probing = false;
  const calls = [], generate = h.hooks.agent;
  h.hooks.now = () => now;
  h.hooks.wait = () => new Promise(resolve => setTimeout(resolve, 2));
  h.hooks.readCodexRateLimits = async () => {
    reads++; return { ordinaryUsageAllowed: reset, rateLimits: {
      primary: { usedPercent: reset ? 0 : 100, resetsAt: (now + 5 * HOUR) / 1000 },
      secondary: { usedPercent: reset ? 0 : 100, resetsAt: (now + 7 * 24 * HOUR) / 1000 },
    } };
  };
  h.hooks.agent = async (...args) => {
    const [target, workspace, dir, attempt] = args;
    calls.push({ id: target.theorem_id, attempt });
    if (reset && !probing) { probing = true; await probe.promise; }
    if (target.theorem_id === 'b') {
      const source = 'theorem partial : True := by\n  trivial\n';
      if (calls.filter(c => c.id === 'b').length === 1) {
        await writeFile(join(workspace, 'Solutions/Sol_b.lean'), source);
        await writeFile(join(dir, `solution-${attempt}.lean`), source);
        const log = join(dir, `codex-${attempt}.log`);
        await writeFile(log, JSON.stringify({ type: 'turn.failed', error: { message: 'You’ve hit your usage limit. Try again at 1:31 PM.' } }));
        throw await codexQuotaFailure(new Error('codex exited with 1'), log);
      }
      assert.equal(await readFile(join(workspace, 'Solutions/Sol_b.lean'), 'utf8'), source);
      assert.match(args[4], /Continue the same attempt/);
    }
    return generate(...args);
  };
  h.hooks.poll = async (_client, submissionId) => {
    const id = submissionId.slice(4);
    if (id === 'a') { serverWaiting = true; await server.promise; }
    h.done.add(id); return { status: 'ACCEPTED' };
  };
  const run = h.run();
  try {
    await until(async () => serverWaiting && reads === 1 && (await h.store.read('b'))?.codex_quota_wait);
    const original = await h.store.read('b');
    assert.equal(original.attempt_count, 1);
    assert.equal(original.history.filter(e => e.result === 'rejected').length, 0);
    server.release(); await until(() => h.done.has('a'));
    now += HOUR - 1;
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(reads, 1); assert.equal(calls.some(c => c.id === 'c'), false);
    reset = true; now++;
    await until(() => probing);
    assert.equal(reads, 2); assert.equal(calls.length, 3, 'only one recovery invocation');
    assert.equal((await h.store.read('b')).attempt_id, original.attempt_id);
    probe.release();
    assert.equal((await run).completed, true);
    const saved = await h.store.read('b');
    assert.equal(saved.attempt_count, 1); assert.equal(saved.attempts_used_in_job, 1);
    assert.equal(saved.attempts_by_model['gpt-6-luna'], 1); assert.ok(validHistory(saved));
    assert.deepEqual(calls.filter(c => c.id === 'b').map(c => c.attempt), [1, 1]);
    assert.equal(new Set(h.posts).size, 3); assert.equal(h.posts.length, 3);
  } finally { server.release(); probe.release(); h.controller.abort(new Error('cleanup')); await run.catch(() => {}); }
});

test('the curly-apostrophe quota error stops new dispatches across two model slots while an existing call drains', async t => {
  const h = await fixture(t, ['a', 'b', 'c', 'd']), other = barrier(), generate = h.hooks.agent;
  h.options.pipeline = { queues: { codex: { concurrency: 2 } } };
  const calls = []; let failed = false, available = false, reads = 0, now = 1800000000000;
  h.hooks.now = () => now;
  h.hooks.wait = () => new Promise(resolve => setTimeout(resolve, 2));
  h.hooks.readCodexRateLimits = async () => {
    reads++; return { ordinaryUsageAllowed: available, rateLimits: { primary: { usedPercent: available ? 0 : 100 } } };
  };
  h.hooks.agent = async (...args) => {
    const [target, , dir, attempt] = args;
    calls.push(target.theorem_id);
    if (target.theorem_id === 'a' && !failed) {
      await until(() => calls.includes('b'));
      failed = true;
      const log = join(dir, `codex-${attempt}.log`);
      await writeFile(log, JSON.stringify({ type: 'turn.failed', error: { message: 'You’ve hit your usage limit.' } }));
      throw await codexQuotaFailure(new Error('codex exited with 1'), log);
    }
    if (target.theorem_id === 'b') await other.promise;
    return generate(...args);
  };
  const run = h.run();
  try {
    await until(() => reads === 1);
    assert.deepEqual(calls, ['a', 'b']);
    other.release(); await until(() => h.done.has('b'));
    assert.deepEqual(calls, ['a', 'b'], 'freeing the other slot does not launch another Codex');
    assert.equal((await h.store.read('a')).attempt_count, 1);
    available = true; now += HOUR;
    assert.equal((await run).completed, true);
    assert.equal(calls.filter(id => id === 'a').length, 2, 'one original attempt is resumed after availability recovers');
    assert.equal((await h.store.read('a')).attempt_count, 1);
  } finally { other.release(); h.controller.abort(new Error('cleanup')); await run.catch(() => {}); }
});

for (const resume of [
  { name: 'an empty schedule', attemptModels: [], model: 'gpt-6-luna', effort: 'high', profile: 'luna-6-high' },
  { name: 'a changed schedule', attemptModels: ['luna-6-medium'], model: 'gpt-6-luna', effort: 'medium', profile: 'luna-6-medium' },
  { name: 'an explicit override', attemptModels: [], override: 'astra-6-high', model: 'gpt-6-astra', effort: 'high', profile: 'astra-6-high' },
  { name: 'the same schedule', attemptModels: ['sol-6.1-medium'], model: 'gpt-6.1-sol', effort: 'medium', profile: 'sol-6.1-medium' },
]) test(`a quota restart uses ${resume.name}, restores the partial proof and preserves the attempt`, async t => {
  const h = await fixture(t, ['a']), generate = h.hooks.agent;
  h.options.pipeline.attemptModels = ['sol-6.1-medium'];
  h.options.pipeline.promptVariant = 'proof_first';
  let now = 1800000000000, available = false, calls = 0, promptAssignment;
  h.hooks.now = () => now;
  h.hooks.wait = () => new Promise(resolve => setTimeout(resolve, 2));
  h.hooks.readCodexRateLimits = async () => ({ ordinaryUsageAllowed: available,
    rateLimits: { primary: { usedPercent: available ? 0 : 100, resetsAt: (now + 7 * 24 * HOUR) / 1000 } } });
  h.hooks.agent = async (...args) => {
    assert.equal(args[3], 1);
    if (!promptAssignment) promptAssignment = structuredClone(args[5].promptExperiment);
    assert.equal(promptAssignment.variant, 'proof_first');
    assert.deepEqual(args[5].promptExperiment, promptAssignment);
    assert.equal(args[5].model, calls === 0 ? 'gpt-6.1-sol' : resume.model);
    assert.equal(args[5].reasoningEffort, calls === 0 ? 'medium' : resume.effort);
    if (++calls === 1) {
      await writeFile(join(args[2], 'solution-1.lean'), '-- preserved partial proof\n');
      throw new CodexQuotaError('weekly limit');
    }
    assert.equal(await readFile(join(args[1], 'Solutions/Sol_a.lean'), 'utf8'), '-- preserved partial proof\n');
    return generate(...args);
  };
  const first = h.run();
  await until(async () => {
    const state = await h.store.read('a');
    if (!state?.codex_quota_wait || state.dispatch_state !== 'QUEUED') return false;
    const quota = await readJson(join(h.runs, 'codex-quota.json'));
    return quota?.next_check_at > now;
  });
  const original = await h.store.read('a');
  h.controller.abort(new Error('stop during quota wait'));
  await assert.rejects(first, /stop during quota wait/);
  h.options.signal = new AbortController().signal;
  h.options.pipeline.attemptModels = resume.attemptModels;
  h.options.pipeline.promptVariant = 'balanced';
  h.options.model = resume.override;
  now += 1000; available = true;
  assert.equal((await h.run()).completed, true);
  const saved = await h.store.read('a');
  assert.equal(saved.attempt_id, original.attempt_id); assert.equal(saved.attempt_count, 1);
  assert.equal(saved.model, resume.model); assert.equal(saved.reasoning_effort, resume.effort);
  assert.equal(saved.model_profile, resume.profile);
  assert.deepEqual(saved.prompt_experiment, promptAssignment);
  assert.deepEqual(saved.history.at(-1).prompt_experiment, promptAssignment);
  assert.deepEqual(saved.history.find(e => e.result === 'started'), original.history.find(e => e.result === 'started'));
  assert.ok(validHistory(saved)); assert.equal(calls, 2); assert.equal(h.workspaces.length, 2);
  assert.deepEqual(saved.history.filter(e => e.event_type === 'attempt').map(e => e.result), ['started', 'proof_accepted']);
});

test('formatting repairs retain their input and one-repair allowance across quota exhaustion', async t => {
  const h = await fixture(t, ['a']), generate = h.hooks.agent;
  let now = 1800000000000, formats = 0, reads = 0;
  h.hooks.now = () => now;
  h.hooks.wait = () => new Promise(resolve => setTimeout(resolve, 2));
  h.hooks.agent = async (...args) => ({ ...await generate(...args), explanation: '' });
  h.hooks.readCodexRateLimits = async () => {
    reads++;
    return { ordinaryUsageAllowed: reads > 1, rateLimits: { primary: { usedPercent: reads > 1 ? 0 : 100 } } };
  };
  h.hooks.repairAnswer = async (_target, _workspace, _dir, attempt, _feedback, candidate) => {
    assert.equal(attempt, 1);
    if (++formats === 1) throw new CodexQuotaError('usage limit reached');
    return { ...candidate, explanation: 'Trivial.' };
  };
  const run = h.run();
  try {
    await until(async () => reads === 1 && (await h.store.read('a'))?.codex_quota_wait);
    const waiting = await h.store.read('a');
    assert.equal(waiting.operation, 'format_repair'); assert.ok(waiting.format_repair_input);
    now += HOUR;
    assert.equal((await run).completed, true);
    const saved = await h.store.read('a');
    assert.equal(formats, 2); assert.equal(h.models.length, 1); assert.equal(saved.attempt_count, 1);
    assert.equal(saved.format_repair_used, true); assert.ok(validHistory(saved));
    assert.deepEqual(saved.prompt_experiment, waiting.prompt_experiment);
    assert.deepEqual(saved.history.at(-1).prompt_experiment, waiting.prompt_experiment);
  } finally { h.controller.abort(new Error('cleanup')); await run.catch(() => {}); }
});

test('periodic research shares the model slot and reaches later proof invocations with downloaded references', async t => {
  const h = await fixture(t), gate = barrier();
  h.options.pipeline.missionReviewEvery = 2;
  let reviewing = false, reviews = 0, received = 0;
  h.hooks.reviewMission = async (request, controls) => {
    controls.assertModelSlot(); reviewing = true; reviews++;
    assert.equal(request.model, 'gpt-6-luna');
    await gate.promise; reviewing = false;
    return { notes: 'Verified observation: reuse the established definitions. Evidence: root graph.',
      resources: [{ url: 'https://example.org/source.txt', purpose: 'Reusable reference' }] };
  };
  h.hooks.downloadResearchResource = async url => ({ url, bytes: Buffer.from('Shared reference bytes.'), content_type: 'text/plain' });
  const originalAgent = h.hooks.agent;
  h.hooks.agent = async (...args) => {
    assert.equal(reviewing, false, 'review and proof calls share one model slot');
    const settings = args[5], invocation = JSON.parse(await readFile(settings.attemptContextPath, 'utf8'));
    assert.equal(invocation.mission_research.root_id, 'root');
    assert.match(await readFile(invocation.mission_research.notes_path, 'utf8'), /reuse the established definitions/);
    const manifest = JSON.parse(await readFile(invocation.mission_research.manifest_path, 'utf8'));
    assert.equal(manifest.advisory, true);
    assert.equal(await readFile(join(h.runs, args[0].theorem_id, `research-${args[3]}`, manifest.resources[0].name), 'utf8'), 'Shared reference bytes.');
    received++; return originalAgent(...args);
  };
  const running = h.run();
  await until(() => reviewing);
  assert.equal(h.models.length, 0);
  gate.release();
  const result = await running;
  assert.equal(result.completed, true); assert.equal(reviews, 1); assert.equal(received, 2);
  assert.equal(result.mission_research.reviewed_nodes, 3);
  assert.equal(result.attempts_by_model['gpt-6-luna'], 2, 'research does not consume theorem attempts');
});

test('root completion cancels an active research review and does not delay completion or publish obsolete notes', async t => {
  const h = await fixture(t);
  h.options.pipeline.missionReviewEvery = 2;
  let started = false, cancelled = false;
  h.hooks.reviewMission = async (_request, { signal }) => {
    started = true;
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => {
      cancelled = true; reject(signal.reason);
    }, { once: true }));
  };
  const running = h.run();
  await until(() => started);
  h.proveRoot();
  const result = await running;
  assert.equal(result.completed, true); assert.equal(cancelled, true);
  assert.equal(result.mission_research.latest, null); assert.equal(h.models.length, 0);
});

test('quota exhaustion fills the agent buffer, drains downstream work, then sleeps quietly until the hourly check', async t => {
  const h = await fixture(t, ['a', 'b', 'c', 'd', 'e', 'f']), validation = barrier();
  h.options.pipeline.queues.codex.maxSize = 4;
  const logs = [], generate = h.hooks.agent, frontier = h.hooks.frontier, build = h.hooks.command;
  t.mock.method(console, 'log', message => logs.push(message));
  let now = 1800000000000, reads = 0, scans = 0, exhausted = false, available = false;
  let idleRelease, idleCount = 0, idleDelay = 0, settled = false;
  h.hooks.now = () => now;
  h.hooks.frontier = async (...args) => { scans++; return frontier(...args); };
  h.hooks.readCodexRateLimits = async () => {
    reads++;
    return { ordinaryUsageAllowed: available, rateLimits: {
      primary: { usedPercent: available ? 0 : 100, resetsAt: (now + 7 * 24 * HOUR) / 1000 },
    } };
  };
  h.hooks.agent = async (...args) => {
    if (args[0].theorem_id === 'b' && !exhausted) {
      exhausted = true; throw new CodexQuotaError('weekly limit exhausted');
    }
    return generate(...args);
  };
  h.hooks.command = async (...args) => {
    if (args[2].cwd.includes('workspace-a-') && args[2].log.endsWith('lean-1.log')) await validation.promise;
    return build(...args);
  };
  h.hooks.onCheckpoint = summary => {
    const q = summary.pipeline.queues;
    settled = summary.codex_quota?.status === 'WAITING' && q.CODEX.queued === summary.limits.queues.CODEX.maxSize &&
      q.CODEX.reserved === 0 && ['PREPARE', 'VALIDATE', 'SERVER'].every(stage => !q[stage].running && !q[stage].queued) &&
      h.done.has('a');
  };
  h.hooks.wait = async milliseconds => {
    if (!settled) { await new Promise(resolve => setTimeout(resolve, 2)); return; }
    idleDelay = milliseconds; idleCount++;
    await new Promise(resolve => { idleRelease = resolve; });
  };
  const run = h.run();
  try {
    await until(() => exhausted && reads === 1);
    assert.equal(h.done.has('a'), false, 'validation is still waiting when quota is exhausted');
    validation.release();
    await until(() => idleCount === 1);
    assert.equal(idleDelay, HOUR, 'the idle coordinator has no 30-second heartbeat or periodic graph deadline');
    assert.ok(h.workspaces.length >= 3, 'preparation fills the bounded agent buffer during the quota wait');
    assert.deepEqual(h.posts, ['a'], 'the validation and server queues drained after exhaustion');
    const before = { logs: logs.length, scans, prepared: h.workspaces.length, visits: h.models.length };
    now += 30 * 60000;
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(logs.length, before.logs); assert.equal(scans, before.scans);
    assert.equal(h.workspaces.length, before.prepared); assert.equal(h.models.length, before.visits);
    now += 30 * 60000; idleRelease();
    await until(() => idleCount === 2 && reads === 2);
    // The availability read increments its counter before the async state save
    // and completion log. Wait for that completion rather than racing disk I/O.
    await until(() => logs.slice(before.logs).some(line => String(line).includes('Codex quota checked:')));
    assert.equal(scans, before.scans, 'the hourly quota check does not trigger a graph scan');
    assert.deepEqual(logs.slice(before.logs).map(line => String(line).replace(/^\[[^\]]+\] /, '')),
      [`Codex quota checked: Codex quota exhausted; next availability check ${new Date(now + HOUR).toISOString()} (checks at least hourly)`]);
    available = true; now += HOUR; settled = false; idleRelease();
    assert.equal((await run).completed, true);
    assert.equal(new Set(h.posts).size, 6);
  } finally { validation.release(); idleRelease?.(); h.controller.abort(new Error('cleanup')); await run.catch(() => {}); }
});

test('production pipeline lets another theorem prepare, model, and validate while a server request is stalled', async t => {
  const h = await fixture(t), server = barrier(); let waiting = false;
  h.hooks.poll = async (_client, submissionId) => {
    const id = submissionId.slice(4);
    if (id === 'a') { waiting = true; await server.promise; }
    h.done.add(id); return { status: 'ACCEPTED' };
  };
  const run = h.run();
  try {
    await until(async () => waiting && h.models.some(s => s.id === 'b') && (await h.store.read('b'))?.artifact_manifest);
    const saved = await h.store.read('b');
    assert.equal(saved.attempts_used_in_job, 1);
    assert.equal(h.posts.length, 1, 'the single server worker is still held by the first request');
  } finally { server.release(); }
  const summary = await run;
  assert.equal(summary.completed, true); assert.equal(h.models.length, 2);
  assert.equal(summary.pipeline.active, 0);
});

test('one coordinator polls due verdicts concurrently within the API bound while submissions keep progressing', async t => {
  const h = await fixture(t, ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']), gate = barrier();
  h.options.verificationMode = 'server-only';
  h.options.pipeline = { maxActiveJobs: 16, maxRemoteJobs: 48, apiConcurrency: 8,
    queues: { codex: { concurrency: 8 }, server: { concurrency: 1 } } };
  const calls = new Map(), blocked = new Set(); let live = 0, peak = 0;
  h.hooks.poll = async (_client, submissionId) => {
    const count = (calls.get(submissionId) ?? 0) + 1; calls.set(submissionId, count);
    if (count === 1) return { status: 'PENDING' };
    blocked.add(submissionId); peak = Math.max(peak, ++live);
    try { await gate.promise; } finally { live--; }
    h.done.add(submissionId.slice(4)); return { status: 'ACCEPTED' };
  };
  const run = h.run();
  try {
    await until(() => blocked.size === 6 && h.posts.length === 8);
    assert.equal(live, 6, 'six verdict reads coexist with the single submission/publication lane');
    await until(async () => [...(await h.store.index()).values()].filter(job => job.status === 'PENDING').length === 8);
    const pending = await h.store.index();
    assert.equal([...pending.values()].filter(job => job.status === 'PENDING').length, 8);
    gate.release(); assert.equal((await run).completed, true);
    assert.ok(peak <= 6); assert.equal(h.posts.length, 8);
  } finally { gate.release(); h.controller.abort(new Error('cleanup')); await run.catch(() => {}); }
});

test('server-only pending verdicts beyond four release local capacity and leases, with a separate remote bound', async t => {
  const h = await fixture(t, ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
  h.options.pipeline = { verificationMode: 'server-only', maxActiveJobs: 2, maxRemoteJobs: 6 };
  h.options.verificationMode = 'server-only';
  const leased = new Set(), workspace = h.hooks.workspace;
  h.hooks.workspace = async (...args) => {
    assert.ok(leased.size < 2); const path = await workspace(...args); leased.add(path); return path;
  };
  h.hooks.releaseWorkspace = async path => { assert.ok(leased.delete(path)); await rm(path, { recursive: true, force: true }); };
  h.hooks.command = async () => assert.fail('no client Lean command');
  h.hooks.poll = async () => ({ status: 'PENDING' });
  h.options.serverPollInterval = 60000;
  const run = h.run();
  await until(async () => [...(await h.store.index()).values()].filter(s => s.dispatch_state === 'DELAYED').length === 6);
  assert.equal(h.models.length, 6); assert.equal(h.posts.length, 6); assert.equal(leased.size, 0);
  const summary = JSON.parse(await readFile(join(h.runs, 'last-run.json'), 'utf8'));
  assert.equal(summary.pipeline.localActive, 0); assert.equal(summary.pipeline.remoteActive, 6);
  assert.equal((await h.store.index()).size, 6, 'no admission beyond reserved remote capacity');
  h.controller.abort(new Error('restart remote pool')); await assert.rejects(run, /restart remote pool/);
  const before = h.workspaces.length;
  h.options.signal = undefined; h.options.attempts = 99;
  h.options.pipeline.maxRemoteJobs = 3; // drain saved backlog above a reduced bound
  h.hooks.poll = async (_client, submissionId) => { h.done.add(submissionId.slice(4)); return { status: 'ACCEPTED' }; };
  for (const state of (await h.store.index()).values()) {
    state.next_poll_at = new Date(0).toISOString(); await h.store.replace(state, state.revision);
  }
  const completed = await h.run();
  assert.equal(completed.completed, true); assert.equal(h.posts.length, 8);
  assert.equal(h.workspaces.length, before + 2, 'pending restarts need no workspace');
  assert.equal(h.models.length, 8); assert.equal(leased.size, 0);
});

test('a full server-only remote pool drains concurrent rejections through one local slot without deadlock', async t => {
  const h = await fixture(t, ['a', 'b', 'c', 'd', 'e', 'f']);
  h.options.pipeline = { verificationMode: 'server-only', maxActiveJobs: 1, maxRemoteJobs: 6 };
  h.options.verificationMode = 'server-only';
  h.hooks.command = async () => assert.fail('no client Lean command');
  const rejected = new Set(); let pending = true, saturated = false;
  h.options.serverPollInterval = 5;
  h.hooks.poll = async (_client, submissionId) => {
    const id = submissionId.slice(4);
    if (pending) return { status: 'PENDING' };
    if (!rejected.has(id)) { rejected.add(id); return { status: 'REJECTED', error_message: 'remote compiler failure' }; }
    h.done.add(id); return { status: 'ACCEPTED' };
  };
  h.hooks.onCheckpoint = summary => {
    assert.ok(summary.pipeline.localActive <= 1);
    if (summary.pipeline.remoteActive === 6) { saturated = true; pending = false; }
  };
  const result = await h.run();
  assert.equal(result.completed, true); assert.equal(saturated, true);
  assert.equal(h.models.length, 12); assert.equal(h.posts.length, 12);
  assert.equal(h.workspaces.length, 12, 'only repairs reconstruct');
  for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) {
    const state = await h.store.read(id);
    assert.equal(state.attempt_budget, 3); assert.equal(state.attempts_used_in_job, 2);
    assert.match(h.models.find(m => m.id === id && m.attempt === 2).feedback, /remote compiler failure/);
  }
});

test('all capacities one make progress through local repair, formatting repair and server rejection', async t => {
  const h = await fixture(t, ['a', 'b', 'c']);
  h.options.pipeline = { queues: Object.fromEntries(['prepare', 'codex', 'validate', 'server'].map(s => [s, { maxSize: 1, concurrency: 1 }])) };
  let observed = 0;
  h.hooks.onCheckpoint = summary => {
    observed++;
    assert.ok(summary.pipeline.active <= 4);
    for (const queue of Object.values(summary.pipeline.queues)) {
      assert.ok(queue.running <= 1); assert.ok(queue.queued + queue.reserved <= 1);
    }
  };
  const generate = h.hooks.agent;
  h.hooks.agent = async (...args) => {
    const candidate = await generate(...args);
    if (args[0].theorem_id === 'a' && args[3] === 1) candidate.ready = false;
    if (args[0].theorem_id === 'b') candidate.explanation = '';
    return candidate;
  };
  let formats = 0;
  h.hooks.repairAnswer = async (_target, _workspace, _dir, _attempt, _feedback, candidate) => {
    formats++; return { ...candidate, explanation: 'Trivial.' };
  };
  let rejected = false;
  h.hooks.poll = async (_client, submissionId) => {
    const id = submissionId.slice(4);
    if (id === 'c' && !rejected) { rejected = true; return { status: 'REJECTED', error_message: 'specific remote diagnostics' }; }
    h.done.add(id); return { status: 'ACCEPTED' };
  };
  const summary = await h.run();
  assert.equal(summary.completed, true); assert.equal(formats, 1);
  assert.ok(observed > 5);
  assert.equal((await h.store.read('a')).attempts_used_in_job, 2);
  assert.equal((await h.store.read('b')).attempts_used_in_job, 1);
  assert.equal((await h.store.read('c')).attempts_used_in_job, 2);
  assert.match(h.models.find(m => m.id === 'c' && m.attempt === 2).feedback, /specific remote diagnostics/);
});

test('delayed server jobs count against the global bound and preparation reservations survive a crash', async t => {
  const h = await fixture(t, ['a', 'b', 'c', 'd', 'e']);
  h.options.pipeline = { maxActiveJobs: 2, queues: { codex: { concurrency: 1 } } };
  h.hooks.poll = async () => ({ status: 'PENDING' });
  h.options.serverPollInterval = 60000;
  const run = h.run();
  await until(async () => (await h.store.read('a'))?.dispatch_state === 'DELAYED' && (await h.store.read('b'))?.dispatch_state === 'DELAYED');
  assert.equal(h.workspaces.length, 2); assert.equal(h.models.length, 2);
  assert.equal((await h.store.index()).size, 2);
  h.controller.abort(new Error('crash with delayed records'));
  await assert.rejects(run, /crash with delayed/);
  for (const id of ['a', 'b']) {
    const state = await h.store.read(id); assert.equal(state.stage, 'SERVER'); assert.equal(state.status, 'PENDING');
  }
  const claimed = await h.store.ensure('reserved', { attempts: 3, rootId: 'root' });
  const pipeline = new Pipeline(h.client, h.target, { ...h.options, signal: undefined, pipeline: { maxActiveJobs: 1 } }, { runJob: async () => {} });
  const counts = pipeline.counts(await h.store.index());
  assert.equal(counts.active, 3); assert.equal(counts.queues.CODEX.reserved, 1);
  assert.equal(claimed.attempts_used_in_job, 0); assert.equal(pipeline.canAdmit(await h.store.index()), false);
});

for (const boundary of ['reservation', 'handoff', 'model_intent', 'format_handoff']) {
  test(`pipeline recovers a crash at ${boundary} with saved budgets and no duplicate model/artifact/upload`, async t => {
    const h = await fixture(t, ['a']); let stopped = false;
    const replace = JobStore.prototype.replace;
    if (boundary === 'format_handoff') {
      const agent = h.hooks.agent;
      h.hooks.agent = async (...args) => ({ ...await agent(...args), explanation: '' });
      h.hooks.repairAnswer = async (_t, _w, _d, _a, _f, candidate) => ({ ...candidate, explanation: 'Trivial.' });
    }
    t.mock.method(JobStore.prototype, 'replace', async function(state, revision, settings) {
      const result = await replace.call(this, state, revision, settings);
      const match = boundary === 'reservation' ? state.stage === 'PREPARE' && state.preparation_running :
        boundary === 'handoff' ? state.pending_outcome?.stage === 'VALIDATE' :
          boundary === 'format_handoff' ? state.pending_outcome?.operation === 'format_repair' :
            state.stage === 'CODEX' && state.dispatch_state === 'RUNNING';
      if (!stopped && match) { stopped = true; h.controller.abort(new Error('simulated pipeline crash')); }
      return result;
    });
    await assert.rejects(h.run(), /simulated pipeline crash/); assert.equal(stopped, true);
    const before = await h.store.read('a');
    h.options.signal = undefined; h.options.attempts = 99;
    const summary = await h.run();
    assert.equal(summary.completed, true); assert.equal(h.posts.length, 1);
    const after = await h.store.read('a');
    assert.equal(after.job_id, before.job_id); assert.equal(after.attempt_budget, 3);
    assert.equal(after.attempt_count, boundary === 'model_intent' ? 2 : 1);
    assert.equal(h.models.length, 1);
  });
}

test('a disproved root stops before dispatch and preserves issued requests across restarts', async t => {
  for (const mode of ['local', 'server-only']) {
    const h = await fixture(t);
    h.options.verificationMode = mode;
    const pending = await h.store.ensure('a', { verificationMode: mode });
    Object.assign(pending, { stage: 'SERVER', operation: 'poll_submission', status: 'PENDING',
      submission_id: 'already-issued', source_hash: 'saved-hash', dispatch_state: 'DELAYED',
      next_poll_at: new Date(Date.now() + 3600000).toISOString() });
    await h.store.replace(pending, pending.revision);
    const unknown = await h.store.ensure('unknown', { verificationMode: mode });
    Object.assign(unknown, { job_status: 'NEEDS_ATTENTION', stage: 'SERVER', operation: 'poll_submission',
      status: 'SUBMISSION_UNKNOWN', source_hash: 'uncertain-hash' });
    await h.store.replace(unknown, unknown.revision);
    await h.store.ensure('b', { verificationMode: mode });
    h.disproveRoot();
    h.hooks.poll = async () => assert.fail('a disproved root must not keep polling');
    for (let restart = 0; restart < 2; restart++) {
      const summary = await h.run();
      assert.equal(summary.status, 'DISPROVED'); assert.equal(summary.completed, false);
      assert.equal(summary.root_status, 'Disproved'); assert.ok(summary.finished_at);
      assert.equal(summary.visits, 0); assert.deepEqual(summary.ready_work, []);
      assert.match(summary.waiting_reason, /target disproved/);
      assert.equal(summary.pending_external_actions.find(s => s.theorem_id === 'a').submission_id, 'already-issued');
      const saved = await h.store.read('a');
      assert.equal(saved.status, 'PENDING'); assert.equal(saved.source_hash, 'saved-hash');
      assert.equal(saved.next_poll_at, pending.next_poll_at);
      assert.equal((await h.store.read('unknown')).job_status, 'NEEDS_ATTENTION');
      assert.equal((await h.store.read('unknown')).source_hash, 'uncertain-hash');
      assert.equal((await h.store.read('b')).job_status, 'RETIRED');
      assert.equal(JSON.parse(await readFile(join(h.runs, 'last-run.json'), 'utf8')).status, 'DISPROVED');
    }
    assert.equal(h.models.length, 0); assert.equal(h.posts.length, 0); assert.equal(h.workspaces.length, 0);
  }
});

test('root disproof cancels an active model and retires siblings without further uploads', async t => {
  const h = await fixture(t, ['a', 'b', 'c']); let running = false, stopped = false;
  h.hooks.agent = async (...args) => {
    running = true;
    try {
      const signal = args[5].signal;
      await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    } finally { stopped = true; }
  };
  const run = h.run();
  try {
    await until(() => running); h.disproveRoot();
    const summary = await run;
    assert.equal(summary.status, 'DISPROVED'); assert.equal(stopped, true);
    assert.equal(summary.codex_permits_used, 0); assert.equal(h.posts.length, 0);
    const job = await h.store.read('a');
    assert.equal(job.job_status, 'RETIRED'); assert.equal(job.attempt_count, 1);
    assert.equal(job.history.at(-1).result, 'interrupted');
    assert.ok([...(await h.store.index()).values()].every(s => s.job_status !== 'ACTIVE'));
  } finally { h.controller.abort(new Error('cleanup')); await run.catch(() => {}); }
});

test('root disproof stops an active server poll without losing its submission journal', async t => {
  const h = await fixture(t, ['a']), generate = h.hooks.agent;
  let polling = false, stopped = false, signal;
  h.hooks.agent = async (...args) => { signal = args[5].signal; return generate(...args); };
  h.hooks.poll = async () => {
    polling = true;
    try {
      await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    } finally { stopped = true; }
  };
  const run = h.run();
  try {
    await until(() => polling); h.disproveRoot();
    const summary = await run;
    assert.equal(summary.status, 'DISPROVED'); assert.equal(stopped, true);
    const job = await h.store.read('a');
    assert.equal(job.status, 'PENDING'); assert.equal(job.submission_id, 'sub-a');
    assert.ok(job.artifact_manifest); assert.ok(job.submission_started_at);
    assert.deepEqual(h.posts, ['a']);
  } finally { h.controller.abort(new Error('cleanup')); await run.catch(() => {}); }
});

test('root completion drains a running model, commits its candidate and retires queued work without uploads', async t => {
  const h = await fixture(t), model = barrier(); let running = false;
  const generate = h.hooks.agent;
  h.hooks.agent = async (...args) => { running = true; await model.promise; return generate(...args); };
  const run = h.run();
  await until(() => running); h.proveRoot();
  await until(async () => (await h.store.read('a'))?.retirement_requested);
  assert.equal(h.posts.length, 0);
  let completed = false; run.then(() => { completed = true; });
  await new Promise(resolve => setTimeout(resolve, 25)); assert.equal(completed, false);
  model.release(); const summary = await run;
  assert.equal(summary.completed, true); assert.equal(h.posts.length, 0);
  const job = await h.store.read('a');
  assert.equal(job.job_status, 'RETIRED'); assert.ok(job.candidate);
  assert.equal(JSON.parse(await readFile(job.candidate.path, 'utf8')).source, 'theorem solution : True := by trivial');
});

test('root completion reconciles an already issued pending submission before reporting success', async t => {
  const h = await fixture(t, ['a']), final = barrier(); let polls = 0;
  h.hooks.poll = async () => {
    if (++polls === 1) return { status: 'PENDING' };
    await final.promise; h.done.add('a'); return { status: 'ACCEPTED' };
  };
  const run = h.run(); await until(() => polls === 1); h.proveRoot();
  await until(() => polls === 2);
  let completed = false; run.then(() => { completed = true; });
  await new Promise(resolve => setTimeout(resolve, 25)); assert.equal(completed, false);
  final.release(); assert.equal((await run).completed, true);
  assert.equal(h.posts.length, 1); assert.equal((await h.store.read('a')).status, 'ACCEPTED');
});

test('graph requests during discovery require another build and getWork claims only the final snapshot', async t => {
  const h = await fixture(t), selection = new WorkSelection(h.options), gate = barrier(); let builds = 0;
  const refresh = selection.buildGraph({}, 'root', async () => {
    const pass = ++builds;
    if (pass === 1) await gate.promise;
    return { root: { theorem_id: 'root', status: 'Open' }, leaves: [{ theorem_id: pass === 1 ? 'old' : 'new', status: 'Open' }] };
  });
  await until(() => builds === 1); await selection.requestGraphRefresh('arrived during discovery');
  const claim = selection.getWork(); gate.release(); await refresh;
  assert.equal((await claim).theorem_id, 'new'); assert.equal(builds, 2);
  assert.equal(selection.requestedGeneration, selection.committedGeneration);
});

test('graph reads keep retrying 404s and transient failures past three attempts, with a delay', async t => {
  for (const status of [404, 503]) {
    const h = await fixture(t, []);
    let now = 1000, reads = 0, waits = 0;
    const pipeline = new Pipeline(h.client, h.target, { ...h.options, refreshInterval: 30 }, {
      now: () => now,
      frontier: async () => {
        reads++;
        assert.equal(now, 1000 + (reads - 1) * 30000, 'no graph retry before its deadline');
        if (reads <= 4) throw new ApiError(status, '/api/v1/theorems/root/decompositions');
        return { root: { theorem_id: 'root', status: 'Proved' }, leaves: [] };
      },
      wait: async milliseconds => { waits++; assert.equal(milliseconds, 30000); now += milliseconds; },
      onCheckpoint: summary => {
        assert.equal(summary.status === 'ERROR', false);
        if (!summary.completed) assert.match(summary.waiting_reason, new RegExp(`HTTP ${status}.*retrying in 30s`));
      },
    });
    assert.equal((await pipeline.run()).completed, true);
    assert.equal(reads, 5); assert.equal(waits, 4);
    assert.equal((await h.store.index()).size, 0);
  }
});

test('committed work keeps being admitted during a graph 404 outage with live target checks', async t => {
  const h = await fixture(t, ['a', 'b']);
  h.options.pipeline.maxActiveJobs = 1;
  h.options.refreshInterval = 0.2;
  const frontier = h.hooks.frontier, generate = h.hooks.agent;
  let reads = 0, outage = false, recovered = false, retryObserved = false;
  h.hooks.frontier = async (...args) => {
    reads++;
    if (outage && !recovered) { retryObserved = true; throw new ApiError(404, '/api/v1/theorems/root/decompositions'); }
    return frontier(...args);
  };
  h.hooks.agent = async (...args) => {
    if (args[0].theorem_id === 'a') {
      outage = true;
      await until(() => retryObserved);
    }
    if (args[0].theorem_id === 'b') assert.equal(recovered, false, 'admission does not wait for full discovery recovery');
    return generate(...args);
  };
  h.hooks.onCheckpoint = async summary => {
    if (!recovered && h.done.has('b')) {
      assert.equal(summary.status, 'RUNNING');
      assert.deepEqual(h.posts, ['a', 'b']);
      recovered = true;
    }
  };
  assert.equal((await h.run()).completed, true);
  assert.equal(recovered, true); assert.ok(reads >= 3);
  assert.deepEqual(h.models.map(row => row.id), ['a', 'b']);
});

test('an empty local pool can start committed work while full discovery is still running', async t => {
  const h = await fixture(t, ['a']), scan = barrier(), frontier = h.hooks.frontier;
  let builds = 0, started = false;
  const pipeline = new Pipeline(h.client, h.target, { ...h.options, graphRefreshInterval: 600 }, {
    ...h.hooks,
    frontier: async () => {
      if (++builds === 2) await scan.promise;
      return frontier();
    },
    runJob: async (_job, { signal }) => {
      started = true;
      await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    },
  });
  await pipeline.refresh(); await pipeline.refreshing;
  await pipeline.refresh(); await until(() => builds === 2);
  assert.equal(pipeline.controls.size, 0);
  const run = pipeline.run();
  try {
    await until(() => started);
    assert.ok(pipeline.refreshing, 'the claim did not wait for the network scan');
  } finally {
    h.controller.abort(new Error('background admission test complete')); scan.release();
    await assert.rejects(run, /background admission test complete/);
  }
});

test('a graph 404 discovered while claiming work also schedules a retry', async t => {
  const h = await fixture(t, ['a']);
  let now = 1000, reads = 0, waits = 0;
  const pipeline = new Pipeline(h.client, h.target, { ...h.options, refreshInterval: 30 }, {
    now: () => now,
    frontier: async () => {
      if (++reads === 2) throw new ApiError(404, '/api/v1/theorems/root/decompositions');
      if (reads === 3) assert.equal(now, 31000, 'the required graph read retries at its recovery deadline');
      return { root: { theorem_id: 'root', status: reads >= 3 ? 'Proved' : 'Open' }, leaves: [{ theorem_id: 'a', status: 'Open' }] };
    },
    wait: async milliseconds => {
      if (pipeline.refreshing) { await pipeline.refreshing; return; }
      waits++; assert.equal(milliseconds, 30000); now += milliseconds;
    },
  });
  const getWork = pipeline.selection.getWork.bind(pipeline.selection);
  pipeline.selection.getWork = async options => {
    await pipeline.selection.requestGraphRefresh('required invalidation between freshness check and claim');
    return getWork(options);
  };
  assert.equal((await pipeline.run()).completed, true);
  assert.equal(waits, 1); assert.equal(reads, 3);
  assert.equal((await h.store.index()).size, 0);
});

test('an ongoing graph 404 wait can be interrupted, while permission failures still stop', async t => {
  for (const status of [404, 403]) {
    const h = await fixture(t, []);
    let reads = 0;
    const pipeline = new Pipeline(h.client, h.target, h.options, {
      frontier: async () => { reads++; throw new ApiError(status, '/api/v1/theorems/root/decompositions'); },
      wait: async () => h.controller.abort(new Error('operator stopped retrying')),
    });
    await assert.rejects(pipeline.run(), status === 404 ? /operator stopped retrying/ : /HTTP 403/);
    assert.equal(reads, 1);
    const saved = JSON.parse(await readFile(join(h.runs, 'last-run.json'), 'utf8'));
    assert.equal(saved.status, status === 404 ? 'INTERRUPTED' : 'ERROR');
  }
});

test('graph refreshes coalesce behind ten minutes while work remains, including requests during discovery', async t => {
  const h = await fixture(t, ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']), gate = barrier();
  delete h.options.graphRefreshInterval;
  let now = 1000, builds = 0;
  const frontier = h.hooks.frontier;
  const pipeline = new Pipeline(h.client, h.target, h.options, {
    now: () => now,
    frontier: async () => {
      if (++builds === 2) await gate.promise;
      return frontier();
    },
  });
  await pipeline.refresh(); await pipeline.refreshing;
  let index = await h.store.index();
  for (let n = 0; n < 10; n++) await pipeline.requestRefresh('terminal outcome');
  assert.equal(pipeline.graphDue(index), 601000);
  assert.equal(pipeline.selection.requestedGeneration, pipeline.selection.committedGeneration);
  const claimed = await pipeline.selection.getWork({ runId: pipeline.runId });
  assert.equal(claimed.theorem_id, 'a', 'deferred outcomes do not block atomic admission');
  index = await h.store.index();
  assert.equal(pipeline.lowWork(index), false, 'seven remaining candidates are sufficient');
  now = 600999; assert.equal(pipeline.graphDue(index), 601000);
  now++;
  await pipeline.refresh(); await until(() => builds === 2);
  await pipeline.requestRefresh('outcome during discovery'); gate.release(); await pipeline.refreshing;
  assert.equal(builds, 2, 'deferred requests cannot force a catch-up loop within discovery');
  assert.equal(pipeline.refreshPending, true);
  assert.equal(pipeline.graphDue(await h.store.index()), 1201000);
});

test('early reconciliation requires an empty actionable frontier without active jobs or pending updates', async t => {
  const h = await fixture(t, ['a', 'b', 'c', 'd', 'e', 'f']);
  delete h.options.graphRefreshInterval;
  let now = Date.now();
  const pipeline = new Pipeline(h.client, h.target, h.options, { ...h.hooks, now: () => now });
  await pipeline.refresh(); await pipeline.refreshing;
  await pipeline.requestRefresh('server outcome');
  assert.equal(pipeline.lowWork(await h.store.index()), false, 'exactly six candidates respect the throttle');
  assert.equal(pipeline.graphDue(await h.store.index()), now + 600000);
  const claim = await pipeline.selection.getWork({ runId: pipeline.runId });
  assert.equal(pipeline.lowWork(await h.store.index()), false, 'active work and five available candidates do not cause a scan');
  assert.equal(pipeline.graphDue(await h.store.index()), now + 600000);
  claim.job.job_status = 'READY'; claim.job.retry_after = new Date(now + 60000).toISOString();
  assert.equal(await h.store.replace(claim.job, claim.job.revision), true);
  for (const id of ['b', 'c', 'd', 'e', 'f']) {
    const state = await h.store.ensure(id);
    state.job_status = 'READY'; state.retry_after = new Date(now + 60000).toISOString();
    assert.equal(await h.store.replace(state, state.revision), true);
  }
  assert.equal(pipeline.lowWork(await h.store.index()), true, 'all candidates are unavailable and no job is active');
  assert.equal(pipeline.graphDue(await h.store.index()), now);
  pipeline.selection.updates.push({ pending: true });
  assert.equal(pipeline.lowWork(await h.store.index()), false, 'targeted reads take priority over a full scan');
});

test('failed attempts rerank locally without requesting discovery and retain the configured periodic deadline', async t => {
  const h = await fixture(t, ['a', 'b', 'c']), model = barrier(), generate = h.hooks.agent, frontier = h.hooks.frontier;
  h.options.pipeline.maxActiveJobs = 1;
  h.options.graphRefreshInterval = 120; h.options.refreshInterval = 30;
  let now = Date.now(), builds = 0, secondStarted = false, checkpoint;
  const startedAt = now;
  h.hooks.now = () => now;
  h.hooks.wait = () => new Promise(resolve => setTimeout(resolve, 2));
  h.hooks.frontier = async (...args) => { builds++; return frontier(...args); };
  h.hooks.onCheckpoint = summary => { checkpoint = summary; };
  h.hooks.agent = async (...args) => {
    const candidate = await generate(...args);
    if (args[0].theorem_id === 'a') return { ...candidate, ready: false };
    secondStarted = true; await model.promise; return candidate;
  };
  const run = h.run();
  try {
    await until(() => secondStarted && checkpoint);
    assert.equal(checkpoint.graph_refresh_pending, false);
    assert.equal(builds, 1, 'the next claim did not force discovery');
    assert.deepEqual(h.models.map(m => m.id), ['a', 'b']);
    now = startedAt + 119999;
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(builds, 1);
    now++;
    await until(() => builds === 2);
  } finally {
    h.controller.abort(new Error('throttle test complete')); model.release();
    await assert.rejects(run, /throttle test complete/);
  }
});

test('an unchanged empty frontier polls at the recovery interval without spinning or waiting ten minutes', async t => {
  const h = await fixture(t, []);
  delete h.options.graphRefreshInterval;
  let now = 1000, builds = 0, waits = 0;
  const request = h.client.request;
  h.client.request = async path => path === 'theorems/root' ? { theorem_id: 'root', status: 'Open' } : request(path);
  const pipeline = new Pipeline(h.client, h.target, { ...h.options, refreshInterval: 30 }, {
    now: () => now,
    frontier: async () => {
      assert.equal(now, 1000 + builds * 30000);
      return { root: { theorem_id: 'root', status: ++builds === 3 ? 'Proved' : 'Open' }, leaves: [] };
    },
    wait: async ms => { assert.equal(ms, 30000); waits++; now += ms; },
  });
  assert.equal((await pipeline.run()).completed, true);
  assert.equal(builds, 3); assert.equal(waits, 2);
});

test('failed attempts and formatting handoffs reuse the graph, and completion uses a root check', async t => {
  const h = await fixture(t, ['a']), server = barrier(), frontier = h.hooks.frontier, generate = h.hooks.agent;
  delete h.options.graphRefreshInterval;
  h.options.refreshInterval = 30;
  let builds = 0, polling = false, formats = 0;
  h.hooks.frontier = async (...args) => { builds++; return frontier(...args); };
  h.hooks.agent = async (...args) => {
    const candidate = await generate(...args);
    return args[3] === 1 ? { ...candidate, ready: false } : { ...candidate, explanation: '' };
  };
  h.hooks.repairAnswer = async (_t, _w, _d, _a, _f, candidate) => {
    formats++; return { ...candidate, explanation: 'Trivial.' };
  };
  h.hooks.poll = async () => {
    polling = true; await server.promise; h.done.add('a'); return { status: 'ACCEPTED' };
  };
  const run = h.run();
  try {
    await until(async () => {
      const job = await h.store.read('a');
      assert.notEqual(job?.job_status, 'UNRESOLVED', job?.feedback);
      return polling;
    });
    assert.equal(h.models.length, 2); assert.equal(formats, 1);
    assert.equal(builds, 1, 'an unsuccessful attempt does not need discovery');
  } finally {
    server.release();
    if (!polling) {
      h.controller.abort(new Error('handoff test stopped'));
      await run.catch(() => {});
    }
  }
  assert.equal((await run).completed, true);
  assert.equal(builds, 1, 'accepted work is applied locally and root completion is checked directly');
});

test('a wake during the final job-index read is handled before the coordinator sleeps', async t => {
  const h = await fixture(t, []);
  let builds = 0, injectWake = false;
  const request = h.client.request;
  h.client.request = async path => path === 'theorems/root' ? { theorem_id: 'root', status: 'Open' } : request(path);
  const pipeline = new Pipeline(h.client, h.target, h.options, {
    frontier: async () => ({ root: { theorem_id: 'root', status: ++builds === 2 ? 'Proved' : 'Open' }, leaves: [] }),
    onCheckpoint: () => { if (builds === 1) injectWake = true; },
    wait: async () => {
      // A cached index can finish before the asynchronous graph commit. Allow
      // that in-flight refresh to complete, without sleeping on a timer.
      assert.ok(pipeline.refreshing, 'ready work must not wait for a periodic timer');
      await new Promise(resolve => setImmediate(resolve));
    },
  });
  const readIndex = pipeline.store.index.bind(pipeline.store);
  pipeline.store.index = async () => {
    if (injectWake) {
      injectWake = false;
      await pipeline.requestRefresh('outcome arrived during index read');
    }
    return readIndex();
  };
  assert.equal((await pipeline.run()).completed, true);
  assert.equal(builds, 2);
});

test('reduced capacities preserve and drain restored queues without admitting fresh work', async t => {
  const h = await fixture(t, ['a', 'b', 'c', 'd']);
  for (const id of ['a', 'b', 'c']) await h.store.ensure(id, { attempts: 3, rootId: 'root' });
  h.options.pipeline = { maxActiveJobs: 1, queues: { prepare: { maxSize: 1 }, codex: { maxSize: 1, concurrency: 1 } } };
  const summary = await h.run(); assert.equal(summary.completed, true);
  assert.deepEqual(h.models.map(m => m.id), ['a', 'b', 'c', 'd']);
  for (const id of ['a', 'b', 'c']) assert.equal((await h.store.read(id)).attempt_budget, 3);
});

test('API permits bound requests including slow verification while leaving graph capacity', async t => {
  const gate = barrier(); let running = 0, peak = 0, started = 0;
  const client = new Client('key', async () => {
    started++; peak = Math.max(peak, ++running); await gate.promise; running--;
    return new Response('{}', { headers: { 'Content-Type': 'application/json' } });
  });
  client.token = 'ready'; client.expiry = Date.now() + 3600000;
  const requests = Array.from({ length: defaults.apiConcurrency + 2 }, (_, i) => client.request(i === 0 ? 'verify' : `theorems/${i}`));
  await until(() => started === defaults.apiConcurrency); assert.equal(peak, defaults.apiConcurrency);
  gate.release(); await Promise.all(requests); assert.equal(peak, defaults.apiConcurrency);
});

test('configuration rejects unbounded or unsupported worker settings', () => {
  assert.throws(() => pipelineLimits({ maxActiveJobs: 0 }), /positive/);
  assert.equal(pipelineLimits().queues.CODEX.concurrency, defaults.queues.codex.concurrency);
  assert.equal(pipelineLimits({ queues: { codex: { concurrency: 5 } } }).queues.CODEX.concurrency, 5);
  assert.equal(pipelineLimits({ queues: { prepare: { concurrency: 2 } } }).queues.PREPARE.concurrency, 2);
  assert.equal(pipelineLimits({ verificationMode: 'local', queues: { prepare: { concurrency: 2 } } }).queues.PREPARE.concurrency, 1);
  assert.throws(() => pipelineLimits({ unknown: 1 }), /Unknown/);
});

for (const cap of [1, 2, 3]) {
  test(`Codex cap ${cap} covers proof, compiler repair, format repair and remote rejection under saturation`, async t => {
    const h = await fixture(t, ['a', 'b', 'c', 'd', 'e']), wave = barrier();
    h.options.pipeline = { queues: { codex: { concurrency: cap } } };
    let live = 0, peak = 0, compilerRejected = false, serverRejected = false;
    const active = new Set(), calls = [], observations = [];
    async function invocation(id, operation, options, action) {
      options.assertModelSlot();
      assert.equal(active.has(id), false, 'one model action per theorem');
      active.add(id); peak = Math.max(peak, ++live);
      assert.ok(live <= cap); calls.push({ id, operation });
      try {
        if (calls.length <= cap) await wave.promise;
        else await new Promise(resolve => setTimeout(resolve, 15));
        return await action();
      } finally { active.delete(id); live--; }
    }
    h.hooks.agent = async (target, workspace, _dir, attempt, feedback, options) => {
      h.models.push({ id: target.theorem_id, attempt, feedback });
      return invocation(target.theorem_id, attempt === 1 ? 'implement' : 'repair', options, async () => {
        const module = `Solutions.Sol_${target.theorem_id}`, solution = join(workspace, `${module.replaceAll('.', '/')}.lean`);
        await writeFile(solution, 'theorem solution : True := by trivial');
        return { kind: 'proof', ready: true, explanation: target.theorem_id === 'b' ? '' : 'Trivial.',
          children: [], definitions: [], module, solution };
      });
    };
    h.hooks.repairAnswer = async (target, _workspace, _dir, _attempt, _feedback, candidate, options) =>
      invocation(target.theorem_id, 'format_repair', options, async () => ({ ...candidate, explanation: 'Trivial.' }));
    const command = h.hooks.command;
    h.hooks.command = async (...args) => {
      assert.equal(active.has(args[2].cwd.includes('workspace-a-') ? 'a' : args[2].cwd.match(/workspace-(\w+)-/)[1]), false,
        'validation does not overlap its own model');
      if (!compilerRejected && args[2].cwd.includes('workspace-a-')) {
        compilerRejected = true; await writeFile(args[2].log, 'line 7: exact compiler diagnostic');
        throw new Error('local build failed');
      }
      return command(...args);
    };
    h.hooks.poll = async (_client, submissionId) => {
      const id = submissionId.slice(4);
      if (id === 'c' && !serverRejected) {
        serverRejected = true; return { status: 'REJECTED', error_message: 'exact remote diagnostic' };
      }
      h.done.add(id); return { status: 'ACCEPTED' };
    };
    h.hooks.onCheckpoint = summary => {
      observations.push(summary);
      assert.ok(summary.pipeline.localActive <= summary.limits.maxActiveJobs);
      for (const [stage, queue] of Object.entries(summary.pipeline.queues)) {
        assert.ok(queue.running <= summary.limits.queues[stage].concurrency);
        assert.ok(queue.queued + queue.reserved <= summary.limits.queues[stage].maxSize);
      }
    };
    const run = h.run();
    try {
      await until(() => live === cap);
      await until(() => observations.some(s => s.codex_permits_used === cap));
      assert.equal(calls.length, cap);
    } finally { wave.release(); }
    const summary = await run;
    assert.equal(summary.completed, true); assert.equal(peak, cap);
    assert.deepEqual(calls.filter(c => c.operation === 'implement').map(c => c.id).sort(), ['a', 'b', 'c', 'd', 'e']);
    assert.equal(calls.filter(c => c.operation === 'format_repair').length, 1);
    assert.equal(calls.filter(c => c.operation === 'repair').length, 2, JSON.stringify(h.models));
    assert.equal(h.models.find(m => m.id === 'a' && m.attempt === 2).feedback, 'local build failed\nline 7: exact compiler diagnostic');
    assert.equal(h.models.find(m => m.id === 'c' && m.attempt === 2).feedback,
      JSON.stringify({ status: 'REJECTED', error_message: 'exact remote diagnostic' }, null, 2) + '\n');
    assert.equal((await h.store.read('b')).attempts_used_in_job, 1);
  });
}

test('format repair owns one of the two default slots while other proof jobs contend', async t => {
  const h = await fixture(t, ['a', 'b', 'c']), format = barrier(), proof = barrier(), ready = barrier();
  h.options.pipeline = { maxActiveJobs: 2 };
  let formatting = false, proofs = 0;
  h.hooks.preflight = async target => { if (target.theorem_id !== 'a') await ready.promise; };
  const generate = h.hooks.agent;
  h.hooks.agent = async (...args) => {
    args[5].assertModelSlot();
    if (args[0].theorem_id !== 'a') { proofs++; await proof.promise; }
    const candidate = await generate(...args);
    return args[0].theorem_id === 'a' ? { ...candidate, explanation: '' } : candidate;
  };
  h.hooks.repairAnswer = async (_target, _w, _d, _a, _f, candidate, options) => {
    options.assertModelSlot(); formatting = true; await format.promise;
    return { ...candidate, explanation: 'Trivial.' };
  };
  const run = h.run();
  try {
    await until(() => formatting); ready.release();
    await until(async () => proofs === 1 && JSON.parse(await readFile(join(h.runs, 'last-run.json'), 'utf8')).codex_permits_used === 2);
    const snapshot = JSON.parse(await readFile(join(h.runs, 'last-run.json'), 'utf8'));
    assert.equal(snapshot.codex_permits_used, 2); assert.equal(proofs, 1);
    format.release(); await until(() => proofs === 2);
  } finally { ready.release(); format.release(); proof.release(); assert.equal((await run).completed, true); }
});

test('two interrupted model calls drain and restart with one slot inside their original budgets', async t => {
  const h = await fixture(t); delete h.options.pipeline;
  const running = new Set();
  h.hooks.agent = async (target, _workspace, _dir, _attempt, _feedback, options) => {
    options.assertModelSlot(); running.add(target.theorem_id);
    try {
      await new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
    } finally { running.delete(target.theorem_id); }
  };
  const run = h.run(); await until(() => running.size === 2);
  h.controller.abort(new Error('interrupt both model calls'));
  await assert.rejects(run, /interrupt both/); assert.equal(running.size, 0);
  const before = await Promise.all(['a', 'b'].map(id => h.store.read(id)));
  assert.ok(before.every(s => s.attempts_used_in_job === 1 && s.attempt_budget === 3));
  h.options.signal = undefined; h.options.attempts = 99;
  h.options.pipeline = { queues: { codex: { concurrency: 1 } } };
  let live = 0, peak = 0;
  h.hooks.agent = async (target, workspace, _dir, attempt, feedback, options) => {
    options.assertModelSlot(); peak = Math.max(peak, ++live);
    assert.equal(attempt, 2); assert.match(feedback, /Interrupted implement invocation/);
    const module = `Solutions.Sol_${target.theorem_id}`, solution = join(workspace, `${module.replaceAll('.', '/')}.lean`);
    try { await writeFile(solution, 'theorem solution : True := by trivial'); }
    finally { live--; }
    return { kind: 'proof', ready: true, explanation: 'Trivial.', children: [], definitions: [], module, solution };
  };
  assert.equal((await h.run()).completed, true); assert.equal(peak, 1);
  for (const previous of before) {
    const job = await h.store.read(previous.theorem_id);
    assert.equal(job.job_id, previous.job_id); assert.equal(job.attempt_budget, 3);
    assert.equal(job.attempts_used_in_job, 2);
  }
});

test('a model call from preparation fails the slot assertion before any invocation', async t => {
  const h = await fixture(t, ['a']); let invoked = false;
  const pipeline = new Pipeline(h.client, h.target, h.options, {
    frontier: h.hooks.frontier,
    runJob: async (_job, control) => { control.assertModelSlot(); invoked = true; },
  });
  await assert.rejects(pipeline.run(), /does not own a Codex dispatch slot/);
  assert.equal(invoked, false); assert.equal((await h.store.read('a')).attempts_used_in_job, 0);
});

for (const dispatch of ['QUEUED', 'HANDOFF_PENDING']) {
  test(`dispatch ignores a completed job from a stale ${dispatch} snapshot and continues other work`, async t => {
    const h = await fixture(t), invoked = [];
    const pipeline = new Pipeline(h.client, h.target, h.options, {
      runJob: async job => {
        invoked.push(job.theorem_id);
        job.job_status = 'DONE'; job.status = 'ACCEPTED';
        assert.equal(await h.store.replace(job, job.revision), true);
        return job.status;
      },
    });
    const job = await h.store.ensure('a', { attempts: 3 });
    Object.assign(job, { stage: 'SERVER', operation: 'poll_submission', status: 'ACCEPTED', dispatch_state: dispatch });
    if (dispatch === 'HANDOFF_PENDING') job.pending_outcome = {
      stage: 'SERVER', operation: 'poll_submission', dispatch_state: 'QUEUED',
    };
    await h.store.replace(job, job.revision);
    await h.store.ensure('b', { attempts: 3 });
    const snapshot = await h.store.index();
    // The worker completes and removes its control while the coordinator is
    // still reading its index, which retains the earlier ACTIVE record.
    job.job_status = 'DONE'; job.dispatch_state = 'QUEUED'; delete job.pending_outcome;
    await h.store.replace(job, job.revision);
    const accepted = await h.store.read('a');
    const index = pipeline.store.index.bind(pipeline.store);
    let first = true;
    t.mock.method(pipeline.store, 'index', async () => {
      if (!first) return index();
      first = false; return snapshot;
    });

    await pipeline.routeAndDispatch();
    await Promise.all([...pipeline.controls.values()].map(c => c.promise));
    assert.equal(pipeline.failure, undefined);
    assert.deepEqual(invoked, ['b']);
    assert.deepEqual(await h.store.read('a'), accepted, 'accepted proof state is untouched');
    assert.equal((await h.store.read('b')).status, 'ACCEPTED');
  });
}

test('graph retirement can clear a later waiter while another handoff is persisted', async t => {
  const h = await fixture(t), pipeline = new Pipeline(h.client, h.target, {
    ...h.options, verificationMode: 'server-only',
  });
  const resumed = [], rejected = [];
  for (const id of ['a', 'b']) {
    const state = await h.store.ensure(id, { verificationMode: 'server-only' });
    Object.assign(state, { stage: 'CODEX', operation: 'implement', dispatch_state: 'HANDOFF_PENDING',
      pending_outcome: { stage: 'SERVER', operation: 'submit', dispatch_state: 'QUEUED' } });
    assert.equal(await h.store.replace(state, state.revision), true);
    pipeline.controls.set(id, { running: null, waiting: { state,
      resolve: () => resumed.push(id), reject: error => rejected.push({ id, error }),
      persist: async () => {
        assert.equal(await h.store.replace(state, state.revision), true);
        if (id === 'a' && !h.done.has('b')) {
          h.done.add('b');
          pipeline.selection.graph = await h.hooks.frontier();
          await pipeline.reconcileRelevance();
        }
      },
    } });
  }

  await pipeline.routeAndDispatch();
  assert.deepEqual(resumed, ['a']);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].id, 'b');
  assert.ok(rejected[0].error instanceof RetiredJob);
  assert.equal((await h.store.read('b')).job_status, 'RETIRED');
  assert.equal(pipeline.controls.get('b').waiting, null);
  assert.equal(pipeline.failure, undefined);
});

for (const boundary of ['handoff', 'dispatch']) {
  test(`graph retirement during ${boundary} persistence preserves the retired job`, async t => {
    const h = await fixture(t, ['a']), pipeline = new Pipeline(h.client, h.target, h.options);
    const state = await h.store.ensure('a');
    Object.assign(state, { stage: 'CODEX', operation: 'implement' });
    if (boundary === 'handoff') {
      state.dispatch_state = 'HANDOFF_PENDING';
      state.pending_outcome = { stage: 'VALIDATE', operation: 'validate', dispatch_state: 'QUEUED' };
    }
    assert.equal(await h.store.replace(state, state.revision), true);
    let retired, rejected;
    const control = { running: null, waiting: { state, resolve: () => assert.fail('retired work must not resume'),
      reject: error => { rejected = error; },
      persist: async () => {
        retired = await h.store.retire('a');
        assert.ok(retired);
        if (!await h.store.replace(state, state.revision)) throw new JobPersistenceError('Stale pipeline dispatch');
      },
    } };
    pipeline.controls.set('a', control);

    await pipeline.routeAndDispatch();
    assert.ok(rejected instanceof RetiredJob);
    assert.equal(control.waiting, null);
    assert.equal(control.running, null);
    assert.deepEqual(await h.store.read('a'), retired);
    assert.equal(pipeline.failure, undefined);
  });
}

test('handoff persistence errors for active jobs still fail dispatch', async t => {
  const h = await fixture(t, ['a']), pipeline = new Pipeline(h.client, h.target, h.options);
  const state = await h.store.ensure('a');
  Object.assign(state, { stage: 'CODEX', operation: 'implement', dispatch_state: 'HANDOFF_PENDING',
    pending_outcome: { stage: 'VALIDATE', operation: 'validate', dispatch_state: 'QUEUED' } });
  assert.equal(await h.store.replace(state, state.revision), true);
  const failure = new JobPersistenceError('Cannot save handoff');
  pipeline.controls.set('a', { running: null, waiting: { state,
    persist: async () => { throw failure; }, resolve: assert.fail, reject: assert.fail,
  } });
  await assert.rejects(pipeline.routeAndDispatch(), error => error === failure);
  assert.equal((await h.store.read('a')).job_status, 'ACTIVE');
});

test('a stale queue entry cannot dispatch a handoff whose destination is full', async t => {
  const h = await fixture(t), pipeline = new Pipeline(h.client, h.target, {
    ...h.options, pipeline: { queues: { codex: { maxSize: 1 } } },
  });
  const job = await h.store.ensure('a', { attempts: 3 });
  Object.assign(job, { stage: 'SERVER', operation: 'poll_submission', status: 'REJECTED' });
  await h.store.replace(job, job.revision);
  await h.store.ensure('b', { attempts: 3 });
  const snapshot = await h.store.index();
  job.dispatch_state = 'HANDOFF_PENDING';
  job.pending_outcome = { stage: 'CODEX', operation: 'repair', dispatch_state: 'QUEUED' };
  await h.store.replace(job, job.revision);
  let resumed = false;
  const waiting = { state: job, resolve: () => { resumed = true; },
    persist: async () => assert.fail('handoff destination has no capacity'), reject: assert.fail };
  pipeline.controls.set('a', { running: null, waiting });
  pipeline.controls.set('b', { running: 'PREPARE', waiting: null });
  t.mock.method(pipeline.store, 'index', async () => snapshot);

  await pipeline.routeAndDispatch();
  assert.equal(resumed, false, 'the old SERVER entry must not bypass the pending CODEX handoff');
  assert.equal(pipeline.controls.get('a').waiting, waiting);
  assert.equal(pipeline.controls.get('a').running, null);
  assert.equal((await h.store.read('a')).dispatch_state, 'HANDOFF_PENDING');
});

test('a skip overtaken by completion preserves the accepted result and does not stop the run', async t => {
  const h = await fixture(t, ['a']), request = h.client.request;
  h.client.request = async path => path === 'theorems/a' ? { theorem_id: 'a', status: 'Proved' } : request(path);
  const replace = JobStore.prototype.replace;
  let accepted;
  t.mock.method(JobStore.prototype, 'replace', async function (state, revision, settings) {
    if (!accepted && state.status === 'SKIPPED (Proved)') {
      const current = await this.read('a');
      Object.assign(current, { job_status: 'DONE', status: 'ACCEPTED', submission_id: 'sub-a', verdict: { status: 'ACCEPTED' } });
      assert.equal(await replace.call(this, current, current.revision), true);
      accepted = await this.read('a'); h.done.add('a');
    }
    return replace.call(this, state, revision, settings);
  });

  const summary = await h.run();
  assert.equal(summary.completed, true);
  assert.deepEqual(summary.results, [{ theorem_id: 'a', status: 'ACCEPTED' }]);
  assert.deepEqual(await h.store.read('a'), accepted);
  assert.equal(h.models.length, 0); assert.equal(h.posts.length, 0);
});

test('a rejected skip save for an active job still fails the run', async t => {
  const h = await fixture(t, ['a']), request = h.client.request;
  h.client.request = async path => path === 'theorems/a' ? { theorem_id: 'a', status: 'Proved' } : request(path);
  const replace = JobStore.prototype.replace;
  t.mock.method(JobStore.prototype, 'replace', function (state, revision, settings) {
    return state.status === 'SKIPPED (Proved)' ? false : replace.call(this, state, revision, settings);
  });
  await assert.rejects(h.run(), /Cannot save skipped job/);
  assert.equal((await h.store.read('a')).job_status, 'ACTIVE');
  assert.equal(JSON.parse(await readFile(join(h.runs, 'last-run.json'), 'utf8')).status, 'ERROR');
});

test('a child disproof cancels its running sibling and retires queued sibling work', async t => {
  const h = await fixture(t, ['a', 'b', 'c']);
  let disproved = false, running = false, cancelled = false;
  const leaf = id => ({ theorem_id: id, theorem_name: `Goal${id}`, status: id === 'b' && disproved ? 'Disproved' : 'Open', reductions: [] });
  const originalFrontier = h.hooks.frontier;
  h.hooks.frontier = async () => {
    const graph = await originalFrontier();
    const children = ['a', 'b', 'c'].map(leaf);
    graph.root.reductions = [{ submission_id: 'sketch', children }];
    graph.nodes = [graph.root, ...children];
    graph.leaves = children.filter(n => n.status === 'Open');
    return graph;
  };
  h.hooks.agent = async (target, _workspace, _dir, _attempt, _feedback, settings) => {
    if (target.theorem_id === 'root') return { ready: false, explanation: 'Needs a replacement sketch.' };
    assert.equal(target.theorem_id, 'a'); running = true;
    await new Promise((resolve, reject) => {
      const stop = () => { cancelled = true; reject(settings.signal.reason); };
      if (settings.signal.aborted) stop();
      else settings.signal.addEventListener('abort', stop, { once: true });
    });
  };
  const run = h.run();
  try {
    await until(() => running); disproved = true;
    await until(async () => cancelled && (await h.store.read('a'))?.job_status === 'RETIRED' &&
      (await h.store.read('c'))?.job_status !== 'ACTIVE');
    assert.equal((await h.store.read('c'))?.job_status === 'ACTIVE', false);
    assert.equal(h.posts.includes('a'), false); assert.equal(h.posts.includes('b'), false);
    h.proveRoot(); assert.equal((await run).completed, true);
  } finally { h.controller.abort(new Error('cleanup')); await run.catch(() => {}); }
});

test('relevance follows usable reductions and drops alternatives once a reduction is satisfied', () => {
  const child = (id, status = 'Open') => ({ theorem_id: id, status, reductions: [] });
  const root = { theorem_id: 'root', status: 'Open', reductions: [
    { submission_id: 'broken', usable: false, children: [child('dead')] },
    { submission_id: 'usable', usable: true, children: [child('live')] },
  ] };
  const graph = { root, nodes: [root, child('dead'), child('live')], leaves: [child('dead'), child('live')] };
  assert.deepEqual([...neededTheorems(graph)], ['root', 'live']);
  root.reductions.push({ submission_id: 'usable', usable: true, children: [child('proved', 'Proved')] });
  assert.deepEqual([...neededTheorems(graph)], []);
});

test('getWork responds to shutdown while a required graph refresh is still pending', async t => {
  const h = await fixture(t), selection = new WorkSelection(h.options), gate = barrier();
  const refresh = selection.buildGraph({}, 'root', async () => {
    await gate.promise; return { root: { theorem_id: 'root', status: 'Open' }, leaves: [] };
  });
  const claim = selection.getWork({ signal: h.controller.signal });
  h.controller.abort(new Error('stop waiting for graph'));
  await assert.rejects(claim, /stop waiting/); gate.release(); await refresh;
  assert.equal((await h.store.index()).size, 0);
});

test('startup pending submission with pre-poll operation needs no environment, workspace, validation or model', async t => {
  const h = await fixture(t, ['a']), record = await h.store.ensure('a', { attempts: 2, rootId: 'root' });
  Object.assign(record, { stage: 'SERVER', operation: 'submit', dispatch_state: 'RUNNING', status: 'PENDING',
    legacy_baseline: { attempts: 1, context_id: 'initial' }, attempt_count: 1, attempts_used_in_job: 1, submission_id: 'sub-a', submissions: ['sub-a'],
    artifact_manifest: { source: 'ignored by pending recovery' } });
  await h.store.replace(record, record.revision);
  const request = h.client.request;
  h.client.request = async path => {
    assert.notEqual(path, 'environments', 'pending verdicts do not need an available environment');
    return request(path);
  };
  assert.equal((await h.run()).completed, true);
  assert.equal(h.models.length, 0); assert.equal(h.workspaces.length, 0); assert.equal(h.checks.length, 0); assert.equal(h.posts.length, 0);
  assert.equal((await h.store.read('a')).attempt_budget, 2);
});

test('unknown uploads keep reconciling while another leaf finishes and survive interruption', async t => {
  const h = await fixture(t), submit = h.client.submit;
  h.options.recovery = { initialDelayMs: 10, maxDelayMs: 10 };
  const request = h.client.request;
  h.client.request = path => path.startsWith('submissions?') ? Promise.resolve({ submissions: [], total: 0 }) : request(path);
  h.client.submit = async id => {
    if (id === 'a') { h.posts.push(id); h.done.add(id); throw new Error('POST response lost'); }
    return submit(id);
  };
  const run = h.run();
  await until(async () => (await h.store.read('b'))?.status === 'ACCEPTED' &&
    (await h.store.read('a'))?.remote_recovery?.checks > 0 &&
    JSON.parse(await readFile(join(h.runs, 'last-run.json'), 'utf8')).root_status === 'Proved');
  h.controller.abort(new Error('stop recovery test'));
  await assert.rejects(run, /stop recovery test/);
  const summary = JSON.parse(await readFile(join(h.runs, 'last-run.json'), 'utf8'));
  assert.equal(summary.status, 'INTERRUPTED'); assert.equal(summary.root_status, 'Proved');
  assert.equal(summary.completed, false); assert.equal((await h.store.read('b')).status, 'ACCEPTED');
  const unknown = await h.store.read('a');
  assert.equal(unknown.job_status, 'ACTIVE'); assert.equal(unknown.status, 'SUBMISSION_UNKNOWN');
  assert.ok(unknown.artifact_manifest); assert.ok(unknown.submission_started_at);
  assert.deepEqual(h.posts.sort(), ['a', 'b']);
  assert.ok(unknown.next_poll_at);
  assert.deepEqual(h.posts.sort(), ['a', 'b'], 'no resend before the reconciliation deadline');
});

test('unexpected job errors release admission and return diagnostics to a later repair', async t => {
  const h = await fixture(t), request = h.client.request;
  h.options.recovery = { initialDelayMs: 10, maxDelayMs: 10 };
  let failed = false;
  h.client.request = async path => {
    if (path === 'theorems/a' && !failed) { failed = true; throw new Error('repairable context failure'); }
    return request(path);
  };
  const summary = await h.run();
  assert.equal(summary.completed, true);
  assert.equal(summary.pipeline.attention, 0);
  assert.equal(h.models.filter(m => m.id === 'a').length, 1);
  assert.match(h.models.find(m => m.id === 'a').feedback, /repairable context failure/);
  assert.deepEqual(h.posts.sort(), ['a', 'b']);
});

test('startup reopens legacy attention jobs without losing their attempt budgets', async t => {
  const h = await fixture(t);
  const record = await h.store.ensure('a', { attempts: 7, rootId: 'root' });
  record.job_status = 'NEEDS_ATTENTION'; record.status = 'REPAIR_REQUIRED';
  await h.store.replace(record, record.revision);
  assert.equal((await h.run()).completed, true);
  const saved = await h.store.read('a');
  assert.equal(saved.job_status, 'DONE'); assert.equal(saved.attempt_budget, 7);
  assert.deepEqual(h.posts.sort(), ['a', 'b']);
});

test('a missing old draft reaches the next agent instead of failing reconstruction repeatedly', async t => {
  const h = await fixture(t, ['a']);
  const record = await h.store.ensure('a', { attempts: 7, rootId: 'root' });
  record.job_status = 'READY'; record.status = 'REPAIR_REQUIRED';
  record.previous_candidate = { path: join(h.runs, 'missing-draft.json'), source_hash: 'old', attempt: 0 };
  await h.store.replace(record, record.revision);
  assert.equal((await h.run()).completed, true);
  assert.equal(h.models.length, 1); assert.match(h.models[0].feedback, /Previous candidate file is missing/);
  assert.equal((await h.store.read('a')).unavailable_candidates.length, 1);
});

test('shutdown drains active model and server promises before saving an interrupted checkpoint', async t => {
  const h = await fixture(t), generate = h.hooks.agent, server = barrier(); let modelStarted = false, modelStopped = false, serverStarted = false;
  h.hooks.agent = async (...args) => {
    if (args[0].theorem_id === 'a') return generate(...args);
    modelStarted = true;
    const signal = args[5].signal;
    try {
      await new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    } finally { modelStopped = true; }
  };
  h.client.submit = async id => {
    h.posts.push(id); serverStarted = true;
    await server.promise; throw new Error('connection cancelled after POST intent');
  };
  const run = h.run(); await until(() => modelStarted && serverStarted);
  h.controller.abort(new Error('operator shutdown'));
  let drained = false; run.catch(() => { drained = true; });
  await until(() => modelStopped); assert.equal(drained, false, 'lock cannot be released while the issued request still runs');
  server.release(); await assert.rejects(run, /operator shutdown/);
  const summary = JSON.parse(await readFile(join(h.runs, 'last-run.json'), 'utf8'));
  assert.equal(summary.status, 'INTERRUPTED');
  assert.equal((await h.store.read('b')).attempts_used_in_job, 1);
  assert.ok(['SUBMITTING', 'SUBMISSION_UNKNOWN'].includes((await h.store.read('a')).status));
});

test('checkpoint identifies a retained operator pause when ready work has no active jobs', async t => {
  const h = await fixture(t, ['a']);
  const p = new Pipeline(h.client, h.target, h.options);
  await p.operator.load();
  await p.operator.execute({ id: 'pause-before-restart', action: 'pause-admission', runId: p.runId, revision: 0 });
  const restored = new Pipeline(h.client, h.target, h.options);
  await restored.operator.load();
  restored.pauseReason = 'waiting for new leaves or graph propagation';
  const summary = await restored.checkpoint();
  assert.equal(summary.pipeline.active, 0);
  assert.equal(summary.proof_storage_recovery.waiting, false);
  assert.equal(summary.waiting_reason, 'New theorem admission paused by operator');
  assert.equal(restored.canAdmit(await h.store.index()), false);
  await restored.operator.execute({ id: 'resume-after-restart', action: 'resume-admission', runId: restored.runId, revision: 1 });
  assert.equal(restored.canAdmit(await h.store.index()), true);
  assert.equal((await restored.checkpoint()).operator.admissionPaused, false);
});

test('checkpoint distinguishes simultaneous operator and storage pauses', async t => {
  const h = await fixture(t, ['a']), p = new Pipeline(h.client, h.target, h.options);
  p.operator.state.admissionPaused = true; p.operator.state.dispatchPaused = true;
  p.proofStorageRecovery.block({ theorem_id: 'a', proof_storage_retry: { failures: 1 } });
  assert.equal((await p.checkpoint()).waiting_reason,
    'New theorem admission paused by operator; Codex dispatch paused by operator; proof storage recovery also active');
  p.proofStorageRecovery.clear({ theorem_id: 'a' });
  assert.equal((await p.checkpoint()).waiting_reason,
    'New theorem admission paused by operator; Codex dispatch paused by operator');
});

test('checkpoint shows sandbox readiness failures instead of a misleading full-capacity wait', async t => {
  const h = await fixture(t, ['a']);
  const state = await h.store.ensure('a');
  Object.assign(state, { stage: 'PREPARE', job_status: 'ACTIVE', dispatch_state: 'DELAYED',
    infrastructure_wait: 'Codex environment is not ready; helper_unknown_error: setup refresh had errors' });
  await h.store.replace(state, state.revision);
  const pipeline = new Pipeline(h.client, h.target, h.options);
  pipeline.pauseReason = 'local active-job capacity full';
  const summary = await pipeline.checkpoint();
  assert.match(summary.waiting_reason, /Waiting for Codex environment recovery:.*setup refresh had errors/);
  pipeline.pauseReason = 'operator paused';
  assert.equal((await pipeline.checkpoint()).waiting_reason, 'operator paused');
});

test('preparation readiness can overlap another model and owns no Codex worker', async t => {
  const h = await fixture(t), model = barrier(), preflight = barrier(); let modelStarted = false, readyStarted = false;
  const generate = h.hooks.agent;
  h.hooks.agent = async (...args) => {
    if (args[0].theorem_id === 'a') { modelStarted = true; await model.promise; }
    return generate(...args);
  };
  h.hooks.preflight = async target => {
    if (target.theorem_id === 'b') { readyStarted = true; await preflight.promise; }
  };
  let overlap;
  h.hooks.onCheckpoint = summary => {
    if (modelStarted && readyStarted) overlap = summary.pipeline.queues;
  };
  const run = h.run(); await until(() => overlap);
  assert.equal(overlap.PREPARE.running, 1); assert.equal(overlap.CODEX.running, 1);
  assert.equal(h.models.length, 0, 'the model for the first job is still blocked');
  preflight.release(); model.release(); assert.equal((await run).completed, true);
});

test('a pending sketch can restart without a model and revalidates published dependencies outside the server slot', async t => {
  const h = await fixture(t, ['a']), request = h.client.request, generate = h.hooks.agent;
  h.options.pipeline.promptVariant = 'balanced';
  const child = { theorem_name: 'Child', theorem_title: 'Child', preamble: '',
    formal_statement: 'theorem Child : True := by sorry', natural_language_statement: 'True.' };
  const row = { ...child, theorem_id: 'child', status: 'Open', mathlib_rev: 'a'.repeat(40) };
  const source = 'import Theorems.Thm_Child\ntheorem solution : True ∧ True := by exact ⟨Child, Child⟩';
  let creates = 0, published = false;
  h.hooks.agent = async (...args) => {
    const candidate = await generate(...args); await writeFile(candidate.solution, source);
    return { ...candidate, kind: 'sketch', children: [child] };
  };
  h.client.request = async path => {
    if (path === 'theorems/child') return row;
    const response = await request(path);
    if (path === 'theorems/a') return { ...response, visibility: 'public', formal_statement: 'theorem Goala : True ∧ True := by sorry' };
    return response;
  };
  h.client.pages = async path => path.startsWith('theorems?') && published ? [row] : [];
  h.client.publish = async () => { creates++; return { job_id: 'publish-child' }; };
  h.hooks.pollPublish = async () => ({ status: published ? 'PUBLISHED' : 'COMPILING', theorem_id: 'child' });
  h.options.publishPollInterval = 60000;
  const run = h.run(); await until(async () => (await h.store.read('a'))?.dispatch_state === 'DELAYED');
  h.controller.abort(new Error('publication crash')); await assert.rejects(run, /publication crash/);
  const before = await h.store.read('a'); assert.equal(before.status, 'PUBLISH_PENDING');
  published = true; h.options.signal = undefined;
  const state = await h.store.read('a'); delete state.next_poll_at; state.dispatch_state = 'QUEUED'; await h.store.replace(state, state.revision);
  h.hooks.onCheckpoint = summary => {
    if (summary.pipeline.queues.VALIDATE.running) assert.equal(summary.pipeline.queues.SERVER.running, 0);
  };
  const summary = await h.run(); assert.equal(summary.completed, true);
  assert.equal(creates, 1); assert.equal(h.models.length, 1); assert.equal(h.posts.length, 1);
  const after = await h.store.read('a');
  assert.ok(after.artifact_manifest, JSON.stringify({ status: after.status, job_status: after.job_status, feedback: after.feedback, history: after.history }));
  assert.equal(after.artifact_manifest.source_hash, before.artifact_manifest.source_hash);
  assert.equal((await h.store.read('a')).published_dependencies[0].theorem_id, 'child');
});

test('pending server journals keep continuous operation alive until operator interruption', async t => {
  const h = await fixture(t);
  h.options.serverPollInterval = 60000;
  h.hooks.poll = async () => ({ status: 'PENDING' });
  const run = h.run();
  await until(async () => (await h.store.read('b'))?.dispatch_state === 'DELAYED');
  h.controller.abort(new Error('operator stopped remote wait'));
  await assert.rejects(run, /operator stopped remote wait/);
  assert.equal(h.models.length, 2); assert.equal(h.posts.length, 2);
  const job = await h.store.read('a');
  assert.equal(job.job_status, 'ACTIVE'); assert.equal(job.status, 'PENDING'); assert.equal(job.dispatch_state, 'DELAYED');
});

test('retiring a partly published sketch drains issued children and releases the server worker', async t => {
  const h = await fixture(t, ['a', 'b']), generate = h.hooks.agent, request = h.client.request;
  h.options.pipeline.promptVariant = 'balanced';
  h.options.verificationMode = 'server-only';
  h.options.publishPollInterval = 10;
  const children = ['First', 'Second'].map(name => ({ theorem_name: name, theorem_title: name,
    preamble: '', formal_statement: `theorem ${name} : True := by sorry`, natural_language_statement: 'True.' }));
  const row = { ...children[0], theorem_id: 'first', status: 'Open', mathlib_rev: 'a'.repeat(40) };
  const secondRow = { ...children[1], theorem_id: 'second', status: 'Open', mathlib_rev: 'a'.repeat(40) };
  let published = false, creates = 0, polls = 0;
  h.client.request = async path => path === 'theorems/second' ? secondRow : path === 'theorems/first' ? row : path === 'theorems/a'
    ? { ...await request(path), formal_statement: 'theorem Goala : True ∧ True := by sorry' } : request(path);
  h.client.publish = async () => ({ job_id: ['first', 'second'][creates++] });
  h.hooks.pollPublish = async (_client, id) => { polls++; return { status: published ? 'PUBLISHED' : 'COMPILING', theorem_id: id }; };
  h.hooks.agent = async (...args) => {
    const candidate = await generate(...args);
    if (args[0].theorem_id !== 'a') return candidate;
    await writeFile(candidate.solution, 'import Theorems.Thm_First\nimport Theorems.Thm_Second\ntheorem solution : True ∧ True := by exact ⟨First, Second⟩');
    return { ...candidate, kind: 'sketch', children };
  };
  const run = h.run();
  try {
    await until(async () => (await h.store.read('a'))?.status === 'PUBLISH_PENDING');
    h.done.add('a');
    await until(async () => (await h.store.read('a'))?.retirement_requested);
    published = true;
    const summary = await run;
    assert.equal(summary.completed, true);
    assert.equal(creates, 2, 'both independent children were issued before retirement; no new publication follows retirement');
    assert.deepEqual(h.posts, ['b'], 'unrelated proof is submitted and obsolete sketch is not');
    const old = await h.store.read('a');
    assert.ok(['DONE', 'RETIRED'].includes(old.job_status));
    assert.equal(Object.values(old.publications)[0].theorem_id, 'first');
    assert.ok(polls < 30, 'no immediate retirement/restart loop');
  } finally { h.controller.abort(new Error('cleanup')); await run.catch(() => {}); }
});

test('a retirement race with an outstanding journal parks instead of immediately restarting', async t => {
  const h = await fixture(t, []);
  let calls = 0;
  const pipeline = new Pipeline(h.client, h.target, h.options, { now: () => 1000,
    runJob: async () => { calls++; throw new RetiredJob('No longer needed'); } });
  const job = await h.store.ensure('old');
  Object.assign(job, { stage: 'SERVER', operation: 'publish', status: 'PUBLISH_PENDING', retirement_requested: true });
  await h.store.replace(job, job.revision);
  pipeline.start(job);
  const control = pipeline.controls.get('old');
  await pipeline.routeAndDispatch();
  await control.promise;
  const parked = await h.store.read('old');
  assert.equal(parked.job_status, 'ACTIVE', 'retain the outstanding remote journal');
  assert.equal(parked.dispatch_state, 'DELAYED');
  assert.equal(Date.parse(parked.next_poll_at), 1000 + pipeline.recoveryPolicy.initialDelayMs);
  await pipeline.routeAndDispatch();
  assert.equal(calls, 1, 'give other jobs a turn before retrying retirement');
});

test('same-stage remote polling keeps exact checkpoints without repeating pipeline summaries', async t => {
  const h = await fixture(t, []), messages = [];
  t.mock.method(console, 'log', message => messages.push(message));
  let now = 1000;
  const pipeline = new Pipeline(h.client, h.target, h.options, { now: () => now });
  const state = { theorem_id: 'a', job_status: 'ACTIVE', stage: 'SERVER', dispatch_state: 'DELAYED' };
  pipeline.store.index = async () => new Map([['a', state]]);
  assert.equal((await pipeline.checkpoint()).pipeline.queues.SERVER.queued, 1);
  pipeline.controls.set('a', { running: 'SERVER' });
  now += 1000;
  assert.equal((await pipeline.checkpoint()).pipeline.queues.SERVER.running, 1);
  pipeline.controls.clear(); state.dispatch_state = 'HANDOFF_PENDING';
  assert.equal((await pipeline.checkpoint()).pipeline.handoffs, 1);
  state.dispatch_state = 'DELAYED';
  assert.equal((await pipeline.checkpoint()).pipeline.queues.SERVER.queued, 1);
  assert.equal(messages.length, 1, 'transient poll counters stay in the saved report');
  now += 30000;
  await pipeline.checkpoint();
  assert.equal(messages.length, 2, 'waiting remains visible on the heartbeat');
});

test('permanent graph failures stop new admissions, cancel active work, and preserve the consumed attempt', async t => {
  const h = await fixture(t), frontier = h.hooks.frontier;
  let running = false, failures = 0;
  h.hooks.frontier = async (...args) => {
    if (running) { failures++; throw new ApiError(403, '/graph'); }
    return frontier(...args);
  };
  h.hooks.agent = async (...args) => {
    running = true;
    await new Promise((_resolve, reject) => args[5].signal.addEventListener('abort', () => reject(args[5].signal.reason), { once: true }));
  };
  await assert.rejects(h.run(), /403/);
  assert.equal(failures, 1); assert.equal(h.posts.length, 0);
  assert.equal((await h.store.read('a')).attempts_used_in_job, 1);
  assert.equal(JSON.parse(await readFile(join(h.runs, 'last-run.json'), 'utf8')).status, 'ERROR');
});
