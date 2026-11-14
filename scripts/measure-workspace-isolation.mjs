// Local-only acceptance measurement. Copies an already prepared environment;
// makes no API/model requests and leaves its outputs for inspection/removal.
// Usage: node scripts/measure-workspace-isolation.mjs SOURCE OUTPUT LAKE_EXE
import { mkdir, readdir, lstat, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createWorkspaceManager, copyEnvironment, environmentIdentity } from '../isolated-workspaces.mjs';
import { command } from '../prove2me.mjs';
import { withBuildSlot } from '../shared-resources.mjs';
import { digest, json, save } from '../runner-state.mjs';

const [sourceArg, outputArg, lake] = process.argv.slice(2);
if (!sourceArg || !outputArg || !lake) throw new Error('Provide SOURCE OUTPUT LAKE_EXE');
const source = resolve(sourceArg), output = resolve(outputArg);
async function size(path) {
  let bytes = 0, files = 0;
  for (const row of await readdir(path, { withFileTypes: true })) {
    const file = join(path, row.name);
    if (row.isDirectory()) { const child = await size(file); bytes += child.bytes; files += child.files; }
    else { bytes += (await lstat(file)).size; files++; }
  }
  return { bytes, files };
}
const environment = JSON.parse(await readFile(join(source, '.runner-ready.json'), 'utf8'));
const options = { workspaces: output, runs: join(output, 'logs') };
const identity = environmentIdentity(environment, options, 'isolation-measurement-v2');
const baseline = await size(source);
console.log(json({ baseline, platform: process.platform, toolchain: environment.toolchain }));
const build = (workspace, label) => withBuildSlot(() => command(lake, ['build', 'Solutions.IsolationCheck'],
  { cwd: workspace, log: join(options.runs, `${label}.log`), timeout: 300000 }));
const proofA = 'import Mathlib.Data.Real.Basic\ntheorem isolationResult : (1 : ℝ) = 1 := by rfl\n';
const proofB = 'import Mathlib.Data.Real.Basic\ntheorem isolationResult : (2 : ℝ) = 2 := by rfl\n';
const manager = createWorkspaceManager(async workspace => {
  await copyEnvironment(source, workspace);
  await mkdir(join(workspace, 'Solutions'), { recursive: true });
  await writeFile(join(workspace, 'Solutions/IsolationCheck.lean'), proofA);
  // Successful real smoke build before publishing the fixture seed.
  await build(workspace, 'seed');
});
const started = performance.now(), first = await manager(environment, options, identity);
const firstPrepared = performance.now(), second = await manager(environment, options, identity);
const secondPrepared = performance.now();
const seed = join(output, 'seeds', digest(json(identity)).slice(0, 16));
const seedFiles = ['Solutions/IsolationCheck.lean', 'lakefile.lean', 'lean-toolchain', 'lake-manifest.json',
  '.lake/packages/mathlib/.git/index', '.lake/packages/mathlib/.lake/build/lib/lean/Mathlib/Data/Real/Basic.olean',
  '.lake/build/lib/lean/Solutions/IsolationCheck.olean'];
const hashes = async (workspace, files) => Object.fromEntries(await Promise.all(files.map(async file =>
  [file, digest(await readFile(join(workspace, file)))])));
const beforeSeed = await hashes(seed, seedFiles);
const outputFile = '.lake/build/lib/lean/Solutions/IsolationCheck.olean';
// Compile each candidate freshly rather than measuring a cached leaf replay.
for (const workspace of [first, second]) await rm(join(workspace, outputFile), { force: true });
await writeFile(join(first, 'Solutions/IsolationCheck.lean'), proofA);
await writeFile(join(second, 'Solutions/IsolationCheck.lean'), proofB);
const firstStart = performance.now(); await build(first, 'first'); const firstEnd = performance.now();
const secondStart = performance.now(); await build(second, 'second'); const secondEnd = performance.now();
if (await readFile(join(first, 'Solutions/IsolationCheck.lean'), 'utf8') !== proofA ||
    await readFile(join(second, 'Solutions/IsolationCheck.lean'), 'utf8') !== proofB ||
    await readFile(join(seed, 'Solutions/IsolationCheck.lean'), 'utf8') !== proofA) throw new Error('Isolation check failed');
if (json(beforeSeed) !== json(await hashes(seed, seedFiles))) throw new Error('Job builds changed the seed');
const outputHashes = [digest(await readFile(join(first, outputFile))), digest(await readFile(join(second, outputFile)))];
if (outputHashes[0] === outputHashes[1]) throw new Error('Distinct job proofs did not produce independent compiled output');
const report = { date: new Date().toISOString(), platform: process.platform, environment, baseline,
  strategy: 'ordinary independent copies, including dependency Git metadata; no hard links, symlinks, or junctions',
  prepare_first_ms: firstPrepared - started, prepare_second_ms: secondPrepared - firstPrepared,
  build_first_ms: firstEnd - firstStart, build_second_ms: secondEnd - secondStart,
  seed_hashes_unchanged: true, job_output_hashes: outputHashes,
  seed: { path: seed, ...await size(seed) },
  jobs: [{ path: first, ...await size(first) }, { path: second, ...await size(second) }] };
await save(join(output, 'measurement.json'), report);
console.log(json(report));
