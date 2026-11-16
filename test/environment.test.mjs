import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureWorkspace, workspaceIdentity, prepareAgentEnvironment, reviewMission, solveLeaf, runTarget, command, EnvironmentError } from '../prove2me.mjs';
import { digest, json } from '../runner-state.mjs';
import { JobStore } from '../job-store.mjs';
import { WORKSPACE_INSTRUCTIONS } from '../agent-prompts.mjs';
import { CodexSandboxRecovery, codexSandboxRecovery } from '../codex-sandbox-recovery.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'prove2me-environment-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace'), dir = join(root, 'runs', 'leaf');
  await mkdir(join(workspace, 'Solutions'), { recursive: true });
  await mkdir(dir, { recursive: true });
  t.mock.method(console, 'log', () => {});
  return { root, workspace, dir, target: { theorem_id: 'leaf', theorem_name: 'Ns.goal', mathlib_rev: 'a'.repeat(40), preamble: 'import Mathlib.Data.Real.Basic', formal_statement: 'theorem Ns.goal : True := by sorry', status: 'Open' },
    options: { codex: 'codex', lake: 'lake', runs: join(root, 'runs'), attempts: 2, verificationMode: 'local' },
    hooks: { platform: 'win32', executable: async () => ['lake.exe'],
      sandboxRecovery: new CodexSandboxRecovery() } };
}

test('preparation copies runner-owned instructions into an isolated workspace and leaves legacy files alone', async t => {
  const h = await fixture(t), environment = { mathlib_rev: h.target.mathlib_rev, toolchain: 'leanprover/lean4:v4.33.1' };
  const options = { ...h.options, workspaces: h.root }, identity = workspaceIdentity(environment, options);
  const workspace = join(h.root, 'seeds', digest(json(identity)).slice(0, 16));
  const cache = join(workspace, '.lake/packages/mathlib/.lake/build/lib/lean/Mathlib/Data/Real');
  await mkdir(cache, { recursive: true });
  // Stub a prepared seed to exercise documentation refresh without downloads.
  await writeFile(join(workspace, 'SKILL.md'), 'Existing platform reference');
  await writeFile(join(workspace, '.runner-seed.json'), json(identity));
  await writeFile(join(cache, 'Basic.olean'), 'fixture');
  await writeFile(join(workspace, 'AGENTS.md'), WORKSPACE_INSTRUCTIONS);
  const legacy = join(h.root, environment.mathlib_rev);
  await mkdir(legacy, { recursive: true });
  await writeFile(join(legacy, 'AGENTS.md'), 'Compile with lake and iterate.');
  const isolated = await ensureWorkspace(environment, options);
  assert.notEqual(isolated, workspace);
  assert.match(isolated, /jobs/);
  assert.equal(await readFile(join(legacy, 'AGENTS.md'), 'utf8'), 'Compile with lake and iterate.');
  const instructions = await readFile(join(isolated, 'AGENTS.md'), 'utf8');
  assert.match(instructions, /Do not launch Lake or Lean/);
  assert.match(instructions, /ready=true.*ready for runner validation/);
  assert.ok(!instructions.includes('Compile with lake'));
});

test('preflight uses Windows sandbox and checks real inputs, writes, and imported Lean build without a model', async t => {
  const h = await fixture(t);
  h.hooks.command = async (_exe, args, { log, cwd, timeout, label, showOutput }) => {
    assert.equal(cwd, h.workspace);
    assert.equal(timeout, 3600000);
    assert.match(label, /\[leaf\] Lean readiness \(no model request\)/);
    assert.equal(showOutput, true);
    assert.ok(args.includes('windows.sandbox=mxc'));
    assert.ok(args.includes('sandbox_mode="workspace-write"'));
    assert.ok(args.some(value => value.includes('sandbox_workspace_write.writable_roots=') && value.includes('leaf')));
    assert.ok(args.includes('-EncodedCommand'));
    assert.equal(args[args.indexOf('sandbox') + 1], '--', 'the sandbox command has no OS subcommand');
    assert.ok(!args.includes('exec')); assert.ok(!args.includes('--model'));
    const script = await readFile(join(h.dir, 'environment-probe.cjs'), 'utf8');
    assert.match(script, /context.json/); assert.match(script, /references\/lean-setup.md/);
    assert.match(script, /flag: 'wx'/); assert.match(script, /\['build', "Solutions.RunnerEnvironment_/);
    const lean = (await readdir(join(h.workspace, 'Solutions'))).find(file => file.endsWith('.lean'));
    assert.match(await readFile(join(h.workspace, 'Solutions', lean), 'utf8'), /import Mathlib.Data.Real.Basic/);
    await writeFile(log, 'RUNNER_ENVIRONMENT_READY\n');
  };
  await prepareAgentEnvironment(h.target, h.workspace, h.dir, h.options, h.hooks);
  assert.match((await readdir(join(h.workspace, 'Solutions'))).join(','), /^RunnerEnvironment_[a-f0-9]+\.lean$/);
});

for (const platform of ['linux', 'darwin']) {
  test(`${platform} readiness launches the probe directly through the pinned flat sandbox CLI`, async t => {
    const h = await fixture(t);
    h.options.verificationMode = 'server-only'; h.hooks.platform = platform;
    await mkdir(join(h.workspace, 'references'));
    for (const name of ['references/prove.md', 'references/lean-setup.md', 'lean-toolchain', 'lakefile.lean'])
      await writeFile(join(h.workspace, name), 'fixture');
    await writeFile(join(h.dir, 'context.json'), '{}');
    const cli = join(h.root, 'flat-sandbox-cli.cjs');
    // Codex 0.162.1 takes a command immediately after `sandbox`. Model its
    // argument boundary, then actually launch Node and perform the read/write
    // probe. An obsolete `linux`/`macos` token is executed and fails like the
    // reported execvp panic, rather than being ignored by a command mock.
    await writeFile(cli, `const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
const command = args.slice(args.indexOf('sandbox') + 1);
if (command[0] === '--') command.shift();
const result = spawnSync(command[0], command.slice(1), { stdio: 'inherit', windowsHide: true });
if (result.error) { console.error('Failed to execvp ' + command[0] + ': ' + result.error.message); process.exit(101); }
process.exit(result.status ?? 1);
`);
    let calls = 0;
    h.hooks.command = async (_exe, args, settings) => {
      calls++;
      assert.ok(args.includes('sandbox_mode="workspace-write"'));
      assert.ok(!args.some(arg => arg.startsWith('windows.sandbox=')));
      await command(process.execPath, [cli, ...args], { ...settings, quiet: true });
    };
    await prepareAgentEnvironment(h.target, h.workspace, h.dir, h.options, h.hooks);
    assert.equal(calls, 1);
    assert.match(await readFile(join(h.dir, 'environment-check-1.log'), 'utf8'), /RUNNER_ENVIRONMENT_READY/);
    assert.deepEqual(await readdir(join(h.workspace, 'Solutions')), [], 'server-only runs no Lean build');
  });
}

test('temporary setup lock retries before a model call and preserves readiness source after recovery', async t => {
  const h = await fixture(t), delays = []; let calls = 0;
  h.hooks.wait = async delay => delays.push(delay);
  h.hooks.command = async (_exe, _args, { log }) => {
    if (++calls < 3) { await writeFile(log, 'helper_unknown_error: setup refresh had errors'); throw new Error('setup failed'); }
    await writeFile(log, 'RUNNER_ENVIRONMENT_READY');
  };
  await prepareAgentEnvironment(h.target, h.workspace, h.dir, h.options, h.hooks);
  assert.equal(calls, 3); assert.deepEqual(delays, [2000, 4000]);
  assert.match((await readdir(join(h.workspace, 'Solutions'))).join(','), /^RunnerEnvironment_[a-f0-9]+\.lean$/);
});

test('MXC resource failure checks elevated readiness and shares that choice with later invocations', async t => {
  const h = await fixture(t), modes = [], logs = [];
  h.options.codex = `codex-${h.root}`;
  h.hooks.command = async (_exe, args, { log }) => {
    const mode = args.find(arg => arg.startsWith('windows.sandbox='));
    modes.push(mode); logs.push(log);
    if (mode === 'windows.sandbox=mxc') {
      await writeFile(log, 'MXC launcher: CreateProcessSecurityEnvironment failed (HRESULT = 0x800705AA)');
      throw new Error('sandbox startup failed');
    }
    await writeFile(log, 'RUNNER_ENVIRONMENT_READY');
  };
  await prepareAgentEnvironment(h.target, h.workspace, h.dir, h.options, h.hooks);
  // The next stage gets a fresh options object, just as the serial driver does.
  await prepareAgentEnvironment(h.target, h.workspace, h.dir, { ...h.options }, h.hooks);
  assert.deepEqual(modes, ['windows.sandbox=mxc', 'windows.sandbox=elevated', 'windows.sandbox=elevated']);
  assert.notEqual(logs[0], logs[1]);
  assert.match(await readFile(logs[0], 'utf8'), /0x800705AA/);
  await reviewMission({ dir: h.dir, root_id: 'root', model: 'gpt-6-luna' }, h.options, {
    platform: h.hooks.platform,
    command: async (_exe, args) => {
      assert.ok(args.includes('windows.sandbox=elevated'));
      await writeFile(args[args.indexOf('--output-last-message') + 1], '{}');
    },
  });
});

test('persistent Windows setup failure recovers with the enabled fallback only after full readiness', async t => {
  const h = await fixture(t), modes = [];
  h.options.verificationMode = 'server-only';
  h.options.pipeline = { windowsSandboxRecovery: 'allow-unelevated' };
  h.hooks.wait = async () => {};
  h.hooks.command = async (_exe, args, { log }) => {
    const mode = args.find(a => a.startsWith('windows.sandbox=')); modes.push(mode);
    assert.ok(!args.includes('exec'), 'recovery does not request a model');
    if (mode === 'windows.sandbox=mxc') {
      await writeFile(log, 'CreateProcessSecurityEnvironment failed (HRESULT = 0x800705AA)');
      throw new Error('MXC unavailable');
    }
    if (mode === 'windows.sandbox=elevated') {
      await writeFile(log, 'windows sandbox failed: helper_unknown_error: setup refresh had errors');
      throw new Error('setup failed');
    }
    assert.equal(h.hooks.sandboxRecovery.mode(h.options), undefined, 'fallback is uncommitted during probe');
    await writeFile(log, 'RUNNER_ENVIRONMENT_READY');
  };
  await prepareAgentEnvironment(h.target, h.workspace, h.dir, h.options, h.hooks);
  assert.deepEqual(modes, ['windows.sandbox=mxc', ...Array(3).fill('windows.sandbox=elevated'), 'windows.sandbox=unelevated']);
  assert.equal(h.hooks.sandboxRecovery.mode(h.options), 'unelevated');
  const report = JSON.parse(await readFile(join(h.options.runs, 'codex-sandbox-recovery.json'), 'utf8'));
  assert.equal(report.status, 'RECOVERED'); assert.equal(report.sandbox_mode, 'unelevated');
  t.mock.method(codexSandboxRecovery, 'mode', options => h.hooks.sandboxRecovery.mode(options));
  await reviewMission({ dir: h.dir, root_id: 'root', model: 'gpt-6-luna' }, h.options, {
    platform: h.hooks.platform,
    command: async (_exe, args) => {
      assert.ok(args.includes('windows.sandbox=unelevated'));
      await writeFile(args[args.indexOf('--output-last-message') + 1], '{}');
    },
  });
});

test('sandbox fallback respects explicit modes, unrelated errors, and failed elevated readiness', async t => {
  for (const scenario of ['explicit', 'unrelated', 'fallback-fails']) {
    const h = await fixture(t), modes = [];
    h.options.codex = `codex-${h.root}`;
    if (scenario === 'explicit') h.options['windows-sandbox'] = 'mxc';
    h.hooks.command = async (_exe, args, { log }) => {
      const mode = args.find(arg => arg.startsWith('windows.sandbox=')); modes.push(mode);
      await writeFile(log, scenario === 'unrelated' ? 'Access denied' : mode === 'windows.sandbox=mxc'
        ? 'CreateProcessSecurityEnvironment failed (HRESULT = 0x800705AA)' : 'elevated sandbox unavailable');
      throw new Error('sandbox startup failed');
    };
    await assert.rejects(prepareAgentEnvironment(h.target, h.workspace, h.dir, h.options, h.hooks), EnvironmentError);
    assert.deepEqual(modes, scenario === 'fallback-fails'
      ? ['windows.sandbox=mxc', 'windows.sandbox=elevated'] : ['windows.sandbox=mxc']);
  }
});

test('a fallback that exits successfully without completing readiness is never selected', async t => {
  const h = await fixture(t);
  h.options.codex = `incomplete-probe-${h.root}`;
  h.options.pipeline = { windowsSandboxRecovery: 'allow-unelevated' };
  h.hooks.wait = async () => {};
  h.hooks.command = async (_exe, args, { log }) => {
    if (args.includes('windows.sandbox=mxc')) {
      await writeFile(log, 'CreateProcessSecurityEnvironment failed (HRESULT = 0x800705AA)');
      throw new Error('MXC unavailable');
    }
    if (args.includes('windows.sandbox=elevated')) {
      await writeFile(log, 'setup refresh had errors'); throw new Error('setup failed');
    }
    await writeFile(log, 'started, but probe did not finish');
  };
  await assert.rejects(prepareAgentEnvironment(h.target, h.workspace, h.dir, h.options, h.hooks), EnvironmentError);
  assert.equal(h.hooks.sandboxRecovery.mode(h.options), undefined);
  assert.equal(h.hooks.sandboxRecovery.state.status, 'WAITING');
  assert.match(h.hooks.sandboxRecovery.state.error, /did not complete the readiness check/);
});

test('Lean failure stops readiness immediately; success without a completed probe is rejected', async t => {
  for (const incomplete of [false, true]) {
    const h = await fixture(t); let calls = 0;
    h.hooks.command = async (_exe, _args, { log }) => {
      calls++; await writeFile(log, 'Lean import failed');
      if (!incomplete) throw new Error('compile failed');
    };
    await assert.rejects(prepareAgentEnvironment(h.target, h.workspace, h.dir, h.options, h.hooks), EnvironmentError);
    assert.equal(calls, 1);
    assert.match((await readdir(join(h.workspace, 'Solutions'))).join(','), /^RunnerEnvironment_[a-f0-9]+\.lean$/);
  }
});

test('every readiness invocation runs the sandbox but unchanged modules keep their build identity and mtime', async t => {
  const h = await fixture(t), seen = []; let calls = 0;
  h.hooks.command = async (_exe, _args, { log }) => {
    calls++;
    const script = await readFile(join(h.dir, 'environment-probe.cjs'), 'utf8');
    const name = script.match(/\['build', "(Solutions\.RunnerEnvironment_[a-f0-9]+)"\]/)[1];
    const path = join(h.workspace, name.replaceAll('.', '/') + '.lean');
    seen.push({ name, mtime: (await stat(path)).mtimeMs, script });
    await writeFile(log, 'RUNNER_ENVIRONMENT_READY');
  };
  await prepareAgentEnvironment(h.target, h.workspace, h.dir, h.options, h.hooks);
  await prepareAgentEnvironment(h.target, h.workspace, h.dir, h.options, h.hooks);
  assert.equal(calls, 2, 'sandbox startup/read/write checks are never skipped');
  assert.equal(seen[0].name, seen[1].name);
  assert.equal(seen[0].mtime, seen[1].mtime);
  assert.notEqual(seen[0].script, seen[1].script, 'write probes retain unique paths');
  await prepareAgentEnvironment({ ...h.target, preamble: 'import Mathlib.Data.Nat.Basic' }, h.workspace, h.dir, h.options, h.hooks);
  assert.notEqual(seen[1].name, seen[2].name, 'different imports invalidate the readiness module');
});

test('failed readiness preserves existing attempts and feedback and never starts an agent', async t => {
  const h = await fixture(t), statePath = join(h.dir, 'state.json');
  const store = new JobStore(h.options.runs);
  const state = await store.ensure('leaf', { attempts: 6, mathlibRev: h.target.mathlib_rev });
  Object.assign(state, { legacy_baseline: { attempts: 5, context_id: 'initial' }, attempt_count: 5, attempts_used_in_job: 5, feedback: 'use induction', status: 'REPAIR_REQUIRED', stage: 'CODEX', operation: 'repair' });
  await store.replace(state, state.revision);
  let agents = 0;
  const hooks = { workspace: async () => h.workspace, mirror: async () => {},
    preflight: async () => { throw new EnvironmentError('sandbox unavailable'); },
    agent: async () => { agents++; } };
  await assert.rejects(solveLeaf({}, h.target, {}, {}, h.options, hooks), EnvironmentError);
  assert.equal(agents, 0);
  const saved = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(saved.attempt_count, 5); assert.equal(saved.attempts_used_in_job, 5);
  assert.equal(saved.feedback, 'use induction'); assert.equal(saved.attempt_budget, 6);
});

test('scheduler retries readiness without spending attempts or work visits, then completes the mission', async t => {
  const h = await fixture(t);
  h.options.refreshInterval = 2;
  const scope = { root: 'root', name: 'Mission', kind: 'mission' };
  const client = { request: async path => path === 'environments' ? { environments: [{ mathlib_rev: h.target.mathlib_rev }] } : path.endsWith('/decompositions') ? { decompositions: [] } : h.target,
    pages: async () => [] };
  let calls = 0; const delays = [];
  const summary = await runTarget(client, scope, h.options, {
    frontier: async () => ({ root: { theorem_id: scope.root, status: calls === 3 ? 'Proved' : 'Open' }, leaves: [h.target] }),
    solveLeaf: async () => { if (++calls < 3) throw new EnvironmentError('sandbox unavailable'); return 'ACCEPTED'; },
    wait: async delay => {
      delays.push(delay);
      const checkpoint = JSON.parse(await readFile(join(h.options.runs, 'last-run.json'), 'utf8'));
      assert.equal(checkpoint.status, 'RUNNING'); assert.equal(checkpoint.visits, 0);
      assert.equal(checkpoint.results[0].status, 'ENVIRONMENT_WAIT');
      const job = JSON.parse(await readFile(join(h.dir, 'state.json'), 'utf8'));
      assert.equal(job.job_status, 'ACTIVE'); assert.equal(job.attempt_count, 0);
    },
  });
  assert.equal(summary.status, 'COMPLETE'); assert.equal(summary.visits, 1);
  assert.equal(calls, 3); assert.deepEqual(delays, [2000, 2000]);
});

test('readiness timeout retries in the same workspace, retaining partial dependency builds', async t => {
  const h = await fixture(t); let calls = 0;
  h.options.leanTimeout = 7200;
  h.hooks.wait = async () => {};
  h.hooks.command = async (_exe, _args, { cwd, log, timeout }) => {
    assert.equal(cwd, h.workspace); assert.equal(timeout, 7200000);
    const artifact = join(h.workspace, 'Solutions', 'dependency.olean');
    if (++calls === 1) {
      await writeFile(artifact, 'partial build');
      await writeFile(log, 'Built Definitions.SlowDependency (127s)');
      throw Object.assign(new Error('codex timed out'), { code: 'COMMAND_TIMEOUT' });
    }
    assert.equal(await readFile(artifact, 'utf8'), 'partial build');
    await writeFile(log, 'RUNNER_ENVIRONMENT_READY');
  };
  await prepareAgentEnvironment(h.target, h.workspace, h.dir, h.options, h.hooks);
  assert.equal(calls, 2);
});

test('operator cancellation propagates through readiness and ends the scheduler without a retry', async t => {
  const h = await fixture(t), controller = new AbortController(), reason = new Error('operator stopped');
  h.options.signal = controller.signal;
  h.hooks.command = async () => { controller.abort(reason); throw new Error('codex cancelled'); };
  await assert.rejects(prepareAgentEnvironment(h.target, h.workspace, h.dir, h.options, h.hooks), error => error === reason);
  await assert.rejects(runTarget({}, { name: 'Mission' }, h.options, { wait: async () => assert.fail('no retry') }), error => error === reason);
});
