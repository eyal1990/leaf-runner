import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApiRecovery } from '../api-recovery.mjs';
import { Client } from '../prove2me.mjs';
import { ApiError } from '../api-errors.mjs';
import { createRemoteActions, publishArtifacts } from '../remote-actions.mjs';
import { digest, targetFingerprint, save } from '../runner-state.mjs';
import { recoveryPolicy, rememberFailure } from '../recovery-policy.mjs';
import { selectable } from '../work-policy.mjs';
import { ProofStorageRecovery, proofStorageFailure } from '../proof-storage-recovery.mjs';

const storageError = (message = 'Gateway Timeout') => ({ status: 'ERROR',
  error_message: `Could not enqueue the submission: could not store the proof file: ${message}. Retry unchanged.` });

async function fixture(t) {
  t.mock.method(console, 'log', () => {});
  const runs = await mkdtemp(join(tmpdir(), 'prove2me-recovery-'));
  t.after(() => rm(runs, { recursive: true, force: true }));
  let clock = 1800000000000;
  const now = () => clock, advance = ms => { clock += ms; };
  const policy = { initialDelayMs: 10, maxDelayMs: 40, reconcileAfterMs: 100, pendingTimeoutMs: 200 };
  const target = { theorem_id: 'leaf', theorem_name: 'Goal', status: 'Open', preamble: '',
    formal_statement: 'theorem Goal : True := by sorry', mathlib_rev: 'a'.repeat(40), visibility: 'public' };
  const source = 'theorem solution : True := by trivial', explanation = 'Saved proof.';
  const snapshot = join(runs, 'proof.lean'), explanationPath = join(runs, 'proof.md');
  await writeFile(snapshot, source); await writeFile(explanationPath, explanation);
  const artifact = { source, source_hash: digest(source), explanation, explanation_hash: digest(explanation),
    snapshot, explanation_path: explanationPath, target_hash: targetFingerprint(target), attempt: 7 };
  const state = { theorem_id: 'leaf', status: 'SUBMISSION_UNKNOWN', job_status: 'ACTIVE', attempt_count: 7,
    source_hash: digest(source), target_fingerprint: targetFingerprint(target), proof_type: 'prove',
    submission_started_at: new Date(now()).toISOString(), submissions: [], artifact_manifest: artifact };
  const posts = [], checks = [], verdicts = new Map(); let history = [];
  const client = {
    request: async path => path.startsWith('submissions?') ? { submissions: history, total: history.length }
      : path.endsWith('/solution') ? { content: source } : target,
    submit: async (...args) => { posts.push(args); return { submission_id: `new-${posts.length}` }; },
  };
  const options = { runs, recovery: policy }, statePath = join(runs, 'state.json');
  const hooks = { now, persist: () => save(statePath, state), poll: async (_client, id) => {
    checks.push(id); return verdicts.get(id) ?? { status: 'PENDING' };
  } };
  return { runs, now, advance, policy, target, state, posts, checks, verdicts, client, options, hooks, artifact,
    history: rows => { history = rows; },
    remote: () => createRemoteActions({ client, target, state, statePath, options, hooks }) };
}

for (const proofType of ['prove', 'disprove']) test(`storage errors retry identical ${proofType} bytes with backoff and retain the pause through PENDING`, async t => {
  const h = await fixture(t), gate = new ProofStorageRecovery();
  h.hooks.proofStorageRecovery = gate;
  h.hooks.poll = async (_client, id) => h.verdicts.get(id) ?? storageError();
  assert.equal((await h.remote().submit(h.artifact, proofType)).status, 'PENDING');
  assert.equal(gate.waiting, true); assert.equal(h.state.attempt_count, 7);
  assert.equal(h.state.remote_operations.at(-1).status, 'ERROR');
  assert.equal(Date.parse(h.state.next_poll_at) - h.now(), 10);
  await h.remote().pollSubmission(); assert.equal(h.posts.length, 1, 'no POST before backoff');
  h.advance(10);
  assert.equal((await h.remote().pollSubmission()).status, 'PENDING');
  assert.equal(Date.parse(h.state.next_poll_at) - h.now(), 20);
  assert.deepEqual(h.posts[0], h.posts[1]);
  assert.equal(h.state.remote_operations.at(-1).reason, 'proof_storage_failure');
  h.advance(20); h.verdicts.set('new-3', { status: 'PENDING' });
  await h.remote().pollSubmission();
  assert.equal(gate.waiting, true, 'a queued replacement does not prove storage is healthy');
  assert.equal(h.state.proof_storage_retry.failures, 2);
  h.verdicts.set('new-3', { status: 'CE', error_message: 'actual compiler feedback' });
  assert.equal((await h.remote().pollSubmission()).status, proofType === 'prove' ? 'CE' : 'DISPROOF_REJECTED');
  assert.equal(gate.waiting, false); assert.equal(h.state.proof_storage_retry, undefined);
  assert.equal(h.state.attempt_count, 7); assert.equal(h.posts.length, 3);
});

test('a restarted storage retry restores the gate, uses the action worker, and preserves immutable artifact checks', async t => {
  const h = await fixture(t);
  h.hooks.poll = async () => storageError('Internal Server Error');
  await h.remote().submit(h.artifact);
  const disk = JSON.parse(await readFile(join(h.runs, 'state.json')));
  const gate = new ProofStorageRecovery(); gate.restore(new Map([['leaf', disk]]));
  h.hooks.proofStorageRecovery = gate;
  assert.equal(gate.waiting, true);
  h.advance(10); h.hooks.readOnlyPoll = () => true;
  await h.remote().pollSubmission(); assert.equal(h.posts.length, 1);
  h.hooks.readOnlyPoll = () => false;
  await writeFile(h.artifact.snapshot, 'modified');
  await assert.rejects(h.remote().pollSubmission(), /saved immutable artifact/);
  assert.equal(h.posts.length, 1); assert.equal(gate.waiting, true);
});

test('lost upload responses recover storage-error records without attempting to download a missing proof', async t => {
  const h = await fixture(t), request = h.client.request;
  h.hooks.proofStorageRecovery = new ProofStorageRecovery();
  h.history([{ id: 'failed', theorem_id: 'leaf', created_at: new Date(h.now()).toISOString(), ...storageError() }]);
  h.client.request = path => {
    assert.ok(!path.endsWith('/solution'), 'storage failure has no source to fetch'); return request(path);
  };
  assert.equal((await h.remote().recoverSubmission()).status, 'PENDING');
  assert.equal(h.state.submission_id, 'failed'); assert.equal(h.hooks.proofStorageRecovery.waiting, true);
  h.advance(10); h.verdicts.set('new-1', { status: 'ACCEPTED' });
  assert.equal((await h.remote().pollSubmission()).status, 'ACCEPTED');
  assert.equal(h.posts.length, 1); assert.equal(h.hooks.proofStorageRecovery.waiting, false);
});

test('storage recovery waits for every affected job and ignores other infrastructure errors', () => {
  assert.equal(proofStorageFailure({ status: 'ERROR', error_message: 'Verification timed out after 300s' }), false);
  const gate = new ProofStorageRecovery();
  const a = { theorem_id: 'a', proof_storage_retry: { failures: 1 } }, b = { theorem_id: 'b', proof_storage_retry: { failures: 2 } };
  gate.block(a); gate.block(b); gate.clear(a);
  assert.equal(gate.waiting, true); assert.deepEqual(gate.state.jobs.map(s => s.theorem_id), ['b']);
  gate.clear(b); assert.equal(gate.waiting, false);
});

test('shared API recovery pauses concurrent requests and persists one recovery probe', async t => {
  const h = await fixture(t), calls = []; let healthy = false;
  const client = { signal: new AbortController().signal, report: () => {}, requestOnce: async path => {
    calls.push(path); if (!healthy) throw new ApiError(401, '/agent/refresh'); return { ok: true };
  } };
  const recovery = new ApiRecovery(client, { runs: h.runs, recovery: h.policy, now: h.now,
    wait: async ms => { h.advance(ms); healthy = true; } });
  const result = await Promise.all(['one', 'two', 'three'].map(path => recovery.request(path, {})));
  assert.deepEqual(result, Array(3).fill({ ok: true }));
  assert.equal(calls.filter(p => p === 'environments').length, 1);
  assert.equal(recovery.state.waiting, false);
  assert.equal(JSON.parse(await readFile(join(h.runs, 'api-recovery.json'))).waiting, false);
});

test('resource-specific 403 is diagnosed without pausing the entire account', async t => {
  const h = await fixture(t), client = { report: () => {}, requestOnce: async path => {
    if (path === 'environments') return { environments: [] };
    throw new ApiError(403, '/theorems/private');
  } };
  const recovery = new ApiRecovery(client, { recovery: h.policy });
  await assert.rejects(recovery.request('theorems/private', {}), e => e.resourceAccess && e.status === 403);
  assert.equal(recovery.state, null);
});

test('shared API recovery survives restart, reloads credentials, and respects Retry-After', async t => {
  const h = await fixture(t), waits = [], client = { key: 'old', report: () => {}, requestOnce: async () => ({ ok: true }) };
  const first = new ApiRecovery(client, { runs: h.runs, now: h.now, recovery: h.policy });
  await first.loaded;
  await first.block(Object.assign(new ApiError(429, '/verify'), { retryAfterMs: 123 }));
  const restarted = new ApiRecovery(client, { runs: h.runs, now: h.now, recovery: h.policy,
    wait: async ms => { waits.push(ms); h.advance(ms); }, loadCredentials: async () => 'new' });
  await restarted.request('theorems/leaf', {});
  assert.deepEqual(waits, [123]); assert.equal(client.key, 'new');
  assert.equal(restarted.state.waiting, false);
});

test('a shared API recovery wait is cancellable', async t => {
  const h = await fixture(t), controller = new AbortController();
  const client = { signal: controller.signal, report: () => {}, requestOnce: async () => assert.fail('no request before retry') };
  const recovery = new ApiRecovery(client, { recovery: h.policy, now: h.now });
  await recovery.block(new ApiError(401, '/agent/refresh'));
  const waiting = recovery.request('theorems/leaf', {});
  controller.abort(new Error('stop API wait'));
  await assert.rejects(waiting, /stop API wait/);
});

test('production client retries a definite rate rejection with the same upload and honors the full server delay', async t => {
  const h = await fixture(t), waits = [], uploaded = []; let posts = 0;
  const client = new Client('key', async (url, options) => {
    if (url.pathname.endsWith('/agent/refresh')) return Response.json({ access_token: 'token', expires_at: 9999999999 });
    if (url.pathname.endsWith('/environments')) return Response.json({ environments: [] });
    uploaded.push(await options.body.get('file').text());
    if (++posts === 1) return new Response('{}', { status: 429, headers: { 'Retry-After': '60' } });
    return Response.json({ submission_id: 'accepted-upload' });
  });
  client.recovery = new ApiRecovery(client, { now: h.now, recovery: h.policy,
    wait: async ms => { waits.push(ms); h.advance(ms); } });
  assert.equal((await client.submit('leaf', 'exact saved source', 'explanation')).submission_id, 'accepted-upload');
  assert.deepEqual(uploaded, ['exact saved source', 'exact saved source']);
  assert.deepEqual(waits, [30000, 30000]);
});

test('production client records a shared service wait but never retries an uncertain POST inside the client', async t => {
  const h = await fixture(t); let posts = 0;
  const client = new Client('key', async url => {
    if (url.pathname.endsWith('/agent/refresh')) return Response.json({ access_token: 'token', expires_at: 9999999999 });
    posts++; return new Response('{}', { status: 503 });
  });
  client.recovery = new ApiRecovery(client, { now: h.now, recovery: h.policy });
  await assert.rejects(client.submit('leaf', 'source', 'explanation'), e => e.status === 503);
  assert.equal(posts, 1); assert.equal(client.recovery.state.waiting, true);
});

test('unknown upload reconciles on restart, then resubmits immutable bytes after the deadline without a model', async t => {
  const h = await fixture(t);
  assert.equal((await h.remote().recoverSubmission()).type, 'WAIT');
  assert.equal(h.posts.length, 0);
  h.advance(99); assert.equal((await h.remote().recoverSubmission()).type, 'WAIT');
  h.advance(1); const result = await h.remote().recoverSubmission();
  assert.equal(result.status, 'PENDING'); assert.equal(h.posts.length, 1);
  assert.deepEqual(h.posts[0], ['leaf', h.artifact.source, h.artifact.explanation, 'prove']);
  assert.equal(h.state.attempt_count, 7); assert.equal(h.state.remote_operations.length, 2);
  assert.equal(h.state.remote_operations[1].reason, 'unreconciled_upload');
  await h.remote().pollSubmission(); assert.equal(h.posts.length, 1);
});

test('late history appearance recovers the original upload before any replacement', async t => {
  const h = await fixture(t);
  await h.remote().recoverSubmission(); h.advance(100);
  h.history([{ id: 'original', theorem_id: 'leaf', proof_type: 'prove' }]);
  assert.deepEqual(await h.remote().recoverSubmission(), { type: 'RECOVERED', submissionId: 'original' });
  assert.equal(h.posts.length, 0);
});

test('partial or failed history reads never authorize resubmission', async t => {
  const h = await fixture(t); h.advance(100);
  h.client.request = async () => ({ submissions: [], total: 10 });
  await assert.rejects(h.remote().recoverSubmission(), /Incomplete submission history/);
  assert.equal(h.posts.length, 0);
});

test('replacement intent persists before a lost response and a restart waits again', async t => {
  const h = await fixture(t); h.advance(100);
  h.client.submit = async () => {
    const disk = JSON.parse(await readFile(join(h.runs, 'state.json')));
    assert.equal(disk.remote_operations.at(-1).status, 'SUBMITTING');
    assert.equal(disk.remote_operations.at(-1).source_hash, h.artifact.source_hash);
    h.posts.push('issued'); throw new Error('lost replacement response');
  };
  await assert.rejects(h.remote().recoverSubmission(), /lost replacement response/);
  assert.equal((await h.remote().recoverSubmission()).type, 'WAIT');
  assert.equal(h.posts.length, 1); assert.equal(h.state.attempt_count, 7);
});

test('pending watchdog replaces a stale upload and recognizes a late success of the original', async t => {
  const h = await fixture(t);
  h.state.status = 'PENDING'; h.state.submission_id = 'original'; h.state.submissions = ['original'];
  h.advance(200);
  assert.equal((await h.remote().pollSubmission()).status, 'PENDING');
  assert.deepEqual(h.state.submissions, ['original', 'new-1']);
  assert.equal(h.state.remote_operations.at(-1).reason, 'stale_pending_submission');
  h.verdicts.set('original', { status: 'ACCEPTED' });
  assert.equal((await h.remote().pollSubmission()).status, 'ACCEPTED');
  assert.equal(h.state.submission_id, 'original'); assert.equal(h.posts.length, 1);
});

test('a vanished pending ID enters reconciliation and can be replaced', async t => {
  const h = await fixture(t); h.advance(200);
  h.state.status = 'PENDING'; h.state.submission_id = 'missing'; h.state.submissions = ['missing'];
  h.hooks.poll = async (_client, id) => { if (id === 'missing') throw new ApiError(404, '/verify'); return { status: 'PENDING' }; };
  assert.equal((await h.remote().pollSubmission()).status, 'PENDING'); assert.equal(h.posts.length, 1);
  assert.deepEqual(h.state.unavailable_submission_ids, ['missing']);
});

test('recovery stops before uploading changed immutable artifacts', async t => {
  const h = await fixture(t); h.advance(100);
  await writeFile(h.artifact.snapshot, 'changed proof');
  await assert.rejects(h.remote().recoverSubmission(), /saved immutable artifact/);
  assert.equal(h.posts.length, 0);
});

test('recovery does not upload against a changed or obsolete target', async t => {
  const h = await fixture(t); h.advance(100);
  const request = h.client.request;
  h.client.request = path => path === 'theorems/leaf' ? { ...h.target, formal_statement: 'changed' } : request(path);
  assert.equal((await h.remote().recoverSubmission()).type, 'TARGET_CHANGED');
  assert.equal(h.posts.length, 0);
  h.state.retirement_requested = true;
  assert.equal((await h.remote().recoverSubmission()).type, 'TARGET_OBSOLETE');
});

test('repair cooldown persists, grows for repeated signatures, and never permanently blocks selection', () => {
  const state = { job_status: 'READY', status: 'REPAIR_REQUIRED' }, policy = recoveryPolicy();
  rememberFailure(state, 'same error', 1000, policy);
  const original = Date.parse(state.retry_after);
  assert.equal(selectable(state, {}, 1000), false); assert.equal(selectable(state, {}, original), true);
  const restarted = structuredClone(state);
  rememberFailure(restarted, 'same error', original, policy);
  assert.equal(Date.parse(restarted.retry_after) - original, policy.initialDelayMs * 2);
  rememberFailure(restarted, 'different error', original, policy);
  assert.equal(restarted.recovery_failure.count, 1);
});

test('unknown dependency publication reconciles, then retries through the shared reservation', async t => {
  const h = await fixture(t), artifact = { theorem_name: 'Child', theorem_title: 'Child', preamble: '',
    formal_statement: 'theorem Child : True := by sorry', natural_language_statement: 'True.' };
  const plan = { ordered: [artifact] }, state = { theorem_id: 'parent', job_id: 'owner' };
  let posts = 0;
  const row = { ...artifact, theorem_id: 'child', mathlib_rev: h.target.mathlib_rev, status: 'Open' };
  const client = { pages: async () => [], publish: async () => {
    if (++posts === 1) throw new Error('lost publish response'); return { job_id: 'replacement' };
  }, request: async path => path === 'theorems/child' ? row : { status: 'PUBLISHED', theorem_id: 'child' } };
  const run = () => publishArtifacts(client, plan, h.target, state, join(h.runs, 'parent/state.json'), h.options, { now: h.now });
  await assert.rejects(run(), /lost publish response/);
  assert.equal(await run(), null); assert.equal(posts, 1);
  h.advance(100); assert.equal((await run())[0].theorem_id, 'child'); assert.equal(posts, 2);
  const record = Object.values(state.publications)[0]; assert.equal(record.operations.length, 2);
});

test('publication watchdog replaces a stale compile job and preserves its history', async t => {
  const h = await fixture(t), artifact = { theorem_name: 'Child', theorem_title: 'Child', preamble: '',
    formal_statement: 'theorem Child : True := by sorry', natural_language_statement: 'True.' };
  const state = { theorem_id: 'parent', job_id: 'owner' }, plan = { ordered: [artifact] }; let posts = 0;
  const client = { pages: async () => [], publish: async () => ({ job_id: `job-${++posts}` }),
    request: async () => ({ status: 'PENDING' }) };
  const run = () => publishArtifacts(client, plan, h.target, state, join(h.runs, 'parent/state.json'), h.options, { now: h.now });
  assert.equal(await run(), null); h.advance(200);
  assert.equal(await run(), null); assert.equal(state.status, 'PUBLISH_UNKNOWN');
  h.advance(100); assert.equal(await run(), null); assert.equal(posts, 2);
  const record = Object.values(state.publications)[0];
  assert.deepEqual(record.previous_jobs, ['job-1']); assert.equal(record.operations.length, 2);
});

test('publication recovery adopts a known shared job ID after a crash before the theorem journal committed it', async t => {
  const h = await fixture(t), artifact = { theorem_name: 'Child', theorem_title: 'Child', preamble: '',
    formal_statement: 'theorem Child : True := by sorry', natural_language_statement: 'True.' };
  const state = { theorem_id: 'parent', job_id: 'owner' }, plan = { ordered: [artifact] }; let posts = 0;
  const client = { pages: async () => [], publish: async () => { posts++; return { job_id: 'known' }; },
    request: async () => ({ status: 'PENDING' }) };
  const run = () => publishArtifacts(client, plan, h.target, state, join(h.runs, 'parent/state.json'), h.options, { now: h.now });
  await run();
  const local = Object.values(state.publications)[0];
  delete local.job_id; delete local.operations[0].job_id; local.status = 'UNKNOWN';
  assert.equal(await run(), null);
  assert.equal(Object.values(state.publications)[0].job_id, 'known');
  assert.equal(state.status, 'PUBLISH_PENDING'); assert.equal(posts, 1);
});
