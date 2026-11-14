import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { replaceFile, save, readJson } from '../runner-state.mjs';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'runner-state-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const destination = join(dir, 'graph.json'), source = join(dir, 'graph.tmp');
  await save(destination, { version: 1 });
  await writeFile(source, JSON.stringify({ version: 2 }));
  return { dir, source, destination };
}

for (const code of ['EPERM', 'EBUSY', 'EACCES']) {
  test(`Windows ${code} lasting beyond the old retry window preserves the checkpoint and recovers`, async t => {
    const { source, destination } = await fixture(t);
    let elapsed = 0, calls = 0;
    await replaceFile(source, destination, {
      platform: 'win32', now: () => elapsed,
      wait: async ms => {
        assert.ok(ms > 0 && ms <= 1000);
        assert.deepEqual(JSON.parse(await readFile(destination, 'utf8')), { version: 1 });
        assert.deepEqual(JSON.parse(await readFile(source, 'utf8')), { version: 2 });
        elapsed += ms;
      },
      renameFile: async (from, to) => {
        calls++;
        assert.equal(from, source);
        assert.equal(to, destination);
        if (elapsed < 5000) throw Object.assign(new Error('sharing violation'), { code });
        await rename(from, to);
      },
    });
    assert.ok(calls > 9);
    assert.deepEqual(await readJson(destination), { version: 2 });
  });
}

test('persistent Windows lock fails after a bounded wait with the old checkpoint intact', async t => {
  const { source, destination } = await fixture(t);
  let elapsed = 0;
  const error = Object.assign(new Error('locked'), { code: 'EPERM' });
  await assert.rejects(replaceFile(source, destination, {
    platform: 'win32', now: () => elapsed,
    wait: async ms => { elapsed += ms; },
    renameFile: async () => { throw error; },
  }), e => e === error);
  assert.equal(elapsed, 30000);
  assert.deepEqual(await readJson(destination), { version: 1 });
  assert.deepEqual(JSON.parse(await readFile(source, 'utf8')), { version: 2 });
});

test('non-lock errors and non-Windows errors fail immediately', async () => {
  for (const [platform, code] of [['win32', 'ENOSPC'], ['win32', 'ENOENT'], ['linux', 'EPERM']]) {
    const error = Object.assign(new Error(code), { code });
    await assert.rejects(replaceFile('source', 'destination', {
      platform, renameFile: async () => { throw error; },
      wait: async () => assert.fail('must not retry'),
    }), e => e === error);
  }
});

test('queued saves and reads see complete records and leave no temporary files', async t => {
  const { dir, destination, source } = await fixture(t);
  await rm(source);
  const operations = [];
  for (let version = 2; version <= 12; version++) {
    operations.push(save(destination, { version }));
    operations.push(readJson(destination).then(value => assert.deepEqual(value, { version })));
  }
  await Promise.all(operations);
  assert.deepEqual(await readJson(destination), { version: 12 });
  assert.deepEqual(await readdir(dir), ['graph.json']);
});

test('save recovers from a real Windows reader holding the destination open', {
  skip: process.platform !== 'win32', timeout: 15000,
}, async t => {
  const { dir, source, destination } = await fixture(t);
  await rm(source);
  // FileShare.ReadWrite permits other readers but denies deletion/replacement.
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '$f = [System.IO.File]::Open($env:RUNNER_STATE_LOCK_TEST_PATH, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite); try { [Console]::WriteLine("locked"); [Console]::In.ReadLine() | Out-Null } finally { $f.Dispose() }'],
  { env: { ...process.env, RUNNER_STATE_LOCK_TEST_PATH: destination }, windowsHide: true });
  t.after(() => { child.stdin.end(); child.kill(); });
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => reject(new Error(`Lock helper exited early: ${code}`)));
    child.stdout.once('data', () => resolve());
  });
  let committed = false;
  const pending = save(destination, { version: 2 }).then(() => { committed = true; });
  const release = setTimeout(() => child.stdin.end('\n'), 2200);
  t.after(() => clearTimeout(release));
  await new Promise(resolve => setTimeout(resolve, 1700));
  assert.equal(committed, false);
  assert.deepEqual(JSON.parse(await readFile(destination, 'utf8')), { version: 1 });
  await pending;
  assert.deepEqual(await readJson(destination), { version: 2 });
  assert.deepEqual(await readdir(dir), ['graph.json']);
});
