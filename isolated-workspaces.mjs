import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { cp, lstat, mkdir, readFile, readdir, rename, rm, utimes } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { digest, exists, json, progress, save } from './runner-state.mjs';
import { withSetupSlot, boundedResource } from './shared-resources.mjs';
import { forgetCompiledDependencies } from './compiled-dependencies.mjs';
import { verificationMode } from './verification-mode.mjs';
import defaults from './runner-config.json' with { type: 'json' };

export const WORKSPACE_VERSION = 2;
const POOL_VERSION = 1;
const leases = new Map();
const inventoryFile = '.runner-package-inventory.json';
export function environmentIdentity(environment, options, configuration) {
  return { toolchain: environment.toolchain, mathlib_rev: environment.mathlib_rev,
    workspace_version: WORKSPACE_VERSION, configuration_hash: digest(configuration),
    api_version: options.apiVersion ?? null, verification_mode: verificationMode(options) };
}

// Cleanup only descendants of our staging/slot roots, never a legacy tree.
async function removeStaging(root, path) {
  const suffix = relative(resolve(root), resolve(path));
  if (!suffix || suffix.startsWith('..') || isAbsolute(suffix)) throw new Error('Unsafe workspace cleanup path');
  await rm(path, { recursive: true, force: true });
}

export async function copyEnvironment(source, destination, { label, excludePackages = false } = {}) {
  const startedAt = Date.now();
  let files = 0;
  if (label) progress(`${label}: copying the full Lean/Mathlib environment into a private workspace; this can take several minutes`);
  const heartbeat = label ? setInterval(() => progress(`${label}: workspace copy running (${Math.round((Date.now() - startedAt) / 1000)}s elapsed, ${files} files processed)`), 30000) : null;
  try {
    await cp(source, destination, { recursive: true, force: false, errorOnExist: !excludePackages, preserveTimestamps: true,
      // No hard links/junctions/symlinks or Git metadata with outside references.
      filter: async path => {
        if (path === join(source, '.git') || ['.runner-seed.json', inventoryFile].includes(basename(path)) ||
            excludePackages && path === join(source, '.lake', 'packages')) return false;
        const info = await lstat(path);
        if (info.isSymbolicLink()) throw new Error(`Linked environment path is not isolated: ${path}`);
        // Lake checks dependency revisions/URLs during builds, so retain their
        // independent Git directories. Reject worktree pointers/object sharing.
        if (basename(path) === '.git' && !info.isDirectory()) throw new Error(`Linked Git metadata is not isolated: ${path}`);
        if (path.endsWith(join('.git', 'objects', 'info', 'alternates')) && (await readFile(path, 'utf8')).trim())
          throw new Error(`Shared Git objects are not isolated: ${path}`);
        if (info.isFile()) files++;
        return true;
      } });
    if (label) progress(`${label}: private workspace copy completed (${Math.round((Date.now() - startedAt) / 1000)}s elapsed)`);
  } finally { clearInterval(heartbeat); }
}

async function ownedWorkspace(workspace, options) {
  const root = resolve(options.workspaces, 'jobs');
  await ordinaryDirectory(root);
  const name = relative(root, resolve(workspace));
  if (!/^[0-9a-f]{16}$/.test(name)) throw new Error('Unsafe workspace release path');
  await ordinaryDirectory(workspace);
  const info = await lstat(join(workspace, '.runner-workspace.json'));
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error('Unsafe workspace ownership marker');
  const marker = JSON.parse(await readFile(join(workspace, '.runner-workspace.json'), 'utf8'));
  if (marker.workspace_id?.replaceAll('-', '').slice(0, 16) !== name) throw new Error('Workspace ownership mismatch');
  return { root, marker };
}

export async function releaseWorkspace(workspace, options) {
  workspace = resolve(workspace);
  const { root, marker } = await ownedWorkspace(workspace, options);
  forgetCompiledDependencies(workspace);
  if (leases.has(workspace) && json(leases.get(workspace)) !== json(marker)) throw new Error('Workspace lease ownership mismatch');
  if (marker.pool_version !== POOL_VERSION) {
    await removeStaging(root, workspace);
    return;
  }
  if (json(leases.get(workspace)) !== json(marker)) throw new Error('Workspace lease ownership mismatch');
  // Cleanup is deferred until acquisition. A crash during cleanup leaves the
  // slot unavailable until another complete reset, never partially ready.
  await save(join(workspace, '.runner-workspace.json'), { ...marker, state: 'available', owner: null, lease_id: null });
  leases.delete(workspace);
}

async function ordinaryDirectory(path, { optional = false } = {}) {
  let info;
  try { info = await lstat(path); }
  catch (error) { if (optional && error.code === 'ENOENT') return false; throw error; }
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Linked or invalid workspace directory: ${path}`);
  return true;
}

async function hashFile(path, signal) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) {
    signal?.throwIfAborted();
    hash.update(chunk);
  }
  return hash.digest('hex');
}

// Verify actual bytes, including compiled output. Metadata alone would miss a
// changed file whose size/timestamp was preserved. Never traverse a junction.
async function packageInventory(root, signal) {
  const entries = [], directories = [''];
  const metadataSlot = boundedResource(16);
  if (!await ordinaryDirectory(root, { optional: true })) return entries;
  for (let index = 0; index < directories.length; index++) {
    signal?.throwIfAborted();
    const directory = directories[index];
    await ordinaryDirectory(join(root, directory));
    const inspected = await Promise.allSettled((await readdir(join(root, directory), { withFileTypes: true })).map(row => metadataSlot(async () => {
      const path = join(directory, row.name);
      if (row.isDirectory() && !row.isSymbolicLink()) {
        directories.push(path); entries.push({ path, directory: true });
      } else {
        const info = await lstat(join(root, path));
        if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error(`Linked or invalid package file: ${path}`);
        // fs.cp(preserveTimestamps) uses Date precision. Match that precision
        // so verification does not perturb unchanged Lake cache timestamps.
        entries.push({ path, size: info.size, mtime: info.mtime.getTime() });
      }
    })));
    const failed = inspected.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
  }
  let next = 0, failed = false;
  const results = await Promise.allSettled(Array.from({ length: 8 }, async () => {
    try {
      while (!failed && next < entries.length) {
        signal?.throwIfAborted();
        const entry = entries[next++];
        if (!entry.directory) entry.hash = await hashFile(join(root, entry.path), signal);
      }
    } catch (error) { failed = true; throw error; }
  }));
  const failure = results.find(result => result.status === 'rejected');
  if (failure) throw failure.reason;
  return entries;
}

async function resetWorkspace(source, workspace, inventory, signal) {
  const packages = join(workspace, '.lake', 'packages');
  await ordinaryDirectory(join(workspace, '.lake'), { optional: true });
  const actual = new Map((await packageInventory(packages, signal)).map(entry => [entry.path, entry]));
  const expected = new Map(inventory.map(entry => [entry.path, entry]));
  for (const entry of actual.values()) {
    signal?.throwIfAborted();
    if (!expected.has(entry.path) || !!expected.get(entry.path).directory !== !!entry.directory) {
      await removeStaging(packages, join(packages, entry.path));
      actual.delete(entry.path);
    }
  }
  await mkdir(packages, { recursive: true });
  for (const entry of inventory) {
    signal?.throwIfAborted();
    const destination = join(packages, entry.path), previous = actual.get(entry.path);
    if (entry.directory) { if (!previous?.directory) await mkdir(destination, { recursive: true }); }
    else if (previous?.hash !== entry.hash) {
      await cp(join(source, '.lake', 'packages', entry.path), destination, { preserveTimestamps: true });
    } else if (previous.mtime !== entry.mtime) {
      await utimes(destination, entry.mtime / 1000, entry.mtime / 1000);
    }
  }
  // Everything outside packages is small and job-specific. Restore it exactly
  // from the seed, including root build traces, instructions and Lake pins.
  for (const row of await readdir(workspace)) {
    if (!['.lake', '.runner-workspace.json'].includes(row)) await removeStaging(workspace, join(workspace, row));
  }
  for (const row of await readdir(join(workspace, '.lake'))) {
    if (row !== 'packages') await removeStaging(workspace, join(workspace, '.lake', row));
  }
  await copyEnvironment(source, workspace, { excludePackages: true });
  forgetCompiledDependencies(workspace);
}

// A seed is published only after initialization and its smoke build complete.
// Slots are ordinary independent copies; only sequential jobs reuse a slot.
export function createWorkspaceManager(initialize) {
  const initializing = new Map();
  const inventories = new Map();
  async function seed(environment, options, identity) {
    // Short names leave room for deeply nested Mathlib paths on Windows.
    // The complete identity in the marker detects any truncated-hash collision.
    const root = join(options.workspaces, 'seeds'), key = digest(json(identity)).slice(0, 16);
    const path = join(root, key), marker = join(path, '.runner-seed.json');
    if (initializing.has(path)) return initializing.get(path);
    const action = withSetupSlot(async () => {
      if (await exists(marker)) {
        if (json(JSON.parse(await readFile(marker, 'utf8'))) !== json(identity)) throw new Error('Environment seed identity mismatch');
        return path;
      }
      if (await exists(path)) throw new Error(`Incomplete environment seed: ${path}`);
      await mkdir(root, { recursive: true });
      const staging = join(root, `.${key}.${randomUUID().slice(0, 8)}.tmp`);
      try {
        await initialize(staging, environment, options);
        await save(join(staging, '.runner-seed.json'), identity);
        await rename(staging, path);
        return path;
      } finally { await removeStaging(root, staging); }
    }, `Lean environment seed ${key}`);
    initializing.set(path, action);
    try { return await action; }
    finally { if (initializing.get(path) === action) initializing.delete(path); }
  }
  return async (environment, options, identity) => {
    options.signal?.throwIfAborted();
    const capacity = options.pipeline?.maxActiveJobs ?? defaults.maxActiveJobs;
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error('Workspace pool capacity must be a positive integer');
    const source = await seed(environment, options, identity);
    const label = `[${options.workspaceOwner ?? 'job'}] Workspace preparation`;
    const allocation = await withSetupSlot(async () => {
      options.signal?.throwIfAborted();
      const root = resolve(options.workspaces, 'jobs');
      await mkdir(root, { recursive: true });
      await ordinaryDirectory(root);
      let slots = 0, busy = 0, selected;
      const observed = new Set();
      for (const row of await readdir(root, { withFileTypes: true })) {
        if (!/^[0-9a-f]{16}$/.test(row.name)) continue;
        const path = join(root, row.name);
        let marker;
        try { ({ marker } = await ownedWorkspace(path, options)); }
        catch { continue; } // Unmarked/legacy/damaged paths are never adopted.
        if (marker.pool_version !== POOL_VERSION || json(marker.environment) !== json(identity)) continue;
        observed.add(path);
        slots++;
        if (leases.has(path)) busy++;
        else if (!selected) selected = { path, marker };
      }
      for (const [path, marker] of leases) {
        if (relative(root, path).startsWith('..') || json(marker.environment) !== json(identity) || observed.has(path)) continue;
        slots++; busy++;
      }
      if (busy >= capacity) throw new Error(`Workspace pool capacity (${capacity}) is exhausted by leased slots`);
      // Reserve ownership while serialized; expensive verification/copying is
      // private to this slot and runs after releasing the allocation permit.
      if (!selected && slots >= capacity) throw new Error(`Workspace pool capacity (${capacity}) is exhausted by leased slots`);
      const workspaceId = randomUUID();
      const path = selected?.path ?? join(root, workspaceId.replaceAll('-', '').slice(0, 16));
      const marker = selected?.marker ?? { workspace_id: workspaceId, pool_version: POOL_VERSION, environment: identity };
      const leased = { ...marker, state: 'leased', owner: options.workspaceOwner ?? null, lease_id: randomUUID() };
      leases.set(path, leased);
      return { root, path, leased, reused: !!selected };
    }, label);
    const { root, reused } = allocation;
    let { path, leased } = allocation;
    try {
      let copyFresh = !reused;
      if (reused) {
        await save(join(path, '.runner-workspace.json'), { ...leased, state: 'resetting' });
        const startedAt = Date.now();
        progress(`${label}: resetting reusable workspace ${basename(path)} and verifying dependency contents`);
        const heartbeat = setInterval(() => progress(`${label}: workspace reset running (${Math.round((Date.now() - startedAt) / 1000)}s elapsed)`), 30000);
        try {
          if (!inventories.has(source)) {
            const inventoryPath = join(source, inventoryFile);
            let inventory;
            if (await exists(inventoryPath)) {
              const saved = JSON.parse(await readFile(inventoryPath, 'utf8'));
              if (saved.pool_version !== POOL_VERSION || json(saved.environment) !== json(identity)) throw new Error('Package inventory identity mismatch');
              inventory = saved.entries;
            } else {
              inventory = await packageInventory(join(source, '.lake', 'packages'), options.signal);
              await save(inventoryPath, { pool_version: POOL_VERSION, environment: identity, entries: inventory });
            }
            // Inventory paths come from a trusted seed, but never let damaged
            // persisted metadata direct a reset outside the package directory.
            const packageRoot = resolve(source, '.lake', 'packages');
            if (!Array.isArray(inventory) || inventory.some(entry => {
              if (!entry || typeof entry.path !== 'string' || !entry.path || isAbsolute(entry.path) ||
                  entry.path.split(/[\\/]/).includes('..') || process.platform === 'win32' && entry.path.includes(':')) return true;
              const suffix = relative(packageRoot, resolve(packageRoot, entry.path));
              return !suffix || suffix.startsWith('..') || isAbsolute(suffix) ||
                !entry.directory && (!/^[a-f0-9]{64}$/.test(entry.hash) || !Number.isFinite(entry.mtime));
            })) throw new Error('Invalid package inventory');
            inventories.set(source, inventory);
          }
          await resetWorkspace(source, path, inventories.get(source), options.signal);
          options.signal?.throwIfAborted();
          await save(join(path, '.runner-workspace.json'), leased);
          leases.set(path, leased);
          progress(`${label}: reused workspace ${basename(path)} (${Math.round((Date.now() - startedAt) / 1000)}s elapsed; full copy avoided)`);
          return path;
        } catch (error) {
          options.signal?.throwIfAborted();
          // Linked/invalid dependency trees cannot be inspected safely. Drop
          // this owned slot and create a clean independent copy instead.
          if (!/Linked or invalid/.test(error.message)) throw error;
          progress(`${label}: discarding unsafe reusable workspace: ${error.message}`);
          await removeStaging(root, path);
          await withSetupSlot(async () => {
            leases.delete(path);
            const workspaceId = randomUUID();
            path = join(root, workspaceId.replaceAll('-', '').slice(0, 16));
            leased = { ...leased, workspace_id: workspaceId };
            leases.set(path, leased);
          });
          copyFresh = true;
        } finally { clearInterval(heartbeat); }
      }
      if (!copyFresh) throw new Error('Workspace preparation did not complete');
      const staging = join(root, `.${basename(path)}.${randomUUID().slice(0, 8)}.tmp`);
      try {
        await copyEnvironment(source, staging, { label });
        options.signal?.throwIfAborted();
        await save(join(staging, '.runner-workspace.json'), leased);
        await rename(staging, path);
        leases.set(path, leased);
        return path;
      } finally { await removeStaging(root, staging); }
    } catch (error) {
      leases.delete(path);
      throw error;
    }
  };
}
