import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireRunnerLock, command } from '../prove2me.mjs';
import { Pipeline } from '../pipeline.mjs';

const runner = new URL('../prove2me.mjs', import.meta.url).href;
const pause = () => new Promise(resolve => setTimeout(resolve, 50));
async function temporary(t) {
  const dir = await mkdtemp(join(tmpdir(), 'prove2me-lock-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

test('runner lock excludes another run and releases without leaking signal handlers', async t => {
  const path = join(await temporary(t), 'runner.lock');
  const signals = ['SIGINT', 'SIGTERM', 'exit'];
  const counts = signals.map(signal => process.listenerCount(signal));
  const release = acquireRunnerLock(path);
  try {
    assert.equal(await readFile(path, 'utf8'), String(process.pid));
    assert.throws(() => acquireRunnerLock(path), /Another run owns/);
    assert.equal(await readFile(path, 'utf8'), String(process.pid));
  } finally { release(); }
  release();
  assert.deepEqual(signals.map(signal => process.listenerCount(signal)), counts);
  assert.throws(() => acquireRunnerLock(join(path, 'missing')), { code: 'ENOENT' });
  const again = acquireRunnerLock(path); again();
  await assert.rejects(access(path), { code: 'ENOENT' });
});

test('interruption kills active command descendants before releasing the lock', { timeout: 20000 }, async t => {
  const dir = await temporary(t), path = join(dir, 'runner.lock'), log = join(dir, 'child.log');
  const worker = `
    const { spawn } = require('node:child_process');
    const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
    console.log(JSON.stringify([process.pid, grandchild.pid]));
    setInterval(() => {}, 1000);
  `;
  const script = `
    import { acquireRunnerLock, command } from ${JSON.stringify(runner)};
    acquireRunnerLock(${JSON.stringify(path)});
    process.stdin.on('data', () => process.emit('SIGINT'));
    await command(process.execPath, ['-e', ${JSON.stringify(worker)}], {
      cwd: ${JSON.stringify(dir)}, log: ${JSON.stringify(log)}, quiet: true
    });
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const closed = once(child, 'close');
  let stderr = ''; child.stderr.on('data', data => { stderr += data; });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
  let pids;
  for (let i = 0; i < 100; i++) {
    try { pids = JSON.parse(await readFile(log, 'utf8')); break; }
    catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    await pause();
  }
  assert.ok(pids, `command did not start: ${stderr}`);
  t.after(() => { for (const pid of pids) { try { process.kill(pid); } catch {} } });
  pids.forEach(pid => assert.equal(alive(pid), true));
  // Windows child.kill('SIGINT') force-kills rather than delivering a console
  // event. Emit the same Node event there; use the OS signal on POSIX.
  if (process.platform === 'win32') child.stdin.write('interrupt');
  else child.kill('SIGINT');
  const [code] = await closed;
  assert.equal(code, 130, stderr);
  await assert.rejects(access(path), { code: 'ENOENT' }, stderr);
  for (let i = 0; i < 60 && pids.some(alive); i++) await pause();
  pids.forEach(pid => assert.equal(alive(pid), false, `child ${pid} survived interruption`));
  const release = acquireRunnerLock(path); release();
});

test('SIGTERM and explicit exit release the lock', { timeout: 10000 }, async t => {
  for (const action of ["process.emit('SIGTERM')", 'process.exit(7)']) {
    const path = join(await temporary(t), 'runner.lock');
    const script = `
      import { acquireRunnerLock } from ${JSON.stringify(runner)};
      acquireRunnerLock(${JSON.stringify(path)});
      ${action};
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: 'ignore', windowsHide: true });
    const [code] = await once(child, 'close');
    assert.equal(code, action.includes('SIGTERM') ? 143 : 7);
    await assert.rejects(access(path), { code: 'ENOENT' });
  }
});

test('cancelling one job kills its process tree and leaves another job running', { timeout: 20000 }, async t => {
  const dir = await temporary(t), controllers = [new AbortController(), new AbortController()];
  const worker = `
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
    console.log(JSON.stringify([process.pid, child.pid]));
    setInterval(() => {}, 1000);
  `;
  const logs = [join(dir, 'a.log'), join(dir, 'b.log')];
  const commands = controllers.map((controller, index) => command(process.execPath, ['-e', worker], {
    cwd: dir, log: logs[index], quiet: true, signal: controller.signal,
  }));
  // Attach rejection handlers before aborting to avoid unhandled rejections.
  const stopped = commands.map(promise => assert.rejects(promise, /job cancelled/));
  const trees = [];
  t.after(async () => {
    controllers.forEach(controller => controller.abort(new Error('job cancelled')));
    await Promise.allSettled(stopped);
    for (const pid of trees.flat()) { try { process.kill(pid); } catch {} }
  });
  for (const log of logs) {
    let pids;
    for (let i = 0; i < 100; i++) {
      try { pids = JSON.parse(await readFile(log, 'utf8')); break; }
      catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
      await pause();
    }
    assert.ok(pids, 'job did not start'); trees.push(pids);
  }
  controllers[0].abort(new Error('job cancelled'));
  await stopped[0];
  for (let i = 0; i < 60 && trees[0].some(alive); i++) await pause();
  trees[0].forEach(pid => assert.equal(alive(pid), false, `cancelled job process ${pid} survived`));
  trees[1].forEach(pid => assert.equal(alive(pid), true, `unrelated job process ${pid} was killed`));
  controllers[1].abort(new Error('job cancelled')); await stopped[1];
});

test('stop agents kills all agent process trees while a validation process stays alive', { timeout: 20000 }, async t => {
  const dir = await temporary(t), validation = new AbortController();
  const pipeline = new Pipeline({}, { root: 'root' }, { runs: dir });
  const worker = `
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
    console.log(JSON.stringify([process.pid, child.pid]));
    setInterval(() => {}, 1000);
  `;
  const logs = ['proof', 'research', 'validation'].map(name => join(dir, `${name}.log`));
  const run = (index, signal) => command(process.execPath, ['-e', worker], { cwd: dir, log: logs[index], quiet: true, signal });
  const agents = [0, 1].map(index => pipeline.invokeAgent(signal => run(index, signal), pipeline.signal));
  const stopped = agents.map(promise => assert.rejects(promise, /Agents stopped by operator/));
  const validating = assert.rejects(run(2, validation.signal), /validation cleanup/);
  const trees = [];
  const cleanup = async () => {
    validation.abort(new Error('validation cleanup')); pipeline.controller.abort(new Error('cleanup'));
    await Promise.allSettled([...stopped, validating]);
    for (const pid of trees.flat()) { try { process.kill(pid); } catch {} }
  };
  try {
    for (const log of logs) {
      for (let i = 0; i < 100; i++) {
        try { trees.push(JSON.parse(await readFile(log, 'utf8'))); break; }
        catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
        await pause();
      }
    }
    assert.equal(trees.length, 3);
    await pipeline.operator.execute({ id: 'stop-agents', action: 'stop-agents', runId: pipeline.runId, revision: 0 });
    await Promise.all(stopped);
    for (let i = 0; i < 60 && trees.slice(0, 2).flat().some(alive); i++) await pause();
    trees.slice(0, 2).flat().forEach(pid => assert.equal(alive(pid), false, `agent process ${pid} survived`));
    trees[2].forEach(pid => assert.equal(alive(pid), true, `validation process ${pid} was killed`));
    assert.equal(pipeline.signal.aborted, false);
  } finally { await cleanup(); }
});
