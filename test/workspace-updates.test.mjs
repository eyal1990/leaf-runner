import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { compatibleWorkspaceVersion, updateWorkspaceDocumentation } from '../workspace-updates.mjs';
import { initializeEnvironment, ensureWorkspace, workspaceIdentity } from '../prove2me.mjs';
import { createWorkspaceManager, releaseWorkspace } from '../isolated-workspaces.mjs';
import { digest, json } from '../runner-state.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'prove2me-upgrade-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.mock.method(console, 'log', () => {});
  const workspace = join(root, 'workspace'), runs = join(root, 'runs');
  await mkdir(workspace); await mkdir(runs);
  const options = { runs, workspaces: root, apiVersion: '0.13.3', verificationMode: 'server-only' };
  const skill = (version, path = workspace) => writeFile(join(path, 'SKILL.md'), `---\nmetadata:\n  version: "${version}"\n---\n`);
  const state = async () => JSON.parse(await readFile(join(runs, 'workspace-upgrade.json'), 'utf8'));
  return { root, workspace, runs, options, skill, state };
}

test('patch metadata differences are compatible, while minor/major/prerelease mismatches wait', () => {
  for (const [a, b] of [['0.13.2', '0.13.3'], ['0.13.4', '0.13.3'], ['1.2.3', '1.2.4'], ['1.2.3-beta', '1.2.3-beta']]) {
    assert.equal(compatibleWorkspaceVersion(a, b), true);
  }
  for (const [a, b] of [['0.13.2', '0.14.0'], ['1.2.3', '2.2.3'], ['0.13.3-beta', '0.13.3'],
    ['01.13.2', '1.13.3'], [undefined, '0.13.3'], ['missing', '0.13.3']]) {
    assert.equal(compatibleWorkspaceVersion(a, b), false);
  }
});

test('the production patch mismatch refreshes once and continues instead of failing a job', async t => {
  const h = await fixture(t), calls = [], messages = [];
  await h.skill('0.13.2');
  await updateWorkspaceDocumentation(h.workspace, h.options, {
    command: async (exe, args) => calls.push([exe, ...args]), report: m => messages.push(m),
    wait: async () => assert.fail('patch lag must not park preparation'),
  });
  assert.deepEqual(calls, [['git', 'pull', '--ff-only', '--tags', 'origin', 'main']]);
  assert.equal((await h.state()).status, 'PATCH_COMPATIBLE');
  assert.match(messages.at(-1), /differs only by patch version; continuing/);
});

test('a minor upgrade waits in the same workspace and automatically resumes when documentation arrives', async t => {
  const h = await fixture(t), waits = [];
  await h.skill('0.12.9');
  let pulls = 0;
  await updateWorkspaceDocumentation(h.workspace, h.options, {
    command: async () => { if (++pulls === 3) await h.skill('0.13.3'); },
    wait: async ms => {
      waits.push(ms);
      assert.equal((await h.state()).status, 'WAITING');
      assert.equal(await readFile(join(h.workspace, 'SKILL.md'), 'utf8'), '---\nmetadata:\n  version: "0.12.9"\n---\n');
    },
  });
  assert.deepEqual(waits, [30000, 30000]);
  assert.equal(pulls, 3);
  assert.equal((await h.state()).status, 'CURRENT');
});

test('temporary Git upgrade failures retry without accepting stale patch metadata', async t => {
  const h = await fixture(t), waits = [];
  await h.skill('0.13.2');
  let pulls = 0;
  await updateWorkspaceDocumentation(h.workspace, h.options, {
    command: async () => { if (++pulls === 1) throw new Error('network unavailable'); await h.skill('0.13.3'); },
    wait: async ms => { waits.push(ms); assert.match((await h.state()).error, /network unavailable/); },
  });
  assert.equal(pulls, 2); assert.deepEqual(waits, [30000]);
  assert.equal((await h.state()).status, 'CURRENT');
});

test('unknown documentation is refreshed and a version mentioned in prose cannot bypass the check', async t => {
  const h = await fixture(t);
  await writeFile(join(h.workspace, 'SKILL.md'), 'An example:\n  version: "0.13.3"\n');
  let pulls = 0;
  await updateWorkspaceDocumentation(h.workspace, h.options, {
    command: async () => { pulls++; await h.skill('0.13.3'); },
    wait: async () => assert.fail('the update supplies matching documentation'),
  });
  assert.equal(pulls, 1); assert.equal((await h.state()).status, 'CURRENT');
});

test('operator interruption cancels upgrade waiting promptly without another Git call', async t => {
  const h = await fixture(t), controller = new AbortController();
  await h.skill('0.12.9');
  let pulls = 0;
  await assert.rejects(updateWorkspaceDocumentation(h.workspace, { ...h.options, signal: controller.signal }, {
    command: async () => { pulls++; controller.abort(new Error('operator stopped')); },
  }), /operator stopped/);
  assert.equal(pulls, 1);
  const waiting = new AbortController();
  const action = updateWorkspaceDocumentation(h.workspace, { ...h.options, signal: waiting.signal }, {
    command: async () => { setTimeout(() => waiting.abort(), 20); },
  });
  await assert.rejects(action, { name: 'AbortError' });
});

test('concurrent jobs share one clone and upgrade wait, then both acquire usable workspaces', async t => {
  const h = await fixture(t), environment = { mathlib_rev: 'a'.repeat(40), toolchain: 'leanprover/lean4:v4.33.1' };
  let clones = 0, pulls = 0, waits = 0;
  const manager = createWorkspaceManager((workspace, env, options) => initializeEnvironment(workspace, env, options, {
    command: async (exe, args, settings) => {
      assert.equal(exe, 'git', 'server-only upgrades and setup execute no Lean/Lake');
      if (args[0] === 'clone') { clones++; await mkdir(workspace, { recursive: true }); await h.skill('0.12.9', workspace); }
      if (args[0] === 'pull' && ++pulls === 2) await h.skill('0.13.3', settings.cwd);
    },
    wait: async () => { waits++; },
  }));
  const identity = workspaceIdentity(environment, h.options);
  const [a, b] = await Promise.all([manager(environment, h.options, identity), manager(environment, h.options, identity)]);
  assert.notEqual(a, b); assert.equal(clones, 1); assert.equal(pulls, 2); assert.equal(waits, 1);
  assert.match(await readFile(join(a, 'SKILL.md'), 'utf8'), /0\.13\.3/);
  assert.match(await readFile(join(b, 'SKILL.md'), 'utf8'), /0\.13\.3/);
  await releaseWorkspace(a, h.options); await releaseWorkspace(b, h.options);
});

test('running preparations follow live API versions instead of reusing the startup seed', async t => {
  const h = await fixture(t), environment = { mathlib_rev: 'a'.repeat(40), toolchain: 'leanprover/lean4:v4.33.1' };
  let live = '0.13.3';
  const options = { ...h.options, getApiVersion: () => live };
  for (const apiVersion of ['0.13.3', '0.14.0']) {
    const identity = workspaceIdentity(environment, { ...options, apiVersion });
    const seed = join(h.root, 'seeds', digest(json(identity)).slice(0, 16));
    await mkdir(join(seed, '.lake', 'packages'), { recursive: true });
    await writeFile(join(seed, '.runner-seed.json'), json(identity));
    await h.skill(apiVersion, seed);
  }
  const first = await ensureWorkspace(environment, options);
  await releaseWorkspace(first, options);
  live = '0.14.0';
  const second = await ensureWorkspace(environment, options);
  assert.notEqual(first, second);
  assert.match(await readFile(join(second, 'SKILL.md'), 'utf8'), /0\.14\.0/);
  await releaseWorkspace(second, options);
});
