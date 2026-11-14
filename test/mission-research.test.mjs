import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { MissionResearch, REVIEW_MODEL, REVIEW_RETRY_MS, missionReviewPrompt, snapshotMissionResearch } from '../mission-research.mjs';
import { publicAddress, downloadResearchResource } from '../research-resources.mjs';
import { reviewMission } from '../prove2me.mjs';
import { agentPrompt } from '../agent-prompts.mjs';
import { Pipeline } from '../pipeline.mjs';
import { CodexQuotaError } from '../codex-quota.mjs';

async function fixture(t, every = 100) {
  const runs = await mkdtemp(join(tmpdir(), 'mission-research-'));
  t.after(() => rm(runs, { recursive: true, force: true }));
  let now = 1000;
  const research = new MissionResearch(runs, 'root', { every, now: () => now });
  const root = { theorem_id: 'root', theorem_name: 'Root', formal_statement: 'theorem Root : True := by sorry',
    mathlib_rev: 'rev', status: 'Open', reductions: [] };
  const graph = n => ({ root, nodes: [root, ...Array.from({ length: n - 1 }, (_, i) => ({
    theorem_id: `node-${i}`, theorem_name: `Node${i}`, status: 'Open', reductions: [] }))], leaves: [] });
  return { runs, research, root, graph, advance: n => { now += n; } };
}

test('first review is due at 10 nodes, then waits for 100 additional IDs across restarts', async t => {
  const f = await fixture(t);
  await f.research.observe(f.graph(9)); assert.equal(f.research.due, false);
  const restarted = new MissionResearch(f.runs, 'root');
  await restarted.observe(f.graph(10)); assert.equal(restarted.due, true);
  const request = await restarted.begin(f.graph(10), {}, new Map());
  await restarted.publish(request, { notes: 'Initial research.', resources: [] });
  const afterReview = new MissionResearch(f.runs, 'root');
  for (const count of [10, 19, 100, 109]) {
    await afterReview.observe(f.graph(count)); assert.equal(afterReview.due, false);
  }
  await afterReview.observe(f.graph(110)); assert.equal(afterReview.due, true);
});

test('reviews count distinct observed theorem IDs across refreshes and restarts, coalescing an existing large graph', async t => {
  const f = await fixture(t);
  await f.research.observe(f.graph(150)); assert.equal(f.research.due, true);
  const request = await f.research.begin(f.graph(150), {}, new Map());
  assert.equal(request.observed_count, 150); assert.equal(request.model, REVIEW_MODEL);
  await f.research.publish(request, { notes: 'Evidence-backed research.', resources: [] });
  const restarted = new MissionResearch(f.runs, 'root');
  await restarted.observe(f.graph(250)); assert.equal(restarted.due, true);
  const second = await restarted.begin(f.graph(250), {}, new Map());
  assert.notEqual(second.id, request.id);
  await restarted.publish(second, { notes: 'Updated research.', resources: [] });
  for (const count of [200, 250, 349]) { await restarted.observe(f.graph(count)); assert.equal(restarted.due, false); }
  await restarted.observe(f.graph(350)); assert.equal(restarted.due, true);
  assert.equal(restarted.state.observed_ids.length, 350);
});

test('failed reviews retain their input, do not consume the threshold, and retry without restart loops', async t => {
  const f = await fixture(t, 2); await f.research.observe(f.graph(2));
  const first = await f.research.begin(f.graph(2), {}, new Map());
  await f.research.failed(first, new Error('temporarily unavailable'));
  assert.equal(f.research.due, false); assert.equal(f.research.state.reviewed_count, 0);
  f.advance(REVIEW_RETRY_MS);
  const retry = await f.research.begin(f.graph(2), {}, new Map());
  assert.equal(retry.id, first.id);
  assert.equal(await readFile(retry.inputPath, 'utf8'), await readFile(first.inputPath, 'utf8'));
  await f.research.failed(retry, new Error('quota'), { quota: true });
  assert.equal(f.research.due, true, 'the shared quota controller governs the wait');
  const disabled = new MissionResearch(f.runs, 'other', { every: 0 });
  await disabled.observe(f.graph(1000)); assert.equal(disabled.due, false);
});

test('research is versioned, hash checked, root scoped, and copied privately to proof attempts', async t => {
  const f = await fixture(t, 2); await f.research.observe(f.graph(2));
  const request = await f.research.begin(f.graph(2), {}, new Map());
  await f.research.publish(request, { notes: 'Useful checked observations.', resources: [
    { url: 'https://example.org/reference.lean', purpose: 'Exact source' },
    { url: 'https://example.org/missing.pdf', purpose: 'Related paper' },
  ] }, { download: async url => {
    if (url.endsWith('missing.pdf')) throw new Error('HTTP 404');
    return { bytes: Buffer.from('Reference source, not a proof certificate.'), url, content_type: 'text/plain' };
  } });
  const epoch = f.research.state.epoch;
  assert.equal(await f.research.publish(request, { notes: 'Replayed result', resources: [
    { url: 'https://example.org/reference.lean', purpose: 'Replay must not overwrite a published version' },
  ] }, { download: async () => assert.fail('published versions must not be downloaded or rewritten') }), false);
  const copy = await snapshotMissionResearch(f.runs, 'root', epoch, join(f.runs, 'job-a', 'research'));
  assert.equal(await readFile(copy.notes_path, 'utf8'), 'Useful checked observations.');
  const manifest = JSON.parse(await readFile(copy.manifest_path, 'utf8'));
  assert.equal(manifest.advisory, true); assert.equal(manifest.resources[1].error, 'HTTP 404');
  assert.equal(await snapshotMissionResearch(f.runs, 'another-root', epoch, join(f.runs, 'job-b')), null);
  await writeFile(copy.notes_path, 'Changed private copy');
  const other = await snapshotMissionResearch(f.runs, 'root', epoch, join(f.runs, 'job-b'));
  assert.equal(await readFile(other.notes_path, 'utf8'), 'Useful checked observations.');
  await assert.rejects(snapshotMissionResearch(f.runs, 'root', epoch, join(f.runs, 'job-a', 'research')), /snapshot changed/);
  await writeFile(join(request.dir, 'resource-1.lean'), 'Tampered');
  await assert.rejects(snapshotMissionResearch(f.runs, 'root', epoch, join(f.runs, 'job-c')), /integrity/);
  f.root.formal_statement = 'theorem Root : False := by sorry';
  await f.research.observe(f.graph(2));
  assert.equal(await snapshotMissionResearch(f.runs, 'root', f.research.state.epoch, join(f.runs, 'job-d')), null);
});

test('a review for an obsolete target cannot publish into the new target context', async t => {
  const f = await fixture(t, 2); await f.research.observe(f.graph(2));
  const request = await f.research.begin(f.graph(2), {}, new Map());
  f.root.mathlib_rev = 'new-environment'; await f.research.observe(f.graph(2));
  assert.equal(await f.research.publish(request, { notes: 'Old advice', resources: [] }), false);
  assert.equal(f.research.state.latest, null); assert.equal(f.research.state.reviewed_count, 0);
});

test('review invocation defaults to Sol 6.1 and a read-only sandbox, and shared prompts contain no mission-specific recipe', async t => {
  const f = await fixture(t, 2); await f.research.observe(f.graph(2));
  const request = await f.research.begin(f.graph(2), {}, new Map());
  let assertions = 0;
  const result = await reviewMission(request, { codex: 'configured-codex', model: 'other-proof-model',
    assertModelSlot: () => assertions++ }, { command: async (exe, args, settings) => {
    assert.equal(exe, 'configured-codex'); assert.equal(args[args.indexOf('--model') + 1], REVIEW_MODEL);
    assert.equal(args[args.indexOf('--sandbox') + 1], 'read-only');
    assert.match(settings.input, /verified evidence, inferences, and open questions/);
    await writeFile(args[args.indexOf('--output-last-message') + 1], JSON.stringify({ notes: 'Research', resources: [] }));
  } });
  assert.equal(assertions, 1); assert.equal(result.notes, 'Research');
  const proofPrompt = agentPrompt(f.root, f.runs, 1, '', 'solution.lean', { operation: 'reconsider_reduction', attemptContextPath: 'manifest.json' });
  for (const prompt of [proofPrompt, missionReviewPrompt(request)]) {
    assert.doesNotMatch(prompt, /ComparatorChallenges|solution_module|PiExponent|Quasi.Riemann|permutation terms|monomial case/);
  }
  assert.match(proofPrompt, /mission_research/);
});

test('mission review profile can be explicitly configured independently of proof attempts', async t => {
  const f = await fixture(t, 2);
  const research = new MissionResearch(f.runs, f.root.theorem_id, { every: 2, model: 'sol-6.1-medium' });
  await research.observe(f.graph(2));
  const request = await research.begin(f.graph(2), {}, new Map());
  assert.equal(request.model, 'gpt-6.1-sol'); assert.equal(request.reasoningEffort, 'medium');
  await reviewMission(request, { codex: 'configured-codex', model: 'luna-6-high' }, {
    command: async (_exe, args) => {
      assert.equal(args[args.indexOf('--model') + 1], 'gpt-6.1-sol');
      assert.ok(args.includes('model_reasoning_effort="medium"'));
      await writeFile(args[args.indexOf('--output-last-message') + 1], JSON.stringify({ notes: 'Explicit review', resources: [] }));
    },
  });
});

test('resource downloads pin public DNS, bound bytes, and recheck redirected destinations', async () => {
  for (const address of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '192.168.1.1', '::1',
    '::ffff:127.0.0.1', '::ffff:7f00:1', 'fc00::1', '2001:db8::1', '2002:7f00:1::', '2001::1']) assert.equal(publicAddress(address), false, address);
  assert.equal(publicAddress('8.8.8.8'), true); assert.equal(publicAddress('2606:4700:4700::1111'), true);
  const lookup = async hostname => [{ address: hostname === 'internal.example' ? '127.0.0.1' : '8.8.8.8', family: 4 }];
  let calls = 0, redirect = false;
  const get = (_url, options, callback) => {
    calls++;
    options.lookup('example.org', { all: true }, (err, addresses) => { assert.equal(err, null); assert.equal(addresses[0].address, '8.8.8.8'); });
    assert.equal(options.headers.Authorization, undefined);
    const response = Readable.from([Buffer.from('source')]);
    response.statusCode = redirect ? 302 : 200;
    response.headers = redirect ? { location: 'https://internal.example/private' } : { 'content-type': 'text/plain' };
    queueMicrotask(() => callback(response)); return new EventEmitter();
  };
  assert.equal((await downloadResearchResource('https://example.org/source', { lookup, get })).bytes.toString(), 'source');
  await assert.rejects(downloadResearchResource('https://example.org/source', { lookup, get, maxBytes: 2 }), /size limit/);
  await assert.rejects(downloadResearchResource('http://example.org/source', { lookup, get }), /HTTPS/);
  await assert.rejects(downloadResearchResource('https://secret@example.org/source', { lookup, get }), /credentials/);
  redirect = true;
  await assert.rejects(downloadResearchResource('https://example.org/source', { lookup, get }), /non-public/);
  assert.equal(calls, 3, 'blocked URLs and redirected private addresses never open a connection');
  const controller = new AbortController();
  const waiting = downloadResearchResource('https://example.org/source', { signal: controller.signal,
    lookup: () => new Promise(() => {}), get: () => assert.fail('aborted DNS must not open a connection') });
  controller.abort(new Error('cancelled DNS'));
  await assert.rejects(waiting, /cancelled DNS/);
});

test('mission review uses the shared model cap and quota pause without consuming a proof attempt', async t => {
  const f = await fixture(t, 2), started = [];
  const pipeline = new Pipeline({}, { root: 'root' }, { runs: f.runs,
    pipeline: { missionReviewEvery: 2, queues: { codex: { concurrency: 1 } } } }, {
    reviewMission: async request => { started.push(request.id); throw new CodexQuotaError('quota exhausted'); },
  });
  pipeline.selection.graph = f.graph(2); pipeline.selection.requestedGeneration = 1; pipeline.selection.committedGeneration = 1;
  await pipeline.quota.load(); await pipeline.research.observe(f.graph(2));
  pipeline.controls.set('proof', { running: 'CODEX' });
  await pipeline.maybeReview(); assert.equal(started.length, 0);
  pipeline.controls.clear(); await pipeline.maybeReview();
  const pending = pipeline.reviewing; await pending;
  assert.equal(started.length, 1); assert.equal(pipeline.quota.waiting, true);
  assert.equal(pipeline.research.state.reviewed_count, 0);
  assert.equal((await pipeline.store.index()).size, 0);
  await pipeline.maybeReview(); assert.equal(started.length, 1);
});

test('Sol mission reviews and proof dispatch share one exclusive Sol slot', async t => {
  const f = await fixture(t, 2);
  let release, started = 0;
  const blocked = new Promise(resolve => { release = resolve; });
  const pipeline = new Pipeline({}, { root: 'root' }, { runs: f.runs, pipeline: {
    missionReviewEvery: 2, missionReviewModel: 'sol-6.1-high', queues: { codex: { concurrency: 4 } },
  } }, { reviewMission: async () => { started++; await blocked; return { notes: 'Review.', resources: [] }; } });
  t.after(() => release());
  pipeline.selection.graph = f.graph(2); pipeline.selection.requestedGeneration = 1; pipeline.selection.committedGeneration = 1;
  await pipeline.quota.load(); await pipeline.research.observe(f.graph(2));
  pipeline.controls.set('proof', { running: 'CODEX', model: 'gpt-6.1-sol' });
  await pipeline.maybeReview(); assert.equal(started, 0); assert.equal(pipeline.solRunning(), 1);
  pipeline.controls.clear(); await pipeline.maybeReview();
  assert.equal(pipeline.solRunning(), 1);
  const state = await pipeline.store.ensure('queued-sol');
  Object.assign(state, { stage: 'CODEX', operation: 'implement' });
  await pipeline.store.replace(state, state.revision);
  pipeline.options.model = 'sol-6.1-high';
  let dispatched = false;
  pipeline.controls.set(state.theorem_id, { running: null, waiting: { state, persist: async () => {},
    resolve: () => { dispatched = true; }, reject: assert.fail } });
  await pipeline.routeAndDispatch(); assert.equal(dispatched, false);
  release(); await pipeline.reviewing;
  assert.equal(started, 1); assert.equal(pipeline.solRunning(), 0);
  await pipeline.routeAndDispatch(); assert.equal(dispatched, true); assert.equal(pipeline.solRunning(), 1);
});
