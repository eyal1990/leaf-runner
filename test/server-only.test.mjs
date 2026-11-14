import { solveLeaf } from '../test-support/selection-rounds.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeEnvironment, prepareAgentEnvironment, workspaceIdentity, command, mirror } from '../prove2me.mjs';
import { JobStore } from '../job-store.mjs';
import { agentPrompt } from '../agent-prompts.mjs';

async function fixture(t, kind = 'proof') {
  t.mock.method(console, 'log', () => {});
  const root = await mkdtemp(join(tmpdir(), 'prove2me-server-only-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runs = join(root, 'runs'), store = new JobStore(runs), leased = new Set();
  const target = { theorem_id: 'leaf', theorem_name: 'Goal', status: 'Open', mathlib_rev: 'a'.repeat(40),
    visibility: 'public', preamble: '', formal_statement: `theorem Goal : ${kind === 'sketch' ? 'True ∧ True' : kind === 'counterexample' ? 'False' : 'True'} := by sorry` };
  const environment = { mathlib_rev: target.mathlib_rev, toolchain: 'leanprover/lean4:v4.33.1' };
  const child = { theorem_name: 'Child', theorem_title: 'Child', preamble: '', formal_statement: 'theorem Child : True := by sorry',
    natural_language_statement: 'True.' };
  const row = { ...child, theorem_id: 'child', mathlib_rev: target.mathlib_rev, status: 'Open' };
  const sources = { proof: 'theorem solution : True := by trivial', counterexample: 'theorem solution : ¬ False := by intro h; exact h',
    sketch: 'import Theorems.Thm_Child\ntheorem solution : True ∧ True := by exact ⟨Child, Child⟩' };
  const calls = { models: [], posts: [], publications: 0, workspaces: 0, releases: 0, dependencies: 0 };
  const publication = { id: 'pub', status: 'PUBLISHED', theorem_id: 'child', theorem_name: 'Child', visibility: 'public',
    formal_statement: child.formal_statement, definitions: '' };
  const client = {
    request: async path => path === 'publish-jobs/pub' ? publication : path === 'theorems/child' ? row : target,
    pages: async path => path.startsWith('publish-jobs?') ? calls.publications ? [publication] : []
      : calls.publications ? [row] : [],
    submit: async (_id, source, explanation, proofType) => {
      assert.equal(leased.size, 0, 'upload owns no workspace');
      calls.posts.push({ source, explanation, proofType }); return { submission_id: `sub-${calls.posts.length}` };
    },
    publish: async () => { assert.equal(leased.size, 0); calls.publications++; return { job_id: 'pub' }; },
  };
  const options = { runs, attempts: 3, verificationMode: 'server-only', lake: 'MUST_NOT_EXECUTE' };
  const hooks = {
    workspace: async () => {
      const path = join(root, `workspace-${++calls.workspaces}`); leased.add(path);
      await mkdir(join(path, 'Solutions'), { recursive: true }); return path;
    },
    releaseWorkspace: async path => {
      assert.ok(leased.delete(path)); calls.releases++;
      await rm(path, { recursive: true, force: true }); // prove remote work uses snapshots only
    },
    mirror: async (_client, workspace, _source, _target, settings) => {
      calls.dependencies++;
      if (!workspace) assert.equal(settings.sourceOnly, true);
      return [];
    },
    preflight: async (_t, workspace, _dir, opts) => { assert.ok(leased.has(workspace)); assert.equal(opts.verificationMode, 'server-only'); },
    command: async () => assert.fail('server-only must never execute Lean/Lake'),
    poll: async () => ({ status: kind === 'sketch' ? 'SKETCH_ACCEPTED' : 'ACCEPTED' }),
    agent: async (_target, workspace, _dir, attempt, feedback) => {
      const solution = join(workspace, 'Solutions/Sol_leaf.lean');
      if (attempt > 1) assert.equal(await readFile(solution, 'utf8'), sources[kind], 'repair restores saved source');
      calls.models.push({ attempt, feedback });
      await writeFile(solution, sources[kind]);
      return { kind, ready: kind !== 'counterexample', solution, module: 'Solutions.Sol_leaf', explanation: 'Mathematics.',
        children: kind === 'sketch' ? [child] : [], definitions: [] };
    },
  };
  return { root, runs, store, target, environment, options, hooks, client, calls, leased, sources,
    run: extra => solveLeaf(client, target, {}, environment, { ...options, ...extra }, hooks) };
}

test('workspace upgrade waits finish before the first proof attempt, then submit normally', async t => {
  const h = await fixture(t), allocate = h.hooks.workspace;
  let pulls = 0, waits = 0;
  h.hooks.workspace = async (environment, options) => {
    const workspace = await allocate();
    const skill = version => writeFile(join(workspace, 'SKILL.md'), `---\nmetadata:\n  version: "${version}"\n---\n`);
    await initializeEnvironment(workspace, environment, options, {
      command: async (exe, args) => {
        assert.equal(exe, 'git');
        if (args[0] === 'clone') await skill('0.12.9');
        if (args[0] === 'pull' && ++pulls === 2) await skill('0.13.3');
      },
      wait: async () => {
        waits++;
        assert.equal(h.calls.models.length, 0);
        const state = await h.store.read('leaf');
        assert.equal(state.attempt_count, 0);
        assert.equal(state.job_status, 'ACTIVE');
      },
    });
    return workspace;
  };
  assert.equal(await h.run({ apiVersion: '0.13.3' }), 'ACCEPTED');
  assert.equal(pulls, 2); assert.equal(waits, 1);
  assert.equal(h.calls.models.length, 1); assert.equal(h.calls.posts.length, 1);
  const state = await h.store.read('leaf');
  assert.equal(state.attempt_count, 1);
  assert.equal(state.history.filter(e => e.result === 'started').length, 1);
  assert.equal(state.history.at(-1).result, 'proof_accepted');
});

test('cold server-only setup uses Git sources and no compiler; sandbox probe still checks actual reads and writes', async t => {
  const h = await fixture(t), workspace = join(h.root, 'cold'), dir = join(h.runs, 'leaf');
  await mkdir(dir, { recursive: true });
  const git = [];
  await initializeEnvironment(workspace, h.environment, h.options, { command: async (exe, args) => {
    assert.equal(exe, 'git'); git.push(args);
    if (args[0] === 'clone') {
      await mkdir(join(workspace, 'references'), { recursive: true });
      for (const name of ['prove.md', 'lean-setup.md']) await writeFile(join(workspace, 'references', name), 'Reference data.');
    }
  } });
  assert.ok(git.some(args => args[0] === 'fetch' && args.includes(h.environment.mathlib_rev)));
  assert.notDeepEqual(workspaceIdentity(h.environment, h.options), workspaceIdentity(h.environment, { ...h.options, verificationMode: 'local' }));
  await writeFile(join(dir, 'context.json'), '{}');
  const probe = {
    executable: async () => assert.fail('server-only readiness must not resolve Lake'), platform: 'linux',
    command: async (_exe, args, settings) => {
      const script = await readFile(join(dir, 'environment-probe.cjs'), 'utf8');
      assert.ok(!script.includes('spawnSync('));
      await command(process.execPath, [args.at(-1)], { ...settings, quiet: true });
    },
  };
  await prepareAgentEnvironment(h.target, workspace, dir, h.options, probe);
  assert.deepEqual(await readdir(join(workspace, 'Solutions')), []);
  await rm(join(workspace, 'references/prove.md'));
  await assert.rejects(prepareAgentEnvironment(h.target, workspace, dir, h.options, probe), /not ready/);
  const prompt = agentPrompt(h.target, dir, 1, '', 'Solutions/Sol_leaf.lean', { ...h.options, environmentReady: true });
  assert.match(prompt, /Verification mode is server-only/);
  assert.ok(!prompt.includes('Mathlib cache are prepared'));
  assert.ok(!prompt.includes('runner will compile them'));
});

for (const promptVariant of ['balanced', 'proof_first', 'proofOnly']) {
  test(`server-only attempts use the configured ${promptVariant} prompt through submission`, async t => {
    const h = await fixture(t), generate = h.hooks.agent;
    h.options.pipeline = { promptVariant };
    h.hooks.agent = async (...args) => {
      assert.equal(args[5].promptExperiment.variant, promptVariant);
      const prompt = agentPrompt(h.target, args[2], args[3], args[4], 'solution.lean', args[5]);
      assert.equal(prompt.startsWith('Your primary objective is a complete Lean proof'), promptVariant === 'proof_first');
      assert.equal(prompt.startsWith('Your only objective is a complete Lean proof'), promptVariant === 'proofOnly');
      return generate(...args);
    };
    assert.equal(await h.run(), 'ACCEPTED');
    const state = await h.store.read('leaf');
    assert.equal(state.prompt_experiment.variant, promptVariant);
    assert.equal(state.prompt_experiment.experiment_id, null);
    assert.deepEqual(state.remote_operations[0].prompt_experiment, state.prompt_experiment);
  });
}

for (const kind of ['proof', 'sketch', 'counterexample']) {
  test(`server-only ${kind} submits immutable bytes with zero client compiler calls and no remote workspace`, async t => {
    const h = await fixture(t, kind);
    assert.equal(await h.run(), kind === 'sketch' ? 'SKETCH_ACCEPTED' : kind === 'counterexample' ? 'DISPROVED' : 'ACCEPTED');
    assert.equal(h.calls.workspaces, 1); assert.equal(h.calls.releases, 1);
    assert.equal(h.calls.publications, kind === 'sketch' ? 1 : 0);
    assert.equal(h.calls.posts[0].source, h.sources[kind]);
    assert.equal(h.calls.posts[0].proofType, kind === 'counterexample' ? 'disprove' : 'prove');
    assert.equal((await h.store.read('leaf')).verification_mode, 'server-only');
    const state = await h.store.read('leaf'), start = state.history.find(e => e.result === 'started');
    assert.ok(['balanced', 'proof_first'].includes(start.prompt_experiment.variant));
    assert.deepEqual(state.history.at(-1).prompt_experiment, start.prompt_experiment);
    assert.deepEqual(state.remote_operations[0].prompt_experiment, start.prompt_experiment);
    assert.equal(state.remote_operations[0].attempt_id, start.attempt_id);
    assert.equal(state.remote_operations[0].candidate_kind, kind);
    const manifest = JSON.parse(await readFile(join(h.runs, 'leaf/attempt-context-1.json'), 'utf8'));
    assert.deepEqual(manifest.prompt_experiment, start.prompt_experiment);
    assert.ok(h.calls.dependencies >= 3, 'cheap dependency checks remain');
  });

  test(`server rejection repairs ${kind} in a new workspace within the original budget`, async t => {
    const h = await fixture(t, kind);
    h.hooks.poll = async () => h.calls.posts.length === 1 ? { status: 'REJECTED', error_message: 'server type diagnostics' }
      : { status: kind === 'sketch' ? 'SKETCH_ACCEPTED' : 'ACCEPTED' };
    await h.run();
    assert.equal(h.calls.workspaces, 2); assert.equal(h.calls.models.length, 2);
    assert.match(h.calls.models[1].feedback, /server type diagnostics/);
    assert.equal(h.calls.publications, kind === 'sketch' ? 1 : 0);
    const saved = await h.store.read('leaf');
    assert.equal(saved.attempt_budget, 3); assert.equal(saved.attempts_used_in_job, 2);
    for (const operation of saved.remote_operations) {
      const start = saved.history.find(e => e.result === 'started' && e.attempt_id === operation.attempt_id);
      assert.deepEqual(operation.prompt_experiment, start.prompt_experiment);
    }
  });
}

for (const boundary of ['validated', 'submitted', 'unknown_upload', 'unknown_publication']) {
  test(`server-only restart at ${boundary} preserves artifacts and never repeats an uncertain POST`, async t => {
    const h = await fixture(t, boundary === 'unknown_publication' ? 'sketch' : 'proof');
    if (boundary === 'unknown_upload') h.client.submit = async (_id, source, explanation, proofType) => {
      h.calls.posts.push({ source, explanation, proofType }); throw new Error('lost upload response');
    };
    if (boundary === 'unknown_publication') h.client.publish = async () => { h.calls.publications++; throw new Error('lost publish response'); };
    if (boundary.startsWith('unknown')) await assert.rejects(h.run(), /lost .* response/);
    else {
      const abort = new AbortController(), replace = JobStore.prototype.replace;
      let stopped = false;
      t.mock.method(JobStore.prototype, 'replace', async function(state, revision, settings) {
        const result = await replace.call(this, state, revision, settings);
        if (!stopped && (boundary === 'validated' ? state.stage === 'SERVER' && state.dispatch_state === 'QUEUED' : state.status === 'PENDING')) {
          stopped = true; abort.abort(new Error('crash'));
        }
        return result;
      });
      await assert.rejects(h.run({ signal: abort.signal }), /crash/);
    }
    const before = await h.store.read('leaf');
    if (boundary === 'unknown_upload') h.client.request = async path => path.startsWith('submissions?')
      ? { total: 1, submissions: [{ id: 'recovered', theorem_id: 'leaf' }] }
      : path.endsWith('/solution') ? { content: h.sources.proof } : h.target;
    const workspaces = h.calls.workspaces;
    await h.run({ attempts: 99, testRounds: 2, verificationMode: 'local' });
    const after = await h.store.read('leaf');
    assert.equal(after.verification_mode, 'server-only'); assert.equal(after.attempt_budget, 3);
    assert.equal(after.artifact_manifest.source_hash, before.artifact_manifest.source_hash);
    assert.equal(h.calls.workspaces, workspaces, 'remote restart does not reconstruct');
    assert.equal(h.calls.models.length, 1); assert.equal(h.calls.posts.length, 1);
    assert.equal(h.calls.publications, boundary === 'unknown_publication' ? 1 : 0);
  });
}

test('source-only dependency reads need no workspace and reject an Open direct-proof import', async t => {
  const h = await fixture(t), row = { ...h.target, theorem_id: 'dep', theorem_name: 'Dependency' };
  h.client.pages = async () => [row]; h.client.request = async () => row;
  const settings = { sourceOnly: true, cacheDir: join(h.root, 'cache') };
  assert.deepEqual(await mirror(h.client, undefined, 'import Theorems.Thm_Dependency', h.target, settings), ['Theorems.Thm_Dependency']);
  await assert.rejects(mirror(h.client, undefined, 'import Theorems.Thm_Dependency', h.target, { ...settings, direct: true }), /require Proved/);
});

test('pending server publication resumes from its journal without a workspace or duplicate creation', async t => {
  const h = await fixture(t, 'sketch'), request = h.client.request;
  let pending = true;
  h.client.request = async path => path === 'publish-jobs/pub' && pending ? { status: 'COMPILING' } : request(path);
  assert.equal(await h.run(), 'PUBLISH_PENDING');
  assert.equal(h.leased.size, 0); assert.equal(h.calls.workspaces, 1);
  pending = false;
  assert.equal(await h.run({ attempts: 99, testRounds: 2 }), 'SKETCH_ACCEPTED');
  assert.equal(h.calls.workspaces, 1); assert.equal(h.calls.publications, 1); assert.equal(h.calls.models.length, 1);
  assert.equal((await h.store.read('leaf')).attempt_budget, 3);
});

for (const resumed of [false, true]) for (const invalidation of ['Disproved', 'changed']) {
  test(`${resumed ? 'saved' : 'new'} publication with a ${invalidation} dependency yields a repair instead of an endless remote wait`, async t => {
    const h = await fixture(t, 'sketch'), request = h.client.request;
    let pending = resumed;
    h.client.request = async path => {
      if (path === 'publish-jobs/pub' && pending) return { status: 'COMPILING' };
      const row = await request(path);
      if (path !== 'theorems/child') return row;
      return invalidation === 'Disproved' ? { ...row, status: 'Disproved' }
        : { ...row, formal_statement: 'theorem Child : False := by sorry' };
    };
    if (resumed) {
      assert.equal(await h.run({ testRounds: 1 }), 'PUBLISH_PENDING');
      pending = false;
    }
    assert.equal(await h.run({ testRounds: 1 }), 'READY');
    const state = await h.store.read('leaf');
    assert.equal(state.job_status, 'READY');
    assert.equal(state.stage, 'PREPARE');
    assert.equal(state.attempt_count, 1);
    assert.equal(state.history.at(-1).failure.category, 'publication_conflict');
    assert.match(state.feedback, invalidation === 'Disproved' ? /Disproved/ : /changed or does not match/);
    assert.equal(state.plan, undefined);
    assert.equal(Object.values(state.publications)[0].theorem_id, 'child');
    assert.equal(Object.values(state.publications)[0].status, 'PUBLISHED');
    assert.equal(h.calls.publications, 1);
    assert.equal(h.calls.models.length, 1);
    assert.equal(h.calls.posts.length, 0, 'invalid reductions must not be submitted');
  });
}

test('server dependency compilation errors yield repairs without duplicate publications', async t => {
  const h = await fixture(t, 'sketch'), request = h.client.request;
  h.options.attempts = 2;
  h.client.request = async path => path === 'publish-jobs/pub' ? { status: 'FAILED', error_message: 'child compiler diagnostics' } : request(path);
  assert.equal(await h.run(), 'READY');
  assert.equal(h.calls.models.length, 2); assert.equal(h.calls.workspaces, 2);
  assert.match(h.calls.models[1].feedback, /child compiler diagnostics/);
  assert.equal(h.calls.publications, 1); assert.equal(h.calls.posts.length, 0);
  assert.equal((await h.store.read('leaf')).attempts_used_in_job, 2);
  assert.equal(await h.run({ attempts: 99, testRounds: 2 }), 'READY');
  assert.equal(h.calls.models.length, 4);
  assert.equal(h.calls.publications, 1, 'failed declaration journals prevent duplicate publication');
});

test('unreconciled server-only uploads wait without repeating POSTs before the recovery deadline', async t => {
  const h = await fixture(t);
  h.client.submit = async () => { h.calls.posts.push({}); throw new Error('lost response'); };
  await assert.rejects(h.run(), /lost response/);
  h.client.request = async path => path.startsWith('submissions?') ? { submissions: [], total: 0 } : h.target;
  for (let retry = 0; retry < 2; retry++) assert.equal(await h.run(), 'SUBMISSION_UNKNOWN');
  assert.equal(h.calls.posts.length, 1); assert.equal(h.calls.workspaces, 1); assert.equal(h.calls.models.length, 1);
  assert.equal((await h.store.read('leaf')).job_status, 'ACTIVE');
});

for (const kind of ['proof', 'sketch']) {
  test(`proofOnly never uploads or publishes ${kind === 'proof' ? 'an incomplete proof' : 'a ' + kind}`, async t => {
    const h = await fixture(t, kind), generate = h.hooks.agent;
    h.options.pipeline = { promptVariant: 'proofOnly' };
    h.hooks.agent = async (...args) => {
      const candidate = await generate(...args);
      if (kind === 'proof') candidate.ready = false;
      return candidate;
    };
    assert.equal(await h.run({ testRounds: 1 }), 'READY');
    assert.equal(h.calls.posts.length, 0);
    assert.equal(h.calls.publications, 0);
    const state = await h.store.read('leaf');
    assert.equal(state.history.at(-1).result, 'incomplete');
    assert.match(state.feedback, /proofOnly requires/);
  });
}

test('proofOnly submits a complete proof with a fully proved local helper', async t => {
  const h = await fixture(t);
  h.options.pipeline = { promptVariant: 'proofOnly' };
  h.sources.proof = 'theorem solution : True := by\n  have helper : True := by trivial\n  exact helper';
  assert.equal(await h.run(), 'ACCEPTED');
  assert.equal(h.calls.posts.length, 1);
  assert.equal(h.calls.posts[0].source, h.sources.proof);
  assert.equal(h.calls.publications, 0);
});

test('proofOnly submits an exact disproof certificate and records the accepted server verdict', async t => {
  const h = await fixture(t, 'counterexample');
  h.options.pipeline = { promptVariant: 'proofOnly' };
  assert.equal(await h.run(), 'DISPROVED');
  assert.equal(h.calls.models.length, 1);
  assert.deepEqual(h.calls.posts, [{ source: h.sources.counterexample, explanation: 'Mathematics.', proofType: 'disprove' }]);
  assert.equal(h.calls.publications, 0);
  const state = await h.store.read('leaf');
  assert.equal(state.history.at(-1).result, 'disproof_accepted');
  assert.equal(state.remote_operations[0].prompt_experiment.variant, 'proofOnly');
});

test('a resumed proofOnly candidate keeps its submission restriction after config changes', async t => {
  const h = await fixture(t, 'sketch');
  h.options.pipeline = { promptVariant: 'proofOnly' };
  const abort = new AbortController(), original = JobStore.prototype.replace;
  let stopped = false;
  t.mock.method(JobStore.prototype, 'replace', async function(state, revision, settings) {
    const result = await original.call(this, state, revision, settings);
    if (!stopped && state.stage === 'VALIDATE' && state.candidate) {
      stopped = true;
      abort.abort(new Error('restart before validation'));
    }
    return result;
  });
  await assert.rejects(h.run({ signal: abort.signal }), /restart before validation/);
  h.options.pipeline = { promptVariant: 'balanced' };
  assert.equal(await h.run({ testRounds: 1 }), 'READY');
  assert.equal(h.calls.models.length, 1);
  assert.equal(h.calls.posts.length, 0);
  assert.equal(h.calls.publications, 0);
  const state = await h.store.read('leaf');
  assert.equal(state.history.at(-1).prompt_experiment.variant, 'proofOnly');
  assert.match(state.feedback, /proofOnly requires/);
});
