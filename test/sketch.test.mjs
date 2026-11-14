import { solveLeaf } from '../test-support/selection-rounds.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Client, agent, decomposition, mirror, normalizeAnswer, pollPublish, runTarget, typeCheckSource } from '../prove2me.mjs';

const rev = 'a'.repeat(40);
const target = { theorem_id: 'parent', theorem_name: 'Ns.goal', status: 'Open', visibility: 'public', mathlib_rev: rev,
  preamble: '', formal_statement: 'theorem Ns.goal (n : Nat) : n + 0 = n ∧ 0 + n = n := by sorry' };
const environment = { mathlib_rev: rev, toolchain: 'leanprover/lean4:v4.33.1' };
const child = (name, type) => ({ theorem_name: name, theorem_title: name, preamble: '',
  formal_statement: `theorem ${name} (n : Nat) : ${type} := by sorry`, natural_language_statement: `For every natural number n, ${type}.` });
const children = [child('Ns.right', 'n + 0 = n'), child('Ns.left', '0 + n = n')];
const source = 'import Theorems.Thm_Ns_right\nimport Theorems.Thm_Ns_left\ntheorem solution (n : Nat) : n + 0 = n ∧ 0 + n = n := by exact ⟨Ns.right n, Ns.left n⟩';
const answer = { ready: true, kind: 'sketch', explanation: 'The two addition identities give the conjunction.', children, definitions: [] };
const definition = { definition_name: 'NatId', definition_title: 'Natural identity', definition: 'def NatId (n : Nat) : Nat := n',
  natural_language_statement: 'The identity function on natural numbers.' };
async function temporary(t) {
  const dir = await mkdtemp(join(tmpdir(), 'prove2me-sketch-'));
  t.after(() => rm(dir, { recursive: true, force: true })); return dir;
}
async function harness(t) {
  const root = await temporary(t), workspace = join(root, 'workspace'), events = [], catalog = new Map(), jobs = new Map();
  for (const dir of ['Solutions', 'Theorems', 'Definitions']) await mkdir(join(workspace, dir), { recursive: true });
  const solution = join(workspace, 'Solutions/Sol_parent.lean');
  const options = { runs: join(root, 'runs'), attempts: 1, pollTimeout: 0, lake: 'lake', refreshInterval: 0, verificationMode: 'local', attemptModels: [] };
  let agents = 0, creates = 0, submissions = 0;
  const client = {
    pages: async path => {
      const url = new URL(path, 'https://prove2.me/api/v1/');
      if (url.pathname.endsWith('publish-jobs')) return [...jobs.values()];
      return [...catalog.values()].filter(row => row.status === 'Definition'
        ? url.searchParams.get('status') === 'Definition' : url.searchParams.get('status') !== 'Definition').filter(row => url.searchParams.has('q')
        ? (row.theorem_name ?? row.definition_name).includes(url.searchParams.get('q'))
        : (row.theorem_name ?? row.definition_name) === url.searchParams.get('theorem_name'));
    },
    request: async path => {
      if (path === 'theorems/parent') return target;
      if (path.startsWith('publish-jobs/')) return jobs.get(path.split('/')[1]);
      const row = catalog.get(path.split('/')[1]); assert.ok(row, `Unknown request ${path}`); return row;
    },
    publish: async (kind, artifact, parent) => {
      events.push(`publish:${kind}`); creates++;
      assert.ok(events.filter(event => event === 'check').length >= 1, 'compile/type-check before publishing');
      assert.equal(parent.mathlib_rev, rev);
      const name = artifact.theorem_name ?? artifact.definition_name, id = `child-${creates}`, jobId = `job-${creates}`;
      catalog.set(id, { ...artifact, theorem_id: id, status: kind === 'definition' ? 'Definition' : 'Open', mathlib_rev: rev });
      jobs.set(jobId, { id: jobId, status: 'PUBLISHED', theorem_id: id, theorem_name: name,
        visibility: 'public', formal_statement: artifact.formal_statement, definitions: artifact.definition ?? artifact.preamble });
      return kind === 'definition' ? { job_id: jobId } : { jobs: [{ job_id: jobId, name }], errors: [] };
    },
    submit: async (id, bytes) => {
      events.push('submit'); submissions++;
      assert.equal(id, 'parent'); assert.equal(bytes, await readFile(solution, 'utf8'));
      return { submission_id: 'reduction' };
    },
  };
  const hooks = {
    preflight: async () => {},
    workspace: async () => workspace,
    mirror: (...args) => mirror(...args.slice(0, 4), { ...args[4], cacheDir: join(root, 'cache') }),
    agent: async () => { agents++; await writeFile(solution, source); return { ...answer, solution, module: 'Solutions.Sol_parent' }; },
    command: async (_exe, args) => { events.push(args[0] === 'build' ? 'build' : 'check'); },
    poll: async () => ({ status: 'SKETCH_ACCEPTED' }),
  };
  return { root, workspace, solution, options, client, hooks, catalog, jobs, events, statePath: join(options.runs, 'parent/state.json'),
    counts: () => ({ agents, creates, submissions }) };
}

test('sketch publishes checked child problems, verifies live imports, submits, and never resubmits an accepted reduction', async t => {
  const h = await harness(t);
  assert.equal(await solveLeaf(h.client, target, {}, environment, h.options, h.hooks), 'SKETCH_ACCEPTED');
  assert.deepEqual(h.events, ['build', 'check', 'publish:problem', 'publish:problem', 'build', 'check', 'submit']);
  assert.match(await readFile(join(h.workspace, 'Theorems/Thm_Ns_right.lean'), 'utf8'), /:= by sorry/);
  assert.equal(await solveLeaf(h.client, target, {}, environment, h.options, h.hooks), 'SKETCH_ACCEPTED');
  assert.deepEqual(h.counts(), { agents: 1, creates: 2, submissions: 1 });
  assert.deepEqual(JSON.parse(await readFile(join(h.options.runs, 'parent/decomposition-1.json'), 'utf8')).children, children);
});

test('a sketch failing validation against published dependencies never submits the reduction', async t => {
  const h = await harness(t), compile = h.hooks.command;
  h.hooks.command = async (exe, args, options) => {
    await compile(exe, args, options);
    if (options.log.endsWith('lean-1-published.log')) {
      await writeFile(options.log, 'Lean: live dependency type mismatch');
      throw new Error('published dependency build failed');
    }
  };
  assert.equal(await solveLeaf(h.client, target, {}, environment, h.options, h.hooks), 'READY');
  assert.deepEqual(h.events, ['build', 'check', 'publish:problem', 'publish:problem', 'build']);
  assert.deepEqual(h.counts(), { agents: 1, creates: 2, submissions: 0 });
  const state = JSON.parse(await readFile(h.statePath, 'utf8'));
  assert.match(state.feedback, /live dependency type mismatch/);
  assert.equal(Object.keys(state.publications).length, 2);
  assert.equal(await readFile(join(h.options.runs, 'parent/solution-1.lean'), 'utf8'), source);
});

test('a sketch can reuse existing Open problems without publishing duplicates', async t => {
  const h = await harness(t);
  children.forEach((row, i) => h.catalog.set(`existing-${i}`, { ...row, theorem_id: `existing-${i}`, mathlib_rev: rev, status: 'Open' }));
  assert.equal(await solveLeaf(h.client, target, {}, environment, h.options, h.hooks), 'SKETCH_ACCEPTED');
  assert.equal(h.counts().creates, 0);
});

test('a sketch can reduce to existing Open imports without proposing any new problems', async t => {
  const h = await harness(t), generate = h.hooks.agent;
  children.forEach((row, i) => h.catalog.set(`existing-${i}`, { ...row, theorem_id: `existing-${i}`, mathlib_rev: rev, status: 'Open' }));
  h.hooks.agent = async (...args) => ({ ...await generate(...args), children: [] });
  assert.equal(await solveLeaf(h.client, target, {}, environment, h.options, h.hooks), 'SKETCH_ACCEPTED');
  assert.deepEqual(h.counts(), { agents: 1, creates: 0, submissions: 1 });
});

test('a direct proof still rejects Open dependencies', async t => {
  const h = await harness(t);
  children.forEach((row, i) => h.catalog.set(`existing-${i}`, { ...row, theorem_id: `existing-${i}`, mathlib_rev: rev, status: 'Open' }));
  h.hooks.agent = async () => { await writeFile(h.solution, source); return { ...answer, kind: 'proof', children: [], solution: h.solution, module: 'Solutions.Sol_parent' }; };
  assert.equal(await solveLeaf(h.client, target, {}, environment, h.options, h.hooks), 'READY');
  assert.equal(h.counts().submissions, 0);
  assert.match(JSON.parse(await readFile(h.statePath, 'utf8')).feedback, /Open dependency/);
});

test('supporting definitions publish before children and keep their Lean bodies', async t => {
  const h = await harness(t), dependent = { ...children[0], preamble: 'import Definitions.Def_NatId',
    formal_statement: 'theorem Ns.right (n : Nat) : NatId n + 0 = n := by sorry' };
  h.hooks.agent = async () => {
    await writeFile(h.solution, source.replace('Ns.right n', 'by simpa [NatId] using Ns.right n'));
    return { ...answer, children: [dependent, children[1]], definitions: [definition], solution: h.solution, module: 'Solutions.Sol_parent' };
  };
  assert.equal(await solveLeaf(h.client, target, {}, environment, h.options, h.hooks), 'SKETCH_ACCEPTED');
  assert.deepEqual(h.events.filter(event => event.startsWith('publish')), ['publish:definition', 'publish:problem', 'publish:problem']);
  assert.equal(await readFile(join(h.workspace, 'Definitions/Def_NatId.lean'), 'utf8'), definition.definition);
});

test('definition publication preflight finds existing definitions with an explicit status filter', async t => {
  const h = await harness(t);
  h.catalog.set('existing-definition', { ...definition, theorem_id: 'existing-definition', status: 'Definition', mathlib_rev: rev });
  const dependent = { ...children[0], preamble: 'import Definitions.Def_NatId' };
  h.hooks.agent = async () => {
    await writeFile(h.solution, source);
    return { ...answer, children: [dependent, children[1]], definitions: [definition], solution: h.solution, module: 'Solutions.Sol_parent' };
  };
  assert.equal(await solveLeaf(h.client, target, {}, environment, h.options, h.hooks), 'SKETCH_ACCEPTED');
  assert.equal(h.counts().creates, 2, 'reuse the existing definition instead of creating it again');
  assert.ok(!h.events.includes('publish:definition'));
});

test('shared dependencies are fetched once per validation and checked afresh after publication', async t => {
  const h = await harness(t), request = h.client.request;
  h.catalog.set('shared', { ...definition, theorem_id: 'shared', status: 'Definition', mathlib_rev: rev });
  h.client.request = async path => {
    if (path === 'theorems/shared') h.events.push('shared-detail');
    return request(path);
  };
  h.hooks.agent = async () => {
    await writeFile(h.solution, 'import Definitions.Def_NatId\n' + source);
    return { ...answer, children: children.map(row => ({ ...row, preamble: 'import Definitions.Def_NatId' })),
      solution: h.solution, module: 'Solutions.Sol_parent' };
  };
  assert.equal(await solveLeaf(h.client, target, {}, environment, h.options, h.hooks), 'SKETCH_ACCEPTED');
  const firstPublication = h.events.indexOf('publish:problem');
  assert.equal(h.events.slice(0, firstPublication).filter(event => event === 'shared-detail').length, 1);
  assert.equal(h.events.slice(firstPublication).filter(event => event === 'shared-detail').length, 1);
});

test('compilation failure prevents all child creation and reduction submissions', async t => {
  const h = await harness(t);
  h.hooks.command = async (_exe, _args, { log }) => { await writeFile(log, 'Lean: unsolved goals'); throw new Error('compile failed'); };
  assert.equal(await solveLeaf(h.client, target, {}, environment, h.options, h.hooks), 'READY');
  assert.deepEqual(h.counts(), { agents: 1, creates: 0, submissions: 0 });
});

test('pending publish jobs resume without another agent or duplicate creation', async t => {
  const h = await harness(t); let pending = true;
  h.hooks.pollPublish = async (_client, id) => pending ? { status: 'COMPILING' } : h.jobs.get(id);
  assert.equal(await solveLeaf(h.client, target, {}, environment, h.options, h.hooks), 'PUBLISH_PENDING');
  assert.deepEqual(h.counts(), { agents: 1, creates: 2, submissions: 0 });
  // The new catalog entry normally arrives only after compilation, not while the job is pending.
  const published = new Map(h.catalog); h.catalog.clear();
  pending = false; h.hooks.pollPublish = async (_client, id) => { for (const [key, row] of published) h.catalog.set(key, row); return h.jobs.get(id); };
  await writeFile(h.solution, 'tampered file');
  assert.equal(await solveLeaf(h.client, target, {}, environment, h.options, h.hooks), 'SKETCH_ACCEPTED');
  assert.deepEqual(h.counts(), { agents: 1, creates: 2, submissions: 1 });
});

test('polling independent publications does not repeat catalog discovery', async t => {
  const h = await harness(t), pages = h.client.pages;
  let lookups = 0, polls = 0;
  h.client.pages = async path => { if (path.startsWith('theorems?')) lookups++; return pages(path); };
  h.hooks.pollPublish = async () => { polls++; return { status: 'COMPILING' }; };
  for (let i = 0; i < 3; i++) assert.equal(await solveLeaf(h.client, target, {}, environment, h.options, h.hooks), 'PUBLISH_PENDING');
  assert.equal(lookups, 2, 'preflight checks both proposed names once before the first POST');
  assert.equal(polls, 6);
  assert.deepEqual(h.counts(), { agents: 1, creates: 2, submissions: 0 });
});

test('confirmed siblings are read afresh at handoff, rather than on every pending poll', async t => {
  const h = await harness(t), request = h.client.request;
  let firstReads = 0, pending = true;
  h.client.request = async path => { if (path === 'theorems/child-1') firstReads++; return request(path); };
  h.hooks.pollPublish = async (_client, id) => id === 'job-2' && pending ? { status: 'COMPILING' } : h.jobs.get(id);
  for (let i = 0; i < 3; i++) assert.equal(await solveLeaf(h.client, target, {}, environment, h.options, h.hooks), 'PUBLISH_PENDING');
  assert.equal(firstReads, 1, 'the first declaration is checked when its publication completes');
  pending = false;
  assert.equal(await solveLeaf(h.client, target, {}, environment, h.options, h.hooks), 'SKETCH_ACCEPTED');
  // One fresh publication handoff read and one normal dependency mirror read.
  assert.equal(firstReads, 3);
  assert.deepEqual(h.counts(), { agents: 1, creates: 2, submissions: 1 });
});

test('known publication jobs poll without repeating catalog discovery or model work', async t => {
  const h = await harness(t), pages = h.client.pages;
  let lookups = 0, polls = 0;
  h.client.pages = async path => { if (path.startsWith('theorems?')) lookups++; return pages(path); };
  h.hooks.pollPublish = async () => { polls++; return { status: 'COMPILING' }; };
  // Use one child so only the declaration owned by the pending job is involved.
  h.hooks.agent = async () => {
    await writeFile(h.solution, source.replace('import Theorems.Thm_Ns_left\n', '')
      .replace('Ns.left n', 'Nat.zero_add n'));
    return { ...answer, children: [children[0]], solution: h.solution, module: 'Solutions.Sol_parent' };
  };
  for (let i = 0; i < 3; i++) {
    assert.equal(await solveLeaf(h.client, target, {}, environment, h.options, h.hooks), 'PUBLISH_PENDING');
  }
  assert.equal(polls, 3, 'one poll per scheduled action');
  assert.equal(lookups, 1, 'one name preflight before creation');
  assert.equal(h.counts().creates, 1, 'pending compilation is never created again');
  assert.equal(h.events.filter(event => event === 'build').length, 1, 'pending recovery does not recompile the candidate');
});

test('pending sketch recovery restores the checked reduction into a fresh workspace', async t => {
  const h = await harness(t);
  h.hooks.pollPublish = async () => ({ status: 'COMPILING' });
  assert.equal(await solveLeaf(h.client, target, {}, environment, h.options, h.hooks), 'PUBLISH_PENDING');
  await writeFile(h.solution, 'legacy file must remain untouched');
  const isolated = join(h.root, 'isolated');
  for (const folder of ['Solutions', 'Definitions', 'Theorems']) await mkdir(join(isolated, folder), { recursive: true });
  h.hooks.workspace = async () => isolated;
  h.hooks.agent = async () => assert.fail('recovery must not start a model');
  h.hooks.pollPublish = async (_client, id) => h.jobs.get(id);
  let uploads = 0;
  h.client.submit = async (_id, bytes) => { uploads++; assert.equal(bytes, source); return { submission_id: 'reduction' }; };
  assert.equal(await solveLeaf(h.client, target, {}, environment, { ...h.options, resumeOnly: true }, h.hooks), 'SKETCH_ACCEPTED');
  assert.equal(uploads, 1);
  const state = JSON.parse(await readFile(h.statePath, 'utf8'));
  assert.equal(state.sketch.solution, join(isolated, 'Solutions/Sol_parent.lean'));
  assert.equal(await readFile(state.sketch.solution, 'utf8'), source);
  assert.equal(await readFile(h.solution, 'utf8'), 'legacy file must remain untouched');
  assert.equal(h.counts().agents, 1);
  assert.equal(h.counts().creates, 2);
});

test('lost publish response is reconciled from own jobs without resending', async t => {
  const h = await harness(t), publish = h.client.publish;
  h.client.publish = async (...args) => { await publish(...args); h.catalog.clear(); throw new Error('response lost'); };
  await assert.rejects(solveLeaf(h.client, target, {}, environment, h.options, h.hooks), /response lost/);
  const state = JSON.parse(await readFile(h.statePath, 'utf8')); assert.equal(state.status, 'PUBLISH_UNKNOWN');
  h.client.publish = publish;
  h.hooks.pollPublish = async (_client, id) => {
    const job = h.jobs.get(id), artifact = children.find(row => row.theorem_name === job.theorem_name);
    h.catalog.set(job.theorem_id, { ...artifact, theorem_id: job.theorem_id, mathlib_rev: rev, status: 'Open' }); return job;
  };
  assert.equal(await solveLeaf(h.client, { ...target, tags: ['new-tag'], source: 'updated reference' }, {}, environment, h.options, h.hooks), 'SKETCH_ACCEPTED');
  assert.deepEqual(h.counts(), { agents: 1, creates: 2, submissions: 1 });
});

test('unreconciled publish outcome waits without resending before the recovery deadline', async t => {
  const h = await harness(t); let posts = 0;
  h.client.publish = async () => { posts++; throw new Error('connection lost'); };
  await assert.rejects(solveLeaf(h.client, target, {}, environment, h.options, h.hooks), /connection lost/);
  assert.equal(await solveLeaf(h.client, target, {}, environment, h.options, h.hooks), 'PUBLISH_PENDING');
  assert.equal(posts, 1); assert.equal(h.counts().agents, 1);
});

test('publish compile failures feed back to the next attempt without submitting the reduction', async t => {
  const h = await harness(t); let calls = 0;
  h.options.attempts = 2;
  h.hooks.pollPublish = async () => ({ status: 'FAILED', error_message: 'unknown identifier' });
  const generate = h.hooks.agent;
  h.hooks.agent = async (...args) => {
    if (++calls === 2) { assert.match(args[4], /unknown identifier/); return { ready: false, explanation: 'Need a corrected child statement.' }; }
    return generate(...args);
  };
  assert.equal(await solveLeaf(h.client, target, {}, environment, h.options, h.hooks), 'READY');
  assert.equal(h.counts().submissions, 0); assert.equal(calls, 2);
});

test('a resumed publication rejection returns diagnostics to a repair within the original budget', async t => {
  const h = await harness(t);
  h.options.attempts = 2;
  h.hooks.pollPublish = async () => ({ status: 'COMPILING' });
  assert.equal(await solveLeaf(h.client, target, {}, environment, h.options, h.hooks), 'PUBLISH_PENDING');
  h.catalog.clear();
  h.hooks.pollPublish = async () => ({ status: 'FAILED', error_message: 'child compile timeout' });
  h.hooks.agent = async (...args) => {
    assert.match(args[4], /child compile timeout/); return { ready: false, explanation: 'Need a smaller child statement.' };
  };
  assert.equal(await solveLeaf(h.client, target, {}, environment, { ...h.options, attempts: 99, testRounds: 2 }, h.hooks), 'READY');
  assert.equal(JSON.parse(await readFile(h.statePath, 'utf8')).attempt_count, 2);
});

test('a confirmed publish infrastructure error recovers publication in the same mathematical attempt', async t => {
  const h = await harness(t); let failed = false;
  h.options.attempts = 2;
  h.hooks.pollPublish = async (_client, id) => {
    if (!failed) {
      failed = true; h.catalog.clear(); return { status: 'ERROR', error_message: 'worker unavailable' };
    }
    return h.jobs.get(id);
  };
  assert.equal(await solveLeaf(h.client, target, {}, environment, h.options, h.hooks), 'SKETCH_ACCEPTED');
  assert.deepEqual(h.counts(), { agents: 1, creates: 3, submissions: 1 });
});

test('conflicting existing names, environments, and deprecated children are not reused', async t => {
  for (const change of [{ formal_statement: 'theorem Ns.right : False := by sorry' }, { mathlib_rev: 'b'.repeat(40) }, { deprecated_at: 'yesterday' }]) {
    const h = await harness(t);
    h.catalog.set('existing', { ...children[0], theorem_id: 'existing', status: 'Open', mathlib_rev: rev, ...change });
    assert.equal(await solveLeaf(h.client, target, {}, environment, h.options, h.hooks), 'READY');
    assert.equal(h.counts().creates, 0); assert.equal(h.counts().submissions, 0);
  }
});

test('a conflict in the last child prevents creation of earlier children too', async t => {
  const h = await harness(t);
  h.catalog.set('conflict', { ...children[1], theorem_id: 'conflict', status: 'Open', mathlib_rev: rev,
    formal_statement: 'theorem Ns.left : False := by sorry' });
  assert.equal(await solveLeaf(h.client, target, {}, environment, h.options, h.hooks), 'READY');
  assert.equal(h.counts().creates, 0);
});

test('artifact validation rejects target restatements, holes, unused children, and circular definitions', () => {
  assert.throws(() => decomposition({ ...answer, children: [child('Ns.copy', 'n + 0 = n ∧ 0 + n = n')] }, target,
    'import Theorems.Thm_Ns_copy'), /restates/);
  assert.throws(() => decomposition({ ...answer, definitions: [{ ...definition, definition: 'axiom NatId : Nat' }] }, target, source), /untrusted/);
  assert.throws(() => decomposition(answer, target, 'import Theorems.Thm_Ns_right'), /unused/);
  assert.throws(() => decomposition({ ...answer, children: [{ ...children[0], formal_statement: children[0].formal_statement + '\naxiom lie : False' }] }, target, source), /one exact/);
  const a = { ...definition, definition_name: 'A', definition: 'import Definitions.Def_B\ndef A : Nat := B' };
  const b = { ...definition, definition_name: 'B', definition: 'import Definitions.Def_A\ndef B : Nat := A' };
  assert.throws(() => decomposition({ ...answer, children: [], definitions: [a, b] }, target, 'import Definitions.Def_A'), /Circular/);
});

const wrappedChild = row => ({ ...row,
  formal_statement: `namespace Ns\n\n${row.formal_statement.replace(`theorem ${row.theorem_name}`, `theorem ${row.theorem_name.slice(3)}`)}\n\nend Ns` });

test('matching namespace wrappers are corrected without a model call or another proof attempt', async t => {
  const h = await harness(t), generate = h.hooks.agent;
  h.options.attempts = 2;
  h.hooks.agent = async (...args) => ({ ...await generate(...args), children: children.map(wrappedChild) });
  h.hooks.repairAnswer = async () => assert.fail('Namespace formatting should be corrected locally');
  assert.equal(await solveLeaf(h.client, target, {}, environment, h.options, h.hooks), 'SKETCH_ACCEPTED');
  assert.equal(h.counts().agents, 1);
  assert.deepEqual(JSON.parse(await readFile(join(h.options.runs, 'parent/decomposition-1.json'), 'utf8')).children, children);
  assert.deepEqual(JSON.parse(await readFile(join(h.options.runs, 'parent/answer-1-normalized.json'), 'utf8')).children, children);
  assert.equal(JSON.parse(await readFile(h.statePath, 'utf8')).attempt_count, 1);
});

test('normalization preserves theorem bodies and leaves mismatched or extra commands rejected', () => {
  for (const declaration of [
    wrappedChild(children[0]).formal_statement.replace('namespace Ns', 'namespace Other').replace('end Ns', 'end Other'),
    wrappedChild(children[0]).formal_statement.replace('end Ns', 'def lie : Nat := 0\nend Ns'),
    wrappedChild(children[0]).formal_statement.replace('by sorry', 'by rfl'),
  ]) {
    const normalized = normalizeAnswer({ ...answer, children: [{ ...children[0], formal_statement: declaration }, children[1]] });
    assert.equal(normalized.children[0].formal_statement, declaration);
    assert.throws(() => decomposition(normalized, target, source), /one exact/);
  }
  const fenced = normalizeAnswer({ ...answer, children: [{ ...children[0], formal_statement: '```lean\n' + children[0].formal_statement + '\n```' }, children[1]] });
  assert.deepEqual(fenced.children, children);
});

test('one Luna formatting repair fixes metadata in the same attempt and is logged separately', async t => {
  const h = await harness(t), generate = h.hooks.agent;
  let repairs = 0;
  h.options.attempts = 2;
  h.hooks.agent = async (...args) => ({ ...await generate(...args), children: [{ ...children[0], theorem_title: '' }, children[1]] });
  h.hooks.repairAnswer = async (_target, _workspace, _dir, attempt, error, result) => {
    repairs++;
    assert.equal(attempt, 1); assert.match(error, /artifact fields/);
    return { ...result, children: children };
  };
  assert.equal(await solveLeaf(h.client, target, {}, environment, h.options, h.hooks), 'SKETCH_ACCEPTED');
  assert.equal(h.counts().agents, 1); assert.equal(repairs, 1);
  assert.equal(JSON.parse(await readFile(h.statePath, 'utf8')).attempt_count, 1);
  const dir = join(h.options.runs, 'parent');
  assert.equal(JSON.parse(await readFile(join(dir, 'answer-1-repair-input.json'), 'utf8')).children[0].theorem_title, '');
  assert.deepEqual(JSON.parse(await readFile(join(dir, 'answer-1-repaired.json'), 'utf8')).children, children);
});

test('failed formatting repairs preserve artifacts under the configured schedule without publication', async t => {
  for (const failure of ['still invalid', 'timeout', 'changed theorem', 'changed preamble', 'changed identity', 'changed count', 'changed proof']) {
    const h = await harness(t), generate = h.hooks.agent;
    let repairs = 0;
    h.options.attempts = 3;
    h.options.attemptModels = ['luna-6-high', 'luna-6-high', 'sol-6.1-medium'];
    h.hooks.agent = async (...args) => {
      assert.equal(args[5].model, args[3] <= 2 ? 'gpt-6-luna' : 'gpt-6.1-sol');
      if (args[3] === 2) {
        assert.equal(args[5].operation, 'repair_artifacts');
        assert.match(args[4], /formatting repair failed|artifact fields/);
      }
      return { ...await generate(...args), children: [{ ...children[0], theorem_title: '' }, children[1]] };
    };
    h.hooks.repairAnswer = async (_target, _workspace, _dir, _attempt, _error, result) => {
      repairs++;
      if (failure === 'timeout') throw new Error('repair timeout');
      if (failure === 'changed proof') await writeFile(h.solution, source + '\n-- changed');
      return { ...result, children: [
        { ...children[0],
          ...(failure === 'still invalid' && { theorem_title: '' }),
          ...(failure === 'changed theorem' && { formal_statement: 'theorem Ns.right (n : Nat) : True := by sorry' }),
          ...(failure === 'changed preamble' && { preamble: 'open Classical' }),
          ...(failure === 'changed identity' && { theorem_name: 'Ns.different' }),
        }, ...(failure === 'changed count' ? [] : [children[1]]),
      ] };
    };
    assert.equal(await solveLeaf(h.client, target, {}, environment, h.options, h.hooks), 'READY', failure);
    assert.deepEqual(h.counts(), { agents: 3, creates: 0, submissions: 0 }, failure);
    assert.equal(repairs, 3, failure);
    assert.equal(await readFile(h.solution, 'utf8'), source, failure);
    assert.equal(JSON.parse(await readFile(h.statePath, 'utf8')).attempt_count, 3, failure);
  }
});

test('repair cannot change supporting definition bodies, including string literals', async t => {
  const h = await harness(t), generate = h.hooks.agent;
  h.options.attempts = 2;
  const stringDefinition = { ...definition, definition: 'def NatId : String := "original value"' };
  h.hooks.agent = async (...args) => ({ ...await generate(...args), explanation: '', definitions: [stringDefinition] });
  h.hooks.repairAnswer = async (_target, _workspace, _dir, _attempt, _error, result) => ({ ...result, explanation: answer.explanation,
    definitions: [{ ...stringDefinition, definition: 'def NatId : String := "replacement value"' }] });
  assert.equal(await solveLeaf(h.client, target, {}, environment, h.options, h.hooks), 'READY');
  assert.equal(h.counts().agents, 2); assert.equal(h.counts().creates, 0);
  assert.match(JSON.parse(await readFile(h.statePath, 'utf8')).feedback, /changed Lean code/);
});

test('Luna repairs prose in a sketch preamble after a reconstructed artifact fails compilation', async t => {
  const h = await harness(t), generate = h.hooks.agent, compile = h.hooks.command;
  h.options.attempts = 3;
  h.hooks.agent = async (...args) => {
    assert.equal(args[5].model, 'gpt-6-luna');
    if (args[3] === 2) {
      assert.equal(args[5].operation, 'repair_candidate');
      assert.match(args[4], /unexpected identifier/);
    }
    const result = await generate(...args);
    return args[3] === 1 ? { ...result, children: [{ ...children[0],
      preamble: 'Staged at Theorems/Thm_Ns_right.lean.' }, children[1]] } : result;
  };
  h.hooks.command = async (exe, args, options) => {
    if (args[0] === 'build' && (await readFile(join(h.workspace, 'Theorems/Thm_Ns_right.lean'), 'utf8')).startsWith('Staged at')) {
      await writeFile(options.log, 'unexpected identifier; expected command');
      throw new Error('lake exited with 1');
    }
    return compile(exe, args, options);
  };
  assert.equal(await solveLeaf(h.client, target, {}, environment, h.options, h.hooks), 'SKETCH_ACCEPTED');
  assert.deepEqual(h.counts(), { agents: 2, creates: 2, submissions: 1 });
  assert.doesNotMatch(await readFile(join(h.workspace, 'Theorems/Thm_Ns_right.lean'), 'utf8'), /Staged at/);
});

test('a real repair invocation uses Luna read-only even with a proof-model override', async t => {
  const h = await harness(t), generate = h.hooks.agent;
  const fake = join(h.root, 'fake-codex'), cliDir = join(fake, 'node_modules/@openai/codex/bin');
  await mkdir(cliDir, { recursive: true });
  const shim = join(fake, 'codex.cmd'); await writeFile(shim, 'test shim');
  await writeFile(join(cliDir, 'codex.js'), `
    const assert = require('node:assert/strict'), fs = require('node:fs');
    const args = process.argv.slice(2), prompt = fs.readFileSync(0, 'utf8');
    assert.equal(args[args.indexOf('--model') + 1], 'gpt-6-luna');
    assert.equal(args[args.indexOf('--sandbox') + 1], 'read-only');
    assert.ok(args.includes('model_reasoning_effort="low"'));
    assert.match(prompt, /Repair only/); assert.ok(prompt.includes('Preserve ready/kind'));
    assert.match(prompt, /copy Lean bodies and preambles verbatim/);
    assert.ok(!prompt.includes('Target data:'));
    assert.equal(fs.readFileSync(${JSON.stringify(h.solution)}, 'utf8'), ${JSON.stringify(source)});
    fs.writeFileSync(args[args.indexOf('--output-last-message') + 1], JSON.stringify(${JSON.stringify(answer)}));
  `);
  h.options.codex = shim; h.options.model = 'custom-proof-model'; h.options.agentTimeout = 10;
  h.hooks.agent = async (...args) => {
    assert.equal(args[5].model, 'custom-proof-model');
    return { ...await generate(...args), children: [{ ...children[0], theorem_title: '' }, children[1]] };
  };
  assert.equal(await solveLeaf(h.client, target, {}, environment, h.options, h.hooks), 'SKETCH_ACCEPTED');
  assert.equal(h.counts().agents, 1);
  assert.match(await readFile(join(h.options.runs, 'parent/prompt-1-repair.txt'), 'utf8'), /Validation error:/);
  assert.ok(await readFile(join(h.options.runs, 'parent/codex-1-repair.log'), 'utf8') !== undefined);
});

test('publication requests pin environment and preserve private visibility', async () => {
  const response = body => new Response(JSON.stringify(body));
  const client = new Client('key', async (url, options) => {
    if (url.pathname.endsWith('agent/refresh')) return response({ access_token: 'token', expires_at: Date.now() / 1000 + 3600 });
    const payload = JSON.parse(options.body);
    assert.equal(payload.env, rev); assert.equal(payload.private, true);
    assert.ok(url.pathname.endsWith('submit-problem') || url.pathname.endsWith('submit-definition'));
    return response({ job_id: 'job' });
  });
  await client.publish('problem', children[0], { ...target, visibility: 'private' });
  await client.publish('definition', definition, { ...target, visibility: 'private' });
});

test('the agent prompt and output contract offer both proofs and decompositions', async t => {
  const h = await harness(t), fake = join(h.root, 'fake-codex'), cliDir = join(fake, 'node_modules/@openai/codex/bin');
  await mkdir(cliDir, { recursive: true });
  const shim = join(fake, 'codex.cmd'); await writeFile(shim, 'test shim');
  await writeFile(join(cliDir, 'codex.js'), `
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    const args = process.argv.slice(2), prompt = fs.readFileSync(0, 'utf8');
    assert.match(prompt, /or prepare a proof-sketch decomposing it/);
    assert.match(prompt, /outer runner handles API operations, catalog retrieval, compilation, validation, publication, and retry scheduling/);
    assert.match(prompt, /each child formal_statement is one declaration/);
    assert.match(prompt, /exact full theorem_name/);
    assert.match(prompt, /No sorry, admit, new axioms/);
    assert.ok(!prompt.includes('this is a direct proof'));
    const schema = JSON.parse(fs.readFileSync(args[args.indexOf('--output-schema') + 1], 'utf8'));
    assert.deepEqual(schema.properties.kind.enum, ['proof', 'sketch', 'counterexample']);
    assert.match(prompt, /all needed|every needed positivity/);
    assert.match(prompt, /truncation at T keeps degrees strictly below T/);
    assert.match(prompt, /ALL target binders universally quantified INSIDE the negation/);
    assert.ok(schema.properties.children.items.properties.formal_statement);
    assert.ok(schema.properties.definitions.items.properties.definition);
    fs.writeFileSync(${JSON.stringify(h.solution)}, ${JSON.stringify(source)});
    fs.writeFileSync(args[args.indexOf('--output-last-message') + 1], JSON.stringify(${JSON.stringify(answer)}));
  `);
  h.options.codex = shim; h.options.agentTimeout = 10;
  const dir = join(h.options.runs, 'parent'); await mkdir(dir, { recursive: true });
  const result = await agent(target, h.workspace, dir, 1, '', h.options);
  assert.equal(result.kind, 'sketch'); assert.deepEqual(result.children, children);
});

test('publish polling handles pending, failures, and invalid statuses', async () => {
  assert.equal((await pollPublish({ request: async () => ({ status: 'COMPILING' }) }, 'job', 0)).status, 'COMPILING');
  assert.equal((await pollPublish({ request: async () => ({ status: 'FAILED' }) }, 'job', 0)).status, 'FAILED');
  await assert.rejects(pollPublish({ request: async () => ({ status: 'ACCEPTED' }) }, 'job', 0), /Invalid publish/);
});

test('scheduler discovers and solves new children after an accepted sketch', async t => {
  const h = await harness(t), worked = []; let stage = 0;
  h.hooks.frontier = async () => ({ root: { ...target, status: stage === 3 ? 'Proved' : 'Open' },
    leaves: stage === 0 ? [target] : children.toSorted((a,b) => a.theorem_name.localeCompare(b.theorem_name)).slice(stage - 1).map(row => ({ ...row, status: 'Open', theorem_id: row.theorem_name.replace('.', '_') })) });
  h.hooks.solveLeaf = async (_client, theorem) => { worked.push(theorem.theorem_name); return ++stage === 1 ? 'SKETCH_ACCEPTED' : 'ACCEPTED'; };
  h.client.request = async path => {
    if (path === 'environments') return { environments: [environment] };
    if (path.endsWith('/decompositions')) return { decompositions: [] };
    return { ...target, theorem_id: path.split('/')[1], theorem_name: path.endsWith('parent') ? target.theorem_name : children.find(c => path.endsWith(c.theorem_name.replace('.', '_'))).theorem_name };
  };
  const result = await runTarget(h.client, { root: 'parent', kind: 'mission', name: 'Example' }, h.options, h.hooks);
  assert.equal(result.completed, true); assert.deepEqual(worked, ['Ns.goal', 'Ns.left', 'Ns.right']);
});

test('real Lean accepts a reduction and rejects a definitionally equal child', { skip: !process.env.LEAN_TEST_BINARY }, async t => {
  const dir = await temporary(t), path = join(dir, 'Check.lean'), compiler = promisify(execFile);
  const compile = async (statements, solution, proposed) => {
    const code = typeCheckSource(target, 'Solutions.Sample', proposed).replace('import Solutions.Sample', statements + '\n' + solution);
    await writeFile(path, code); return compiler(process.env.LEAN_TEST_BINARY, ['-DautoImplicit=false', path], { cwd: dir });
  };
  const statements = children.map(row => row.formal_statement).join('\n');
  await compile(statements, source.slice(source.indexOf('theorem solution')), children);
  const copy = child('Ns.copy', 'n + 0 = n ∧ 0 + n = n');
  await assert.rejects(compile(copy.formal_statement,
    'theorem solution (n : Nat) : n + 0 = n ∧ 0 + n = n := by exact Ns.copy n', [copy]),
  error => error.stdout.includes('child merely restates target'));
});

test('real Lean verifies the whole sketch pipeline before mock publication and submission', { skip: !process.env.LEAN_TEST_BINARY }, async t => {
  const h = await harness(t), compiler = promisify(execFile);
  const generate = h.hooks.agent;
  h.hooks.agent = async (...args) => {
    const result = await generate(...args);
    result.children = [{ ...children[0], preamble: 'import Definitions.Def_NatId',
      formal_statement: 'theorem Ns.right (n : Nat) : NatId n + 0 = n := by sorry' }, wrappedChild(children[1])];
    result.definitions = [definition];
    await writeFile(h.solution, source.replace('Ns.right n', 'by simpa [NatId] using Ns.right n'));
    return result;
  };
  h.hooks.command = async (_exe, args, { log }) => {
    h.events.push(args[0] === 'build' ? 'build' : 'check');
    const compile = path => compiler(process.env.LEAN_TEST_BINARY,
      ['-DautoImplicit=false', '-o', path.replace(/\.lean$/, '.olean'), path],
      { cwd: h.workspace, env: { ...process.env, LEAN_PATH: h.workspace } });
    try {
      if (args[0] === 'build') {
        await compile(join(h.workspace, 'Definitions/Def_NatId.lean'));
        for (const name of ['Ns_right', 'Ns_left']) await compile(join(h.workspace, `Theorems/Thm_${name}.lean`));
        await compile(h.solution);
      } else await compiler(process.env.LEAN_TEST_BINARY, ['-DautoImplicit=false', args.at(-1)],
        { cwd: h.workspace, env: { ...process.env, LEAN_PATH: h.workspace } });
    } catch (error) { await writeFile(log, error.stdout ?? error.message); throw error; }
  };
  assert.equal(await solveLeaf(h.client, target, {}, environment, h.options, h.hooks), 'SKETCH_ACCEPTED');
  assert.deepEqual(h.counts(), { agents: 1, creates: 3, submissions: 1 });
});
