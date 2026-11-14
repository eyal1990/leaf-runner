import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest, save } from './runner-state.mjs';
import { pipelineLimits } from './pipeline-config.mjs';

export const DEFAULT_CONFIG_PATH = fileURLToPath(new URL('./runner-config.json', import.meta.url));
const writers = new Map();

export async function readRunnerConfig(path = DEFAULT_CONFIG_PATH) {
  path = resolve(path);
  let raw, source;
  try { source = await readFile(path, 'utf8'); raw = JSON.parse(source); }
  catch (error) { throw new Error(`Cannot load pipeline configuration ${path}: ${error.message}`); }
  return { path, raw, values: pipelineLimits(raw), revision: digest(source) };
}

// Keep fields outside the dialog, including comments and custom queue casing.
function mergeConfig(raw, patch) {
  const next = { ...raw, ...patch };
  for (const key of ['recovery', 'incompleteEscalation']) {
    if (patch[key]) next[key] = { ...raw[key], ...patch[key] };
  }
  if (patch.queues) {
    next.queues = structuredClone(raw.queues ?? {});
    for (const [stage, queue] of Object.entries(patch.queues)) {
      const key = Object.keys(next.queues).find(key => key.toUpperCase() === stage.toUpperCase()) ?? stage.toLowerCase();
      next.queues[key] = { ...next.queues[key], ...queue };
    }
  }
  return next;
}

export function updateRunnerConfig(path = DEFAULT_CONFIG_PATH, patch, { revision } = {}) {
  path = resolve(path);
  const operation = (writers.get(path) ?? Promise.resolve()).then(async () => {
    const current = await readRunnerConfig(path);
    if (revision !== undefined && revision !== current.revision) throw new Error('Configuration file changed. Refresh settings before saving.');
    // Validate before merging, which could otherwise hide duplicate queues.
    pipelineLimits(patch, current.values);
    const next = mergeConfig(current.raw, patch);
    pipelineLimits(next);
    await save(path, next);
    return readRunnerConfig(path);
  });
  const settled = operation.catch(() => {});
  writers.set(path, settled);
  void settled.then(() => { if (writers.get(path) === settled) writers.delete(path); });
  return operation;
}

