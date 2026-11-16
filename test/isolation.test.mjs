import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, symlink, lstat, stat, utimes, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createWorkspaceManager, environmentIdentity, copyEnvironment, releaseWorkspace } from '../isolated-workspaces.mjs';
import { withBuildSlot } from '../shared-resources.mjs';
import { digest, json, save, exists } from '../runner-state.mjs';
import { Client } from '../prove2me.mjs';

const environment = { mathlib_rev: 'a'.repeat(40), toolchain: 'leanprover/lean4:v4.33.1' };
const pause = () => new Promise(resolve => setImmediate(resolve));
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'prove2me-isolation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = { workspaces: root };
  return { root, options, identity: environmentIdentity(environment, options, 'trusted config') };
}
async function initialize(path) {
  for (const dir of ['Solutions', 'Definitions', 'Theorems', '.lake/packages/mathlib/.lake/build', '.lake/packages/mathlib/.git', '.lake/build', '.git'])
    await mkdir(join(path, dir), { recursive: true });
  for (const file of ['Solutions/Same.lean', 'Definitions/Same.lean', 'Theorems/Same.lean',
    '.lake/packages/mathlib/source.lean', '.lake/packages/mathlib/.lake/build/Same.olean',
    '.lake/build/Same.olean', 'lakefile.lean', 'lake-manifest.json', 'lean-toolchain', '.git/config', '.lake/packages/mathlib/.git/config'])
    await writeFile(join(path, file), 'seed');
  const earlier = new Date('2026-01-01T00:00:00Z');
  await utimes(join(path, '.lake/packages/mathlib/source.lean'), earlier, earlier);
}

async function fileSymlinksAvailable(t, root) {
  await writeFile(join(root, 'link-target'), 'probe');
  try { await symlink('link-target', join(root, 'link-probe'), 'file'); return true; }
  catch (error) {
    if (process.platform !== 'win32' || error.code !== 'EPERM') throw error;
    t.skip('Windows account cannot create file symlinks; Linux CI exercises native Mathlib symlinks');
    return false;
  }
}

test('same-environment jobs share initialization but isolate all writable sources, pins, packages and build output', async t => {
  const h = await fixture(t); let setups = 0, live = 0;
  const manager = createWorkspaceManager(async path => { setups++; await pause(); await initialize(path); });
  const [a, b] = await Promise.all([manager(environment, h.options, h.identity), manager(environment, h.options, h.identity)]);
  assert.notEqual(a, b); assert.equal(setups, 1);
  const seed = join(h.root, 'seeds', digest(json(h.identity)).slice(0, 16));
  assert.equal((await stat(join(a, '.lake/packages/mathlib/source.lean'))).mtimeMs,
    (await stat(join(seed, '.lake/packages/mathlib/source.lean'))).mtimeMs, 'copies must preserve cache timestamps');
  for (const path of ['Solutions/Same.lean', 'Definitions/Same.lean', 'Theorems/Same.lean',
    'lakefile.lean', 'lean-toolchain', 'lake-manifest.json', '.lake/packages/mathlib/source.lean',
    '.lake/packages/mathlib/.lake/build/Same.olean', '.lake/build/Same.olean', '.lake/packages/mathlib/.git/config']) {
    await writeFile(join(a, path), 'job A changed/compiled');
    assert.equal(await readFile(join(b, path), 'utf8'), 'seed');
    assert.equal(await readFile(join(seed, path), 'utf8'), 'seed');
  }
  await Promise.all([a, b].map(path => withBuildSlot(async () => {
    assert.equal(++live, 1); await pause();
    await writeFile(join(path, '.lake/build/Same.olean'), path); live--;
  })));
  assert.equal(await readFile(join(a, '.lake/build/Same.olean'), 'utf8'), a);
  assert.equal(await readFile(join(b, '.lake/build/Same.olean'), 'utf8'), b);
  assert.equal(await readFile(join(seed, '.lake/build/Same.olean'), 'utf8'), 'seed');
  assert.ok(!(await readdir(a)).includes('.git'));
  const c = await manager(environment, h.options, h.identity);
  assert.equal(setups, 1);
  assert.equal(await readFile(join(c, 'lakefile.lean'), 'utf8'), 'seed');
  await releaseWorkspace(a, h.options);
  assert.equal(await readFile(join(b, 'lakefile.lean'), 'utf8'), 'seed');
  await assert.rejects(releaseWorkspace(seed, h.options), /Unsafe/);
});

test('failed setup never publishes a ready seed and all waiters can retry', async t => {
  const h = await fixture(t); let calls = 0;
  const manager = createWorkspaceManager(async path => {
    await initialize(path); await pause(); if (++calls === 1) throw new Error('smoke failed');
  });
  const failures = await Promise.allSettled([manager(environment, h.options, h.identity), manager(environment, h.options, h.identity)]);
  assert.ok(failures.every(result => result.status === 'rejected' && /smoke failed/.test(result.reason.message)));
  assert.deepEqual(await readdir(join(h.root, 'seeds')), []);
  await manager(environment, h.options, h.identity); assert.equal(calls, 2);
});

test('released slots are reused with fresh sources/configuration and byte-verified private packages', async t => {
  const h = await fixture(t), manager = createWorkspaceManager(initialize);
  const a = await manager(environment, { ...h.options, workspaceOwner: 'a' }, h.identity);
  const b = await manager(environment, { ...h.options, workspaceOwner: 'b' }, h.identity);
  const packageFile = join(a, '.lake/packages/mathlib/source.lean');
  const original = await stat(packageFile);
  const unchanged = join(a, '.lake/packages/mathlib/.lake/build/Same.olean');
  const unchangedInfo = await stat(unchanged);
  // A same-size edit with the original timestamp must still be restored.
  await writeFile(packageFile, 'evil');
  await utimes(packageFile, original.atime, original.mtime);
  await rm(join(a, '.lake/packages/mathlib/.git/config'));
  await writeFile(join(a, '.lake/packages/mathlib/injected.lean'), 'job A');
  await mkdir(join(a, '.lake/packages/extra/nested'), { recursive: true });
  await writeFile(join(a, '.lake/packages/extra/nested/file'), 'job A');
  for (const file of ['lakefile.lean', 'lake-manifest.json', 'lean-toolchain', 'Solutions/Same.lean', 'Definitions/Same.lean', 'Theorems/Same.lean'])
    await writeFile(join(a, file), 'job A');
  for (const file of ['Solutions/Leak.lean', '.lake/build/Leak.olean', 'unexpected.txt']) await writeFile(join(a, file), 'job A');
  const oldMarker = JSON.parse(await readFile(join(a, '.runner-workspace.json'), 'utf8'));
  await releaseWorkspace(a, h.options);
  await assert.rejects(releaseWorkspace(a, h.options), /lease ownership/);
  const reused = await manager(environment, { ...h.options, workspaceOwner: 'c' }, h.identity);
  assert.equal(reused, a);
  const marker = JSON.parse(await readFile(join(a, '.runner-workspace.json'), 'utf8'));
  assert.equal(marker.owner, 'c'); assert.notEqual(marker.lease_id, oldMarker.lease_id);
  assert.equal(await readFile(packageFile, 'utf8'), 'seed');
  assert.equal(await readFile(join(a, '.lake/packages/mathlib/.git/config'), 'utf8'), 'seed');
  assert.equal((await stat(packageFile)).mtimeMs, original.mtimeMs);
  const after = await stat(unchanged);
  assert.equal(after.ino, unchangedInfo.ino, 'unchanged dependency output stays in place');
  assert.equal(after.mtimeMs, unchangedInfo.mtimeMs);
  for (const file of ['lakefile.lean', 'lake-manifest.json', 'lean-toolchain', 'Solutions/Same.lean', 'Definitions/Same.lean', 'Theorems/Same.lean'])
    assert.equal(await readFile(join(a, file), 'utf8'), 'seed');
  for (const file of ['Solutions/Leak.lean', '.lake/build/Leak.olean', 'unexpected.txt', '.lake/packages/mathlib/injected.lean', '.lake/packages/extra'])
    assert.equal(await exists(join(a, file)), false, file);
  assert.equal(await readFile(join(b, 'Solutions/Same.lean'), 'utf8'), 'seed');
  await releaseWorkspace(reused, h.options); await releaseWorkspace(b, h.options);
});

test('pool capacity follows active jobs, excludes live leases and permits reuse after release', async t => {
  const h = await fixture(t), manager = createWorkspaceManager(initialize);
  const options = { ...h.options, pipeline: { maxActiveJobs: 2 } };
  const [a, b] = await Promise.all([manager(environment, options, h.identity), manager(environment, options, h.identity)]);
  assert.notEqual(a, b);
  await assert.rejects(manager(environment, options, h.identity), /capacity \(2\).*exhausted/);
  await releaseWorkspace(a, options);
  await assert.rejects(manager(environment, { ...options, pipeline: { maxActiveJobs: 1 } }, h.identity), /capacity \(1\).*exhausted/);
  const otherManager = createWorkspaceManager(initialize);
  assert.equal(await otherManager(environment, options, h.identity), a);
  assert.equal((await readdir(join(h.root, 'jobs'))).length, 2);
  await releaseWorkspace(a, options); await releaseWorkspace(b, options);
});

test('restart recovers orphaned slots but leaves legacy directories and other environments alone', async t => {
  const h = await fixture(t), manager = createWorkspaceManager(initialize);
  const legacy = join(h.root, 'jobs', '1'.repeat(16));
  await mkdir(legacy, { recursive: true });
  await writeFile(join(legacy, 'keep.txt'), 'legacy');
  const a = await manager(environment, h.options, h.identity);
  await releaseWorkspace(a, h.options);
  const markerPath = join(a, '.runner-workspace.json');
  const marker = JSON.parse(await readFile(markerPath, 'utf8'));
  // Simulate the durable marker left by a dead process (no in-memory lease).
  await save(markerPath, { ...marker, state: 'resetting', owner: 'dead-job', lease_id: 'dead-lease' });
  await writeFile(join(a, 'Solutions/Leak.lean'), 'interrupted job');
  const second = environmentIdentity({ ...environment, mathlib_rev: 'b'.repeat(40) }, h.options, 'trusted config');
  const b = await manager(environment, h.options, second);
  assert.notEqual(b, a);
  const restarted = createWorkspaceManager(() => { throw new Error('seed should already exist'); });
  assert.equal(await restarted(environment, h.options, h.identity), a);
  assert.equal(await exists(join(a, 'Solutions/Leak.lean')), false);
  assert.equal(await readFile(join(legacy, 'keep.txt'), 'utf8'), 'legacy');
  await releaseWorkspace(a, h.options); await releaseWorkspace(b, h.options);
});

test('unsafe junctions and hard links discard a slot without changing their outside target', async t => {
  const h = await fixture(t), manager = createWorkspaceManager(initialize);
  const outside = join(h.root, 'outside');
  await mkdir(outside); await writeFile(join(outside, 'keep.txt'), 'outside');
  for (const kind of ['junction', 'hardlink']) {
    const a = await manager(environment, h.options, h.identity);
    if (kind === 'junction') {
      await rm(join(a, '.lake/packages/mathlib'), { recursive: true });
      await symlink(outside, join(a, '.lake/packages/mathlib'), process.platform === 'win32' ? 'junction' : 'dir');
    } else {
      await link(join(outside, 'keep.txt'), join(a, '.lake/packages/mathlib/shared.txt'));
    }
    await releaseWorkspace(a, h.options);
    const b = await manager(environment, h.options, h.identity);
    assert.notEqual(b, a); assert.equal(await exists(a), false);
    assert.equal(await readFile(join(outside, 'keep.txt'), 'utf8'), 'outside');
    await releaseWorkspace(b, h.options);
  }
});

test('cancelled acquisition never leases a dirty slot and can retry safely', async t => {
  const h = await fixture(t), manager = createWorkspaceManager(initialize);
  const a = await manager(environment, h.options, h.identity);
  await releaseWorkspace(a, h.options);
  const controller = new AbortController(), reason = new Error('operator cancelled');
  const log = console.log;
  t.mock.method(console, 'log', (...args) => {
    if (args.some(value => String(value).includes('resetting reusable workspace'))) controller.abort(reason);
    log(...args);
  });
  await assert.rejects(manager(environment, { ...h.options, signal: controller.signal }, h.identity), error => error === reason);
  assert.equal(JSON.parse(await readFile(join(a, '.runner-workspace.json'), 'utf8')).state, 'resetting');
  t.mock.restoreAll();
  assert.equal(await manager(environment, h.options, h.identity), a);
  await releaseWorkspace(a, h.options);
});

test('real Lake builds successive jobs in a reused slot without rebuilding unchanged package artifacts',
  { skip: !process.env.LEAN_TEST_BINARY }, async t => {
    const h = await fixture(t);
    const lake = join(dirname(process.env.LEAN_TEST_BINARY), process.platform === 'win32' ? 'lake.exe' : 'lake');
    const execute = promisify(execFile);
    const build = async workspace => {
      const { stdout, stderr } = await execute(lake, ['build', 'Solutions.SmokeTest'], { cwd: workspace, windowsHide: true, timeout: 60000 });
      return stdout + stderr;
    };
    const manager = createWorkspaceManager(async workspace => {
      const helper = join(workspace, '.lake/packages/helper');
      await mkdir(helper, { recursive: true }); await mkdir(join(workspace, 'Solutions'));
      await writeFile(join(workspace, 'lean-toolchain'), environment.toolchain + '\n');
      await writeFile(join(helper, 'lakefile.lean'), 'import Lake\nopen Lake DSL\npackage helper\nlean_lib Helper\n');
      await writeFile(join(helper, 'Helper.lean'), 'def helper : Nat := 7\n');
      await writeFile(join(workspace, 'lakefile.lean'), 'import Lake\nopen Lake DSL\npackage pool_test\nrequire helper from ".lake/packages/helper"\nlean_lib Solutions\n');
      await writeFile(join(workspace, 'Solutions/SmokeTest.lean'), 'import Helper\nexample : helper = 7 := rfl\n');
      await build(workspace);
    });
    const a = await manager(environment, h.options, h.identity);
    const artifact = join(a, '.lake/packages/helper/.lake/build/lib/lean/Helper.olean');
    const before = await stat(artifact);
    await writeFile(join(a, 'Solutions/SmokeTest.lean'), 'import Helper\nexample : helper + 1 = 8 := rfl\n');
    await build(a);
    await writeFile(join(a, '.lake/packages/helper/Helper.lean'), 'def helper : Nat := 9\n');
    await releaseWorkspace(a, h.options);
    const b = await manager(environment, h.options, h.identity);
    assert.equal(a, b);
    assert.equal(await readFile(join(b, '.lake/packages/helper/Helper.lean'), 'utf8'), 'def helper : Nat := 7\n');
    assert.doesNotMatch(await build(b), /Built Helper(?:\s|$)/);
    assert.equal((await stat(artifact)).mtimeMs, before.mtimeMs);
    await writeFile(join(b, 'Solutions/SmokeTest.lean'), 'import Helper\nexample : helper * 2 = 14 := rfl\n');
    await build(b);
    await releaseWorkspace(b, h.options);
  });

test('setup is serialized across distinct environment identities and a failed write does not poison the slot', async t => {
  const h = await fixture(t); let live = 0, count = 0;
  const manager = createWorkspaceManager(async path => {
    assert.equal(++live, 1); count++; await pause(); await initialize(path); live--;
  });
  const second = environmentIdentity({ ...environment, toolchain: 'leanprover/lean4:v4.34.0' }, h.options, 'trusted config');
  await Promise.all([manager(environment, h.options, h.identity), manager(environment, h.options, second)]);
  assert.equal(count, 2);
  const identities = [environmentIdentity(environment, { ...h.options, apiVersion: 'new' }, 'trusted config'),
    environmentIdentity(environment, h.options, 'changed config'),
    environmentIdentity({ ...environment, mathlib_rev: 'b'.repeat(40) }, h.options, 'trusted config')];
  assert.equal(new Set([h.identity, second, ...identities].map(row => digest(json(row)))).size, 5);
});

test('environment copies reject junctions that would share writable dependency paths', async t => {
  const h = await fixture(t), source = join(h.root, 'source'), outside = join(h.root, 'outside');
  await mkdir(source); await mkdir(outside);
  await symlink(outside, join(source, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(copyEnvironment(source, join(h.root, 'copy')), /Linked environment path/);
});

test('Mathlib file symlinks become independent files during copying and reused-workspace repair', async t => {
  const h = await fixture(t);
  if (!await fileSymlinksAvailable(t, h.root)) return;
  const script = '.lake/packages/mathlib/scripts/bench/build/fake-root/bin/lean';
  const alias = `${script}.py`;
  const manager = createWorkspaceManager(async path => {
    await initialize(path);
    await mkdir(dirname(join(path, script)), { recursive: true });
    await writeFile(join(path, script), 'print("Mathlib benchmark")\n', { mode: 0o755 });
    await symlink('lean', join(path, alias), 'file');
  });
  const a = await manager(environment, h.options, h.identity);
  const seed = join(h.root, 'seeds', digest(json(h.identity)).slice(0, 16));
  assert.equal((await lstat(join(seed, alias))).isSymbolicLink(), true, 'trusted seed remains unchanged');
  assert.equal((await lstat(join(a, alias))).isSymbolicLink(), false);
  assert.equal((await lstat(join(a, alias))).nlink, 1);
  assert.equal(await readFile(join(a, alias), 'utf8'), await readFile(join(seed, script), 'utf8'));
  assert.equal((await stat(join(a, alias))).mtime.getTime(), (await stat(join(seed, script))).mtime.getTime());
  if (process.platform !== 'win32') assert.equal((await stat(join(a, alias))).mode & 0o777, 0o755);
  await writeFile(join(a, alias), 'private edit');
  assert.equal(await readFile(join(a, script), 'utf8'), 'print("Mathlib benchmark")\n');
  assert.equal(await readFile(join(seed, alias), 'utf8'), 'print("Mathlib benchmark")\n');
  await releaseWorkspace(a, h.options);
  assert.equal(await manager(environment, h.options, h.identity), a, 'seed inventory supports internal file symlinks');
  assert.equal(await readFile(join(a, alias), 'utf8'), 'print("Mathlib benchmark")\n');
  assert.equal((await lstat(join(a, alias))).isSymbolicLink(), false);
  await writeFile(join(a, alias), 'another edit');
  await releaseWorkspace(a, h.options);
  const restarted = createWorkspaceManager(() => assert.fail('existing seed must be reused'));
  assert.equal(await restarted(environment, h.options, h.identity), a);
  assert.equal(await readFile(join(a, alias), 'utf8'), 'print("Mathlib benchmark")\n');
  await releaseWorkspace(a, h.options);
});

test('materializing file aliases still rejects external targets, directory links and linked Git files', async t => {
  const h = await fixture(t);
  if (!await fileSymlinksAvailable(t, h.root)) return;
  const source = join(h.root, 'source'), outside = join(h.root, 'outside');
  await mkdir(source); await mkdir(outside);
  await writeFile(join(outside, 'keep.txt'), 'outside');
  await symlink(join(outside, 'keep.txt'), join(source, 'external'), 'file');
  await assert.rejects(copyEnvironment(source, join(h.root, 'external-copy')), /Linked environment path/);
  await rm(join(source, 'external'));
  await mkdir(join(source, 'directory'));
  await symlink(join(source, 'directory'), join(source, 'directory-alias'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(copyEnvironment(source, join(h.root, 'directory-copy')), /Linked environment path/);
  await rm(join(source, 'directory-alias'));
  await mkdir(join(source, '.lake/packages/mathlib/.git'), { recursive: true });
  await writeFile(join(source, 'config'), 'private config');
  await symlink('../../../../config', join(source, '.lake/packages/mathlib/.git/config'), 'file');
  await assert.rejects(copyEnvironment(source, join(h.root, 'git-copy')), /Linked environment path/);
  assert.equal(await readFile(join(outside, 'keep.txt'), 'utf8'), 'outside');
});

test('parallel environment copies preserve timestamps, empty directories and independent dependency Git data', async t => {
  const h = await fixture(t), source = join(h.root, 'source'), destination = join(h.root, 'copy');
  await initialize(source);
  await mkdir(join(source, 'empty'));
  await save(join(source, '.runner-seed.json'), { private: true });
  await save(join(source, '.runner-package-inventory.json'), { private: true });
  const directory = join(source, '.lake/packages/mathlib');
  await Promise.all(Array.from({ length: 40 }, (_, i) => writeFile(join(directory, `${i}.lean`), `file ${i}`)));
  await copyEnvironment(source, destination);
  assert.deepEqual(await readdir(join(destination, 'empty')), []);
  for (const excluded of ['.git', '.runner-seed.json', '.runner-package-inventory.json'])
    assert.equal(await exists(join(destination, excluded)), false);
  for (let i = 0; i < 40; i++) {
    const file = `.lake/packages/mathlib/${i}.lean`;
    assert.equal(await readFile(join(destination, file), 'utf8'), `file ${i}`);
    assert.equal((await stat(join(destination, file))).mtime.getTime(), (await stat(join(source, file))).mtime.getTime());
    assert.equal((await stat(join(destination, file))).nlink, 1);
  }
  const gitFile = '.lake/packages/mathlib/.git/config';
  await writeFile(join(destination, gitFile), 'private edit');
  assert.equal(await readFile(join(source, gitFile), 'utf8'), 'seed');
  await assert.rejects(copyEnvironment(source, destination), { code: 'ERR_FS_CP_EEXIST' });
  await assert.rejects(copyEnvironment(source, join(source, 'nested')), /outside its source/);
  assert.equal(await exists(join(source, 'nested')), false);
});

test('copies reject dependency Git worktree pointers and shared object stores', async t => {
  const h = await fixture(t), source = join(h.root, 'source');
  await initialize(source);
  const git = join(source, '.lake/packages/mathlib/.git');
  await mkdir(join(git, 'objects/info'), { recursive: true });
  await writeFile(join(git, 'objects/info/alternates'), '/outside/objects\n');
  await assert.rejects(copyEnvironment(source, join(h.root, 'alternates')), /Shared Git objects/);
  await rm(git, { recursive: true });
  await writeFile(git, 'gitdir: /outside/worktree');
  await assert.rejects(copyEnvironment(source, join(h.root, 'worktree')), /Linked Git metadata/);
});

test('cancellation during a parallel copy drains writes before rejecting', async t => {
  const h = await fixture(t), source = join(h.root, 'source'), destination = join(h.root, 'copy');
  await mkdir(source);
  await Promise.all(Array.from({ length: 100 }, (_, i) => writeFile(join(source, `${i}.lean`), 'seed')));
  const controller = new AbortController(), reason = new Error('operator cancelled copy');
  const check = controller.signal.throwIfAborted;
  let checks = 0;
  t.mock.method(controller.signal, 'throwIfAborted', function () {
    if (++checks === 25) controller.abort(reason);
    check.call(this);
  });
  await assert.rejects(copyEnvironment(source, destination, { signal: controller.signal }), error => error === reason);
  assert.ok((await readdir(destination)).length < 100, 'copy stops before the remaining files');
  await rm(destination, { recursive: true });
  await pause();
  assert.equal(await exists(destination), false, 'no pending writes recreate the removed staging tree');
});

test('copy heartbeats report completed files and bytes and stop on completion', async t => {
  const h = await fixture(t), source = join(h.root, 'source');
  await mkdir(source);
  await writeFile(join(source, 'artifact.olean'), Buffer.alloc(1024 ** 2));
  const messages = [];
  t.mock.method(console, 'log', message => messages.push(message));
  t.mock.timers.enable({ apis: ['setInterval'] });
  const pending = copyEnvironment(source, join(h.root, 'copy'), { label: 'test copy' });
  t.mock.timers.tick(30000);
  assert.match(messages.at(-1), /workspace copy running .*0 files copied, 0\.0 MiB copied/);
  await pending;
  assert.match(messages.at(-1), /copy completed .*1 files copied, 1\.0 MiB copied/);
  const count = messages.length;
  t.mock.timers.tick(30000);
  assert.equal(messages.length, count, 'completed copies stop their heartbeat');
});

test('workspace progress publishes phases and throttled heartbeats and clears its timer after success or cancellation', async t => {
  const h = await fixture(t), updates = [];
  let ready;
  const gate = new Promise(resolve => { ready = resolve; });
  const manager = createWorkspaceManager(async path => { await gate; await initialize(path); });
  t.mock.timers.enable({ apis: ['setInterval'] });
  const options = { ...h.options, onWorkspaceProgress: status => updates.push(status) };
  const pending = manager(environment, options, h.identity);
  assert.equal(updates.at(-1).phase, 'seed');
  const initial = updates.length;
  t.mock.timers.tick(5000);
  assert.equal(updates.length, initial + 1, 'heartbeat continues while seed initialization waits');
  ready();
  const workspace = await pending;
  assert.deepEqual([...new Set(updates.map(s => s.phase))], ['seed', 'waiting', 'copy']);
  assert.equal(updates.at(-1).files_copied, 10);
  assert.ok(updates.at(-1).bytes_copied > 0);
  const completed = updates.length;
  t.mock.timers.tick(30000);
  assert.equal(updates.length, completed, 'completed copies stop publishing');
  await releaseWorkspace(workspace, options);
  await releaseWorkspace(await manager(environment, options, h.identity), options);
  assert.equal(updates.at(-1).phase, 'reset');
  const controller = new AbortController(), reason = new Error('cancelled workspace setup');
  const nextIdentity = { ...h.identity, api_version: 'next' };
  await assert.rejects(manager(environment, { ...options, signal: controller.signal, onWorkspaceProgress: status => {
    updates.push(status);
    if (status.phase === 'copy') controller.abort(reason);
  } }, nextIdentity), error => error === reason);
  const cancelled = updates.length;
  t.mock.timers.tick(30000);
  assert.equal(updates.length, cancelled, 'cancelled copies stop publishing');
});

test('fresh workspace cancellation removes staging, releases capacity and permits retry', async t => {
  const h = await fixture(t), manager = createWorkspaceManager(initialize);
  const controller = new AbortController(), reason = new Error('operator cancelled fresh copy');
  t.mock.method(console, 'log', message => {
    if (String(message).includes('copying the pinned environment')) controller.abort(reason);
  });
  const options = { ...h.options, pipeline: { maxActiveJobs: 1 }, signal: controller.signal };
  await assert.rejects(manager(environment, options, h.identity), error => error === reason);
  assert.deepEqual(await readdir(join(h.root, 'jobs')), []);
  t.mock.restoreAll();
  const workspace = await manager(environment, { ...options, signal: undefined }, h.identity);
  await releaseWorkspace(workspace, h.options);
});

test('shared cache/state replacements are ordered, atomic JSON with no temporary-file collisions', async t => {
  const h = await fixture(t), path = join(h.root, 'cache', 'module.json');
  await Promise.all(Array.from({ length: 60 }, (_, index) => save(path, { index, source: 'x'.repeat(5000) })));
  assert.equal(JSON.parse(await readFile(path, 'utf8')).index, 59);
  assert.deepEqual(await readdir(join(h.root, 'cache')), ['module.json']);
  await mkdir(join(h.root, 'bad.json'));
  await assert.rejects(save(join(h.root, 'bad.json'), {}));
  await rm(join(h.root, 'bad.json'), { recursive: true });
  await save(join(h.root, 'bad.json'), { recovered: true });
  assert.deepEqual(JSON.parse(await readFile(join(h.root, 'bad.json'), 'utf8')), { recovered: true });
});

const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
test('concurrent initial authentication shares one refresh, and refresh failure can be retried', async () => {
  let refreshes = 0, fail = true;
  const client = new Client('private', async url => {
    if (url.pathname.endsWith('agent/refresh')) {
      refreshes++; await pause();
      return fail ? response({}, 503) : response({ access_token: 'new', expires_at: Date.now() / 1000 + 3600 });
    }
    return response({ ok: true });
  });
  const failures = await Promise.allSettled([client.request('theorems/a'), client.request('theorems/b')]);
  assert.ok(failures.every(row => row.status === 'rejected')); assert.equal(refreshes, 1);
  fail = false;
  await Promise.all([client.request('theorems/a'), client.request('theorems/b')]);
  assert.equal(refreshes, 2);
});

test('simultaneous and late old-token 401s share one renewal and use the latest credentials', async () => {
  let refreshes = 0, releaseLate;
  const late = new Promise(resolve => { releaseLate = resolve; });
  const client = new Client('private', async (url, options) => {
    if (url.pathname.endsWith('agent/refresh')) {
      refreshes++; await pause();
      return response({ access_token: 'new', expires_at: Date.now() / 1000 + 3600 });
    }
    if (options.headers.Authorization === 'Bearer old') {
      if (url.pathname.endsWith('/late')) await late;
      return response({}, 401);
    }
    assert.equal(options.headers.Authorization, 'Bearer new'); return response({ ok: true });
  });
  client.token = 'old'; client.expiry = Date.now() + 3600000;
  const delayed = client.request('theorems/late');
  await Promise.all([client.request('theorems/a'), client.request('theorems/b')]);
  releaseLate(); await delayed; assert.equal(refreshes, 1);
});
