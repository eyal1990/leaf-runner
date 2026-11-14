import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexSandboxRecovery } from '../codex-sandbox-recovery.mjs';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'prove2me-sandbox-recovery-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let clock = 100000;
  const recovery = new CodexSandboxRecovery({ now: () => clock }), probes = [];
  const options = { codex: 'codex', runs: dir, pipeline: { windowsSandboxRecovery: 'allow-unelevated' } };
  const args = { dir, options, mode: 'elevated', output: 'helper_unknown_error: setup refresh had errors',
    probe: async (...args) => { assert.equal(recovery.mode(options), undefined); probes.push(args); } };
  return { dir, recovery, args, probes, advance: () => { clock += 60000; } };
}

test('enabled fallback commits only after readiness and records its sandbox mode', async t => {
  const h = await fixture(t);
  assert.equal(await h.recovery.recover(h.args), true);
  assert.equal(h.probes.length, 1); assert.equal(h.probes[0][2], 'unelevated');
  assert.equal(h.recovery.mode({ ...h.args.options }), 'unelevated');
  assert.equal(h.recovery.mode({ ...h.args.options, windowsSandboxRecovery: 'protected' }), undefined);
  assert.equal(h.recovery.mode({ codex: 'other.exe' }), undefined);
  const saved = JSON.parse(await readFile(join(h.dir, 'codex-sandbox-recovery.json')));
  assert.equal(saved.status, 'RECOVERED'); assert.equal(saved.sandbox_mode, 'unelevated');
  assert.match(saved.reason, /weaker network isolation/);
});

test('failed recovery retains the protected mode, throttles probes, and retries later', async t => {
  const h = await fixture(t); let calls = 0;
  h.args.probe = async () => { calls++; throw new Error('probe failed'); };
  assert.equal(await h.recovery.recover(h.args), false);
  assert.equal(h.recovery.mode(h.args.options), undefined);
  assert.equal(JSON.parse(await readFile(join(h.dir, 'codex-sandbox-recovery.json'))).status, 'WAITING');
  assert.equal(await h.recovery.recover(h.args), false); assert.equal(calls, 1);
  h.advance(); h.args.probe = async () => {};
  assert.equal(await h.recovery.recover(h.args), true);
});

test('protected policy, explicit sandbox pins and unrelated errors never downgrade', async t => {
  for (const scenario of ['protected', 'explicit-elevated', 'explicit-mxc', 'unrelated', 'already-unelevated']) {
    const h = await fixture(t);
    if (scenario === 'protected') h.args.options.pipeline.windowsSandboxRecovery = 'protected';
    if (scenario.startsWith('explicit')) h.args.options['windows-sandbox'] = scenario.slice(9);
    if (scenario === 'unrelated') h.args.output = 'Lean import failed';
    if (scenario === 'already-unelevated') h.args.mode = 'unelevated';
    assert.equal(await h.recovery.recover(h.args), false, scenario);
    assert.deepEqual(h.probes, []); assert.equal(h.recovery.mode(h.args.options), undefined);
  }
});

test('cancellation during recovery propagates and never commits a fallback', async t => {
  const h = await fixture(t), controller = new AbortController(), reason = new Error('stop recovery');
  h.args.options.signal = controller.signal;
  h.args.probe = async () => { controller.abort(reason); throw reason; };
  await assert.rejects(h.recovery.recover(h.args), error => error === reason);
  assert.equal(h.recovery.mode(h.args.options), undefined);
});
