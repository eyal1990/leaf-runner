import { randomUUID } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, readdir, rename, rm, utimes } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { imports } from './lean-artifacts.mjs';
import { digest, json, progress, save, exists } from './runner-state.mjs';

const version = 1;
const sessions = new Map();
const platformModule = module => /^(Definitions|Theorems)\.[A-Za-z_][A-Za-z0-9_]*$/.test(module);
const buildDirectories = ['lib/lean', 'ir'];
const artifactSuffix = /^(?:\.olean(?:\.(?:server|private))?|\.ilean|\.ir(?:\.sig)?|\.c|\.trace)(?:\.hash)?$/;

// A recipe covers the whole platform import closure, not just this module's
// bytes. Mathlib and the other Lake packages are pinned by the seed/manifest.
async function recipes(workspace, modules) {
  const configuration = await Promise.all(['lean-toolchain', 'lakefile.lean', 'lake-manifest.json', '.runner-workspace.json']
    .map(async file => {
      if (file === '.runner-workspace.json') {
        const marker = JSON.parse(await readFile(join(workspace, file), 'utf8'));
        return json(marker.environment);
      }
      return readFile(join(workspace, file), 'utf8');
    }));
  const environment = digest(json([version, process.platform, process.arch, ...configuration]));
  const result = new Map(), visiting = new Set();
  async function visit(module) {
    if (!platformModule(module)) throw new Error(`Unsupported compiled dependency ${module}`);
    if (result.has(module)) return result.get(module);
    if (visiting.has(module)) throw new Error(`Circular compiled dependency ${module}`);
    visiting.add(module);
    const source = await readFile(join(workspace, module.replaceAll('.', '/') + '.lean'), 'utf8');
    const dependencies = [];
    for (const child of imports(source)) {
      if (child.startsWith('Solutions.')) throw new Error('Compiled dependencies cannot import job solutions');
      dependencies.push([child, platformModule(child) ? (await visit(child)).key : null]);
    }
    const sourceHash = digest(source);
    const key = digest(json([environment, module, sourceHash, dependencies]));
    const recipe = { module, key, sourceHash };
    visiting.delete(module); result.set(module, recipe);
    return recipe;
  }
  for (const module of modules) await visit(module);
  return { environment, result };
}

async function copyArtifact(source, destination) {
  const info = await lstat(source);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Compiled cache artifact must be an ordinary file');
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination);
  await utimes(destination, info.atime, info.mtime);
}

function artifactPath(module, directory, suffix) {
  if (!buildDirectories.includes(directory) || !artifactSuffix.test(suffix)) throw new Error('Invalid compiled cache artifact path');
  return join('.lake', 'build', directory, module.replaceAll('.', '/') + suffix);
}

export async function restoreCompiledDependencies(workspace, modules, options) {
  if (!options.workspaces || !modules?.length) return;
  const recipe = await recipes(workspace, modules);
  // Short directory names leave room for long platform declarations on Windows;
  // manifests still check the complete digest before anything is restored.
  const root = join(options.workspaces, 'compiled', recipe.environment.slice(0, 16));
  // Export this fresh workspace only once, after sandbox readiness succeeds
  // and before a model has been allowed to edit its sources or build outputs.
  sessions.set(workspace, { ...recipe, root });
  let restored = 0;
  for (const entry of recipe.result.values()) {
    options.signal?.throwIfAborted();
    const folder = join(root, entry.key.slice(0, 16));
    if (!await exists(join(folder, 'manifest.json'))) continue;
    try {
      const manifest = JSON.parse(await readFile(join(folder, 'manifest.json'), 'utf8'));
      if (manifest.version !== version || manifest.key !== entry.key || manifest.module !== entry.module ||
          !Array.isArray(manifest.files) || !manifest.files.length) throw new Error('Compiled cache identity mismatch');
      const files = [];
      for (const file of manifest.files) {
        const relative = artifactPath(entry.module, file.directory, file.suffix);
        const source = join(folder, file.directory, entry.module.replaceAll('.', '/') + file.suffix);
        if (digest(await readFile(source)) !== file.hash) throw new Error('Compiled cache artifact hash mismatch');
        files.push({ source, destination: join(workspace, relative) });
      }
      if (!manifest.files.some(f => f.directory === 'lib/lean' && f.suffix === '.olean') ||
          !manifest.files.some(f => f.directory === 'lib/lean' && f.suffix === '.trace')) throw new Error('Incomplete compiled cache');
      for (const file of files) await copyArtifact(file.source, file.destination);
      restored++;
    } catch (error) {
      // Cache damage is a miss. Lake remains authoritative and rebuilds when
      // the saved traces do not match the actual source/import/toolchain inputs.
      progress(`Compiled dependency cache miss for ${entry.module}: ${error.message}`);
    }
  }
  progress(`[${options.workspaceOwner ?? 'job'}] Restored compiled platform dependencies: ${restored}/${recipe.result.size}`);
}

export async function publishCompiledDependencies(workspace, options) {
  const session = sessions.get(workspace);
  if (!session) return;
  sessions.delete(workspace);
  const current = await recipes(workspace, [...session.result.keys()]);
  if (current.environment !== session.environment || [...session.result.values()].some(e => current.result.get(e.module)?.key !== e.key)) {
    progress('Compiled dependencies changed since preparation; skipping cache export');
    return;
  }
  await mkdir(session.root, { recursive: true });
  let published = 0;
  for (const entry of session.result.values()) {
    options.signal?.throwIfAborted();
    const destination = join(session.root, entry.key.slice(0, 16));
    if (await exists(join(destination, 'manifest.json'))) continue;
    const staging = join(session.root, `.${entry.key.slice(0, 16)}.${randomUUID().slice(0, 8)}.tmp`);
    const files = [];
    try {
      for (const directory of buildDirectories) {
        const stem = join(workspace, '.lake/build', directory, entry.module.replaceAll('.', '/'));
        let names;
        try { names = await readdir(dirname(stem)); }
        catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        const basename = entry.module.split('.').at(-1);
        for (const name of names) {
          if (!name.startsWith(basename + '.')) continue;
          const suffix = name.slice(basename.length);
          if (!artifactSuffix.test(suffix)) continue;
          const source = join(dirname(stem), name);
          const bytes = await readFile(source);
          await copyArtifact(source, join(staging, directory, entry.module.replaceAll('.', '/') + suffix));
          files.push({ directory, suffix, hash: digest(bytes) });
        }
      }
      if (!files.some(f => f.directory === 'lib/lean' && f.suffix === '.olean') ||
          !files.some(f => f.directory === 'lib/lean' && f.suffix === '.trace')) continue;
      await save(join(staging, 'manifest.json'), { version, ...entry, files });
      try { await rename(staging, destination); published++; }
      catch (error) { if (!await exists(join(destination, 'manifest.json'))) throw error; }
    } finally { await rm(staging, { recursive: true, force: true }); }
  }
  progress(`[${options.workspaceOwner ?? 'job'}] Cached compiled platform dependencies: ${published}`);
}

export function forgetCompiledDependencies(workspace) { sessions.delete(workspace); }
