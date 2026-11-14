import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, open, rename, rm, writeFile, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const digest = text => createHash('sha256').update(text).digest('hex');
export const targetFingerprint = target => digest(json([target.theorem_name, target.formal_statement, target.preamble ?? '', target.mathlib_rev]));
export const idOf = row => row.theorem_id ?? row.definition_id ?? row.id;
export const enc = encodeURIComponent;
export const json = value => JSON.stringify(value, null, 2) + '\n';
// Generated prose can contain escaped NULs, which text-backed APIs cannot store.
export const cleanExplanation = text => typeof text === 'string' ? text.replaceAll('\0', ' ') : text;
export const progress = message => console.log(`[${new Date().toISOString()}] ${message}`);
// Read a bounded tail, even when a long-running compiler has a very large log.
export async function latestLogOutput(path) {
  let handle;
  try {
    handle = await open(path, 'r');
    const { size } = await handle.stat();
    const buffer = Buffer.alloc(Math.min(size, 4096));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, Math.max(0, size - buffer.length));
    return buffer.subarray(0, bytesRead).toString('utf8').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
      .split(/\r?\n/).map(line => line.trim()).filter(Boolean).at(-1)?.slice(0, 300);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  finally { await handle?.close(); }
}
export async function exists(path) { try { await access(path); return true; } catch { return false; } }
// Preserve mtimes and Lake's incremental build output when live readback has
// confirmed that the source bytes are unchanged.
export async function writeIfChanged(path, content) {
  try { if (await readFile(path, 'utf8') === content) return false; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await writeFile(path, content, 'utf8');
  return true;
}
const writes = new Map();
const recordListeners = new Set();
// Durable-write notifications maintain the runner's optional in-memory index.
export function onRecordSaved(listener) {
  recordListeners.add(listener);
  return () => recordListeners.delete(listener);
}
// Sharing violations can outlast a short burst of retries (for example while
// another process reads a large graph). Keep the same complete temporary file
// and use a bounded backoff, without deleting or rewriting the committed file.
export async function replaceFile(source, destination, {
  renameFile = rename, wait = sleep, now = () => performance.now(), platform = process.platform,
} = {}) {
  const deadline = now() + 30000;
  for (let retry = 0; ; retry++) {
    try { await renameFile(source, destination); return; }
    catch (error) {
      const remaining = deadline - now();
      if (platform !== 'win32' || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || remaining <= 0) throw error;
      await wait(Math.min(25 * 2 ** Math.min(retry, 6), 1000, remaining));
    }
  }
}

function fileAction(path, action) {
  path = resolve(path);
  const result = (writes.get(path) ?? Promise.resolve()).then(action);
  const settled = result.catch(() => {});
  writes.set(path, settled);
  void settled.then(() => { if (writes.get(path) === settled) writes.delete(path); });
  return result;
}
export function readJson(path) {
  return fileAction(path, async () => {
    try { return JSON.parse(await readFile(path, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  });
}
// Serialize replacements of the same file; callers still own read/modify/write
// transactions (the job store supplies the cross-record serialized writer).
export function save(path, value) {
  path = resolve(path);
  const bytes = json(value);
  return fileAction(path, async () => {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, bytes, { flag: 'wx' });
      await replaceFile(temporary, path);
      for (const listener of recordListeners) listener(path, bytes);
    } finally { await rm(temporary, { force: true }); }
  });
}
