import test from 'node:test';
import assert from 'node:assert/strict';
import { cyclicComponents } from '../graph-cycles.mjs';
import { scoreWork } from '../work-policy.mjs';

const node = (id, reductions = [], status = 'Open') => ({ theorem_id: id, theorem_name: id, status, reductions });
const reduction = (...ids) => ({ submission_id: ids.join('-') || 'empty',
  children: ids.map(theorem_id => ({ theorem_id, status: 'Open' })) });
const graph = (...nodes) => ({ root: nodes[0], nodes, leaves: [] });

test('cycle detection distinguishes shared dependencies, self loops, and independent components', () => {
  const deps = new Map([['root', ['a', 'b']], ['a', ['shared']], ['b', ['shared']],
    ['shared', []], ['x', ['y']], ['y', ['x', 'unknown']], ['self', ['self']]]);
  assert.deepEqual(cyclicComponents(deps.keys(), deps), [['self'], ['x', 'y']]);
});

test('cycle detection handles a long dependency chain without recursive stack overflow', () => {
  const deps = new Map(Array.from({ length: 12000 }, (_, i) => [String(i), i ? [String(i - 1)] : []]));
  assert.deepEqual(cyclicComponents(deps.keys(), deps), []);
});

test('a cycle independent of other leaves produces repair tasks with durable evidence', () => {
  const g = graph(node('root', [reduction('a', 'leaf')]), node('a', [reduction('b')]),
    node('b', [reduction('a')]), node('leaf'));
  const tasks = scoreWork(g);
  assert.deepEqual(new Set(tasks.map(t => t.theorem_id)), new Set(['a', 'b', 'leaf']));
  for (const task of tasks.filter(t => t.theorem_id !== 'leaf')) {
    assert.equal(task.selection_reason, 'cyclic_reduction');
    assert.equal(task.operation, 'reconsider_reduction');
    assert.deepEqual(task.cycle_members.map(n => n.theorem_id), ['a', 'b']);
  }
  const state = { status: 'SKETCH_ACCEPTED', job_status: 'DONE', submission_id: 'b' };
  assert.ok(scoreWork(g, new Map([['a', state]])).some(t => t.theorem_id === 'a'),
    'an earlier accepted sketch must not suppress cycle repair');
  assert.deepEqual(scoreWork(g, new Map([['a', { job_status: 'ACTIVE' }]])).map(t => t.theorem_id), ['leaf'],
    'do not dispatch another member while a component repair is active');
});

test('an OR escape grounds a cycle, while an AND sibling cannot ground it', () => {
  const a = node('a', [reduction('root'), reduction('leaf')]);
  const g = graph(node('root', [reduction('a')]), a, node('leaf'));
  assert.deepEqual(scoreWork(g).map(t => t.theorem_id), ['leaf']);
  a.reductions = [reduction('root', 'leaf')];
  assert.deepEqual(new Set(scoreWork(g).filter(t => t.selection_reason === 'cyclic_reduction')
    .map(t => t.theorem_id)), new Set(['a', 'root']));
});

test('proved and invalidated alternatives do not create unnecessary cycle tasks', () => {
  const a = node('a', [reduction('root'), reduction('done')]);
  const g = graph(node('root', [reduction('a')]), a, node('done', [], 'Proved'));
  assert.deepEqual(scoreWork(g), [], 'wait for an already satisfied alternative to propagate');
  g.nodes[2].status = 'Disproved';
  a.reductions[0].deprecated_at = '2026-10-17';
  assert.deepEqual(scoreWork(g).map(t => [t.theorem_id, t.selection_reason]), [['a', 'invalidated_reduction']]);
});
