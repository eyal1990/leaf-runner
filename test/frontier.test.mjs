import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverFrontier, openLeaves, selectCandidate } from '../work-selection.mjs';
import { ApiError } from '../prove2me.mjs';

const node = (id, status = 'Open', extra = {}) => ({ theorem_id: id, theorem_name: id, status, deprecated_at: null, ...extra });
const reduction = (children, extra = {}) => ({ submission_id: 'sketch', children, deprecated_at: null, ...extra });
function fixture(root, decompositions) {
  const calls = [], messages = [];
  return { calls, messages, report: message => messages.push(message), request: async path => {
    calls.push(path);
    if (path === `theorems/${root.theorem_id}`) return root;
    const match = path.match(/^theorems\/([^/]+)\/decompositions$/);
    assert.ok(match, `Unexpected request: ${path}`);
    assert.ok(Object.hasOwn(decompositions, match[1]), `Unexpected traversal of ${match[1]}`);
    return { decompositions: decompositions[match[1]] };
  } };
}

test('local frontier traverses all alternative reductions and ranks distinct cascading ancestors', async () => {
  const client = fixture(node('root'), {
    root: [reduction([node('a'), node('proved', 'Proved'), { definition_id: 'def' }]),
      reduction([node('b'), node('c')]), reduction([node('a'), node('a')]),
      reduction([node('dead', 'Disproved'), node('d')]),
      reduction([node('deprecated', 'Open', { deprecated_at: 'yesterday' })]),
      reduction([node('hidden')], { deprecated_at: 'yesterday' }),
      reduction([node('structural')], { submission_id: null }),
      reduction([node('failed')], { status: 'FAILED' })],
    a: [reduction([node('leaf')])], b: [reduction([node('leaf')])], c: [], d: [], leaf: [],
  });
  assert.deepEqual(await openLeaves(client, 'root'), [
    { theorem_id: 'leaf', theorem_name: 'leaf', status: 'Open', closability: 3 },
    { theorem_id: 'c', theorem_name: 'c', status: 'Open', closability: 0 },
  ]);
  assert.equal(new Set(client.calls).size, client.calls.length, 'shared paths are requested once');
  assert.ok(client.messages.some(message => message.includes('Discovered 2 open leaves')));
});

test('local frontier requires all siblings before crediting a closure and handles diamonds', async () => {
  const client = fixture(node('root'), {
    root: [reduction([node('a'), node('b')])], a: [reduction([node('x')])], b: [reduction([node('x'), node('y')])], x: [], y: [],
  });
  assert.deepEqual((await openLeaves(client, 'root')).map(n => [n.theorem_id, n.closability]), [['x', 1], ['y', 0]]);
});

test('local frontier stops at proved/deprecated roots and recognizes standalone open roots', async () => {
  for (const root of [node('root', 'Proved'), node('root', 'Disproved'), node('root', 'Open', { deprecated_at: 'yesterday' })]) {
    const client = fixture(root, {});
    assert.deepEqual(await openLeaves(client, 'root'), []);
    assert.equal(client.calls.length, 1);
  }
  const client = fixture(node('root'), { root: [reduction([{ definition_id: 'def' }], { submission_id: null })] });
  assert.deepEqual(await openLeaves(client, 'root'), [{ theorem_id: 'root', theorem_name: 'root', status: 'Open', closability: 0 }]);
});

test('cycles terminate and an alternative reduction can close a cycle', async () => {
  const client = fixture(node('root'), { root: [reduction([node('a')])], a: [reduction([node('root')]), reduction([node('leaf')])], leaf: [] });
  assert.deepEqual((await openLeaves(client, 'root')).map(n => [n.theorem_id, n.closability]), [['leaf', 2]]);
  const cycle = fixture(node('root'), { root: [reduction([node('a')])], a: [reduction([node('root')])] });
  const graph = await discoverFrontier(cycle, 'root');
  assert.deepEqual(graph.leaves, []);
  const selected = selectCandidate(graph);
  assert.equal(selected.task_kind, 'parent');
  assert.equal(selected.selection_reason, 'cyclic_reduction');
  assert.equal(selected.operation, 'reconsider_reduction');
  assert.deepEqual(selected.cycle_members.map(n => n.theorem_id), ['a', 'root']);
  assert.equal(cycle.calls.length, 3);
});

test('a stale already-satisfied reduction is not credited to an unrelated leaf', async () => {
  const client = fixture(node('root'), { root: [reduction([node('proved', 'Proved')]), reduction([node('leaf')])], leaf: [] });
  assert.deepEqual(await openLeaves(client, 'root'), []);
});

test('malformed or changing responses fail instead of silently returning an incomplete frontier', async () => {
  await assert.rejects(openLeaves({ request: async () => node('wrong') }, 'root'), /root response/);
  await assert.rejects(openLeaves({ request: async path => path.endsWith('/decompositions') ? {} : node('root') }, 'root'), /Invalid frontier decompositions/);
  await assert.rejects(openLeaves(fixture(node('root'), { root: [{ submission_id: 'sketch' }] }), 'root'), /Invalid frontier reduction/);
  await assert.rejects(openLeaves(fixture(node('root'), { root: [{ children: [] }] }), 'root'), /Invalid frontier reduction/);
  await assert.rejects(openLeaves(fixture(node('root'), { root: [reduction([{ theorem_id: 'missing-status' }])] }), 'root'), /Invalid frontier theorem/);
  await assert.rejects(openLeaves(fixture(node('root'), { root: [reduction([node('a')]), reduction([node('a', 'Proved')])] }), 'root'), /changed during frontier/);
  const error = new ApiError(403, '/decompositions');
  await assert.rejects(openLeaves({ request: async path => { if (path.endsWith('/decompositions')) throw error; return node('root'); } }, 'root'), e => e === error);
});

test('local discovery bounds concurrent reads and deduplicates wide shared subtrees', async () => {
  const ids = Array.from({ length: 12 }, (_, i) => `branch-${i}`);
  const client = fixture(node('root'), Object.fromEntries([
    ['root', [reduction(ids.map(id => node(id)))]],
    ...ids.map(id => [id, [reduction([node('leaf')])]]), ['leaf', []],
  ]));
  let active = 0, maximum = 0;
  const request = client.request;
  client.request = async path => {
    active++; maximum = Math.max(maximum, active);
    try { await new Promise(resolve => setTimeout(resolve, 1)); return await request(path); }
    finally { active--; }
  };
  assert.equal((await openLeaves(client, 'root'))[0].closability, 13);
  assert.equal(maximum, 4);
  assert.equal(client.calls.length, 15);
});
