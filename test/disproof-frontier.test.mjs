import test from 'node:test';
import assert from 'node:assert/strict';
import { workFrontier, scoreWork } from '../work-policy.mjs';
import { applyGraphUpdates } from '../graph-updates.mjs';
import { discoverFrontier, WorkSelection } from '../work-selection.mjs';
import { buildMissionView } from '../mission-control-data.mjs';

const node = (id, status = 'Open') => ({ theorem_id: id, theorem_name: id, status, reductions: [] });
const sketch = (id, ...children) => ({ submission_id: id, children });
function fixture() {
  const a = node('A'), b = node('B'), c = node('C'), d = node('D');
  a.reductions = [sketch('old', b, c)];
  return { root: a, nodes: [a, b, c, d], leaves: [b, c] };
}
const ids = rows => rows.map(row => row.theorem_id).sort();
function assertFrontier(graph, expected) {
  assert.deepEqual(ids(workFrontier(graph).tasks), expected);
  assert.deepEqual(ids(scoreWork(graph)), expected);
  const view = buildMissionView({ mission: { target: { root: 'A' } }, graph, jobs: [] });
  assert.deepEqual(view.frontier.leafIds.toSorted(), expected);
  assert.equal(view.frontier.leaves, expected.length);
}

test('a child disproof replaces its entire failed sketch with the parent in counts and scheduling', () => {
  const original = fixture();
  assertFrontier(original, ['B', 'C']);
  const graph = applyGraphUpdates(original, [{ theorem_id: 'C', status: 'Disproved' }]);
  assertFrontier(graph, ['A']);
  assert.deepEqual(ids(graph.leaves), ['A']);
  assert.deepEqual([...workFrontier(graph).needed], ['A']);
  assert.equal(scoreWork(graph)[0].operation, 'reconsider_reduction');
  assert.equal(original.nodes.find(n => n.theorem_id === 'C').status, 'Open');

  graph.root.reductions.push(sketch('new', graph.nodes.find(n => n.theorem_id === 'B'), graph.nodes.find(n => n.theorem_id === 'D')));
  assertFrontier(graph, ['B', 'D']);
});

test('a sibling shared by another viable sketch stays actionable', () => {
  const graph = fixture();
  graph.root.reductions.push(sketch('alternative', graph.nodes[1], graph.nodes[3]));
  assertFrontier(applyGraphUpdates(graph, [{ theorem_id: 'C', status: 'Disproved' }]), ['B', 'D']);
});

test('a failed nested sketch drops sibling descendants while independent branches remain', () => {
  const graph = fixture(), x = node('X'), e = node('E'), root = node('root');
  graph.nodes[1].reductions = [sketch('subtree', x)];
  root.reductions = [sketch('outer', graph.root, e)];
  graph.nodes.push(x, e, root); graph.root = root; graph.leaves = [x, graph.nodes[2], e];
  const updated = applyGraphUpdates(graph, [{ theorem_id: 'C', status: 'Disproved' }]);
  assertFrontier(updated, ['A', 'E']);
  assert.deepEqual([...workFrontier(updated).needed].sort(), ['A', 'E', 'root']);
});

test('legacy recovery skips irrelevant prepared work but can reconcile an issued request', () => {
  const graph = applyGraphUpdates(fixture(), [{ theorem_id: 'C', status: 'Disproved' }]);
  const b = graph.nodes.find(n => n.theorem_id === 'B');
  Object.assign(b, { job_status: 'ACTIVE', work_status: 'PREPARED' });
  assert.equal(new WorkSelection().next(graph).leaf.theorem_id, 'A');
  b.work_status = 'SUBMISSION_UNKNOWN';
  assert.equal(new WorkSelection().next(graph).kind, 'resume');
});

test('initial discovery uses the same frontier for a failed sketch and its replacement', async () => {
  for (const replacement of [false, true]) {
    const graph = fixture(); graph.nodes[2].status = 'Disproved';
    if (replacement) graph.root.reductions.push(sketch('new', graph.nodes[1], graph.nodes[3]));
    const found = await discoverFrontier({ request: async path => {
      if (path === 'theorems/A') return graph.root;
      const id = path.split('/')[1];
      return { decompositions: graph.nodes.find(n => n.theorem_id === id).reductions };
    } }, 'A');
    const expected = replacement ? ['B', 'D'] : ['A'];
    assert.deepEqual(ids(found.leaves), expected);
    assertFrontier(found, expected);
  }
});
