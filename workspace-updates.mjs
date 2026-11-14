import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { progress, save } from './runner-state.mjs';

export function compatibleWorkspaceVersion(documentation, platform) {
  if (!documentation || !platform) return false;
  if (documentation === platform) return true;
  // Release metadata can lag a deployed patch. Do not infer compatibility
  // across minor releases (including 0.x), majors, or prereleases.
  const release = value => /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
  const docs = release(documentation), api = release(platform);
  return !!docs && !!api && docs[1] === api[1] && docs[2] === api[2];
}

// The workspace manager coalesces seed initialization across jobs. Keep the
// same staging directory while awaiting an upgrade, rather than failing every
// job and repeatedly cloning/deleting the repository. No model attempt starts
// until this finishes. Existing server work can continue independently.
export async function updateWorkspaceDocumentation(workspace, options, { command, wait = delay, report = progress } = {}) {
  options.signal?.throwIfAborted();
  let platform = options.getApiVersion?.() ?? options.apiVersion;
  if (!platform) return;
  const interval = (options.refreshInterval ?? 30) * 1000;
  const statePath = join(options.runs, 'workspace-upgrade.json');
  const version = async () => {
    try {
      const source = await readFile(join(workspace, 'SKILL.md'), 'utf8');
      const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source)?.[1];
      return frontmatter?.match(/^\s+version:\s*["']?([\w.+-]+)["']?\s*$/m)?.[1] ?? null;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  };
  let documentation = await version();
  if (documentation === platform) {
    await save(statePath, { status: 'CURRENT', platform_version: platform,
      documentation_version: documentation, updated_at: new Date().toISOString() });
    return;
  }
  for (;;) {
    options.signal?.throwIfAborted();
    platform = options.getApiVersion?.() ?? options.apiVersion;
    let error;
    report(`Updating workspace documentation (platform ${platform}, documentation ${documentation ?? 'unknown'})`);
    await save(statePath, { status: 'UPDATING', platform_version: platform,
      documentation_version: documentation, updated_at: new Date().toISOString() });
    try {
      await command('git', ['pull', '--ff-only', '--tags', 'origin', 'main'], {
        cwd: workspace, log: join(options.runs, 'workspace-upgrade.log'), signal: options.signal,
        label: 'Workspace documentation upgrade',
      });
      options.signal?.throwIfAborted();
      documentation = await version();
    } catch (failure) {
      options.signal?.throwIfAborted();
      error = failure.message;
    }
    if (!error && compatibleWorkspaceVersion(documentation, platform)) {
      const exact = documentation === platform;
      await save(statePath, { status: exact ? 'CURRENT' : 'PATCH_COMPATIBLE',
        platform_version: platform, documentation_version: documentation, updated_at: new Date().toISOString() });
      report(exact ? `Workspace documentation upgraded to ${documentation}; continuing`
        : `Latest workspace documentation is ${documentation}; platform ${platform} differs only by patch version; continuing with server verification`);
      return;
    }
    await save(statePath, { status: 'WAITING', platform_version: platform,
      documentation_version: documentation, error: error ?? null,
      next_check_at: new Date(Date.now() + interval).toISOString(), updated_at: new Date().toISOString() });
    report(`Waiting for workspace upgrade${error ? `: ${error}` : ` to match platform ${platform}`}; retrying in ${interval / 1000}s without consuming a proof attempt`);
    await wait(interval, undefined, { signal: options.signal });
  }
}
