import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { restoreCompiledDependencies, publishCompiledDependencies } from '../compiled-dependencies.mjs';
import { writeIfChanged } from '../runner-state.mjs';

const execute = promisify(execFile);
const sources = new Map([
  ['Definitions.Base', 'def base : Nat := 3\n'],
  ['Theorems.Use', 'import Definitions.Base\ntheorem use : base = 3 := rfl\n'],
]);
async function fixture(t, real = false) {
  const root = await mkdtemp(join(tmpdir(), 'p2m-cache-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.mock.method(console, 'log', () => {});
  const options = { workspaces: root };
  async function workspace(name, change = {}) {
    const path = join(root, name);
    for (const dir of ['Definitions', 'Theorems', 'Solutions']) await mkdir(join(path, dir), { recursive: true });
    await writeFile(join(path, 'lean-toolchain'), change.toolchain ?? 'leanprover/lean4:v4.33.1\n');
    await writeFile(join(path, 'lakefile.lean'), change.configuration ??
      'import Lake\nopen Lake DSL\npackage cache_test\nlean_lib Definitions\nlean_lib Theorems\nlean_lib Solutions\n');
    if (!real) await writeFile(join(path, 'lake-manifest.json'), change.manifest ?? '{}');
    await writeFile(join(path, '.runner-workspace.json'), JSON.stringify({ workspace_id: name, owner: name,
      environment: { toolchain: 'test', mathlib_rev: change.rev ?? 'pin', configuration_hash: 'config' } }));
    for (const [module, source] of sources) await writeFile(join(path, module.replaceAll('.', '/') + '.lean'), change[module] ?? source);
    return path;
  }
  async function artifacts(path, module, bytes = module) {
    for (const [folder, suffix] of [['lib/lean', '.olean'], ['lib/lean', '.olean.hash'], ['lib/lean', '.trace'], ['ir', '.c']]) {
      const file = join(path, '.lake/build', folder, module.replaceAll('.', '/') + suffix);
      await mkdir(dirname(file), { recursive: true }); await writeFile(file, bytes);
    }
  }
  return { root, options, workspace, artifacts };
}

test('compiled platform artifacts transfer to private files, with timestamps and transitive identity preserved', async t => {
  const h = await fixture(t), a = await h.workspace('a');
  await restoreCompiledDependencies(a, ['Theorems.Use'], h.options);
  for (const module of sources.keys()) await h.artifacts(a, module);
  await h.artifacts(a, 'Solutions.Private', 'must never be exported');
  await publishCompiledDependencies(a, h.options);
  const b = await h.workspace('b');
  await restoreCompiledDependencies(b, ['Theorems.Use'], h.options);
  const artifact = '.lake/build/lib/lean/Theorems/Use.olean';
  assert.equal(await readFile(join(b, artifact), 'utf8'), 'Theorems.Use');
  assert.ok(Math.abs((await stat(join(a, artifact))).mtimeMs - (await stat(join(b, artifact))).mtimeMs) < 1);
  await writeFile(join(b, artifact), 'job changed');
  assert.equal(await readFile(join(a, artifact), 'utf8'), 'Theorems.Use');
  const c = await h.workspace('c'); await restoreCompiledDependencies(c, ['Theorems.Use'], h.options);
  assert.equal(await readFile(join(c, artifact), 'utf8'), 'Theorems.Use');
  await assert.rejects(readFile(join(c, '.lake/build/lib/lean/Solutions/Private.olean')), { code: 'ENOENT' });
});

test('source changes invalidate dependent modules and pins/configuration invalidate the whole cache', async t => {
  const h = await fixture(t), a = await h.workspace('a');
  await restoreCompiledDependencies(a, ['Theorems.Use'], h.options);
  for (const module of sources.keys()) await h.artifacts(a, module);
  await publishCompiledDependencies(a, h.options);
  for (const [name, change] of Object.entries({
    transitive: { 'Definitions.Base': 'def base : Nat := 4\n' },
    direct: { 'Theorems.Use': 'import Definitions.Base\ntheorem use : True := by trivial\n' },
    toolchain: { toolchain: 'another Lean version' },
    mathlib: { rev: 'different pin' }, configuration: { configuration: 'new configuration' },
    packages: { manifest: '{"packages":["different"]}' },
  })) {
    const b = await h.workspace(name, change); await restoreCompiledDependencies(b, ['Theorems.Use'], h.options);
    await assert.rejects(readFile(join(b, '.lake/build/lib/lean/Theorems/Use.olean')), { code: 'ENOENT' });
  }
});

test('incomplete builds and modified inputs are never published; exports stop before subsequent model edits', async t => {
  const h = await fixture(t), a = await h.workspace('a');
  await restoreCompiledDependencies(a, ['Theorems.Use'], h.options);
  await publishCompiledDependencies(a, h.options);
  assert.deepEqual(await readdir(join(h.root, 'compiled', (await readdir(join(h.root, 'compiled')))[0])), []);
  for (const module of sources.keys()) await h.artifacts(a, module);
  await publishCompiledDependencies(a, h.options); // no live session after first export
  const b = await h.workspace('b'); await restoreCompiledDependencies(b, ['Theorems.Use'], h.options);
  await assert.rejects(readFile(join(b, '.lake/build/lib/lean/Theorems/Use.olean')), { code: 'ENOENT' });
  await h.artifacts(b, 'Theorems.Use');
  await writeFile(join(b, 'Definitions/Base.lean'), 'def base : Nat := 4\n');
  await publishCompiledDependencies(b, h.options);
  const c = await h.workspace('c'); await restoreCompiledDependencies(c, ['Theorems.Use'], h.options);
  await assert.rejects(readFile(join(c, '.lake/build/lib/lean/Theorems/Use.olean')), { code: 'ENOENT' });
});

test('corrupt cached bytes cause a miss rather than installing unverified artifacts', async t => {
  const h = await fixture(t), a = await h.workspace('a');
  await restoreCompiledDependencies(a, ['Definitions.Base'], h.options);
  await h.artifacts(a, 'Definitions.Base'); await publishCompiledDependencies(a, h.options);
  const environment = (await readdir(join(h.root, 'compiled')))[0];
  const entry = (await readdir(join(h.root, 'compiled', environment)))[0];
  await writeFile(join(h.root, 'compiled', environment, entry, 'lib/lean/Definitions/Base.olean'), 'corrupted');
  const b = await h.workspace('b'); await restoreCompiledDependencies(b, ['Definitions.Base'], h.options);
  await assert.rejects(readFile(join(b, '.lake/build/lib/lean/Definitions/Base.olean')), { code: 'ENOENT' });
});

test('real Lake reuses moved compiled dependencies and a stable readiness module, then rebuilds changed dependencies',
  { skip: !process.env.LEAN_TEST_BINARY }, async t => {
    const h = await fixture(t, true);
    const lake = join(dirname(process.env.LEAN_TEST_BINARY), process.platform === 'win32' ? 'lake.exe' : 'lake');
    const run = async (path, args) => {
      const output = await execute(lake, args, { cwd: path, windowsHide: true, timeout: 60000 });
      return output.stdout + output.stderr;
    };
    const a = await h.workspace('a'); await run(a, ['update']);
    await restoreCompiledDependencies(a, ['Theorems.Use'], h.options);
    await run(a, ['build', 'Theorems.Use']); await publishCompiledDependencies(a, h.options);
    const b = await h.workspace('b'); await run(b, ['update']);
    await restoreCompiledDependencies(b, ['Theorems.Use'], h.options);
    const before = (await stat(join(b, '.lake/build/lib/lean/Theorems/Use.olean'))).mtimeMs;
    const output = await run(b, ['build', 'Theorems.Use']);
    assert.doesNotMatch(output, /Built (Definitions\.Base|Theorems\.Use)/);
    assert.equal((await stat(join(b, '.lake/build/lib/lean/Theorems/Use.olean'))).mtimeMs, before);
    const probe = join(b, 'Solutions/RunnerEnvironment.lean');
    await writeIfChanged(probe, 'import Theorems.Use\nexample : True := by trivial\n');
    await run(b, ['build', 'Solutions.RunnerEnvironment']);
    assert.equal(await writeIfChanged(probe, 'import Theorems.Use\nexample : True := by trivial\n'), false);
    assert.doesNotMatch(await run(b, ['build', 'Solutions.RunnerEnvironment']), /Built Solutions\.RunnerEnvironment/);
    const c = await h.workspace('c', { 'Definitions.Base': 'def base : Nat := 4\n',
      'Theorems.Use': 'import Definitions.Base\ntheorem use : base = 4 := rfl\n' });
    await run(c, ['update']); await restoreCompiledDependencies(c, ['Theorems.Use'], h.options);
    assert.match(await run(c, ['build', 'Theorems.Use']), /Built Definitions\.Base/);
  });
