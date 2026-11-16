import { readFile, mkdir, writeFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { replaceFile } from './runner-state.mjs';

export const DEFAULT_CREDENTIALS_PATH = join(dirname(fileURLToPath(import.meta.url)), 'credentials.json');
const validKey = key => typeof key === 'string' && !!key.trim() && key.trim() !== 'YOUR_PROVE2ME_API_KEY'
  && key.length <= 4096 && !/\s/.test(key.trim());

export async function credentialStatus(path = DEFAULT_CREDENTIALS_PATH, env = process.env) {
  if (env.PROVE2ME_API_KEY) return { configured: validKey(env.PROVE2ME_API_KEY), source: 'environment', editable: false };
  try {
    const { api_key: key } = JSON.parse(await readFile(path, 'utf8')) ?? {};
    return { configured: validKey(key), source: 'file', editable: true };
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return { configured: false, source: 'file', editable: true };
    throw new Error('Cannot read Prove2.me credentials. Check local file permissions.');
  }
}

export async function loadApiKey(path = DEFAULT_CREDENTIALS_PATH, env = process.env) {
  const status = await credentialStatus(path, env);
  if (!status.configured) throw new Error('Prove2.me API key required. Open Mission Control and choose API key, or set PROVE2ME_API_KEY for headless use. Get your key from the prove2.me account menu > API key.');
  return status.source === 'environment' ? env.PROVE2ME_API_KEY.trim() : JSON.parse(await readFile(path, 'utf8')).api_key.trim();
}

export async function saveApiKey(path, key) {
  if (!validKey(key)) throw new Error('Enter a Prove2.me API key without spaces.');
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(temporary, JSON.stringify({ api_key: key.trim() }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await replaceFile(temporary, path);
  } catch {
    throw new Error('Could not save Prove2.me credentials. Check local file permissions and try again.');
  } finally { await rm(temporary, { force: true }).catch(() => {}); }
}
