import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeSnapshot } from '../scripts/inspect-mission-graph.mjs';

test('mission audit includes completed paths, separates definitions, and exposes blocked and circular reductions', () => {
  const node = (id, status = 'Open') => ({ theorem_id: id, theorem_name: id, status });
  const root = node('root'), a = node('a'), dead = node('dead', 'Disproved'), done = node('done', 'Proved');
  const reduction = (id, children, extra = {}) => ({ submission_id: id, children, ...extra });
  const snapshot = { root_id: 'root', complete: true, nodes: [root, a, dead, done, node('display-orphan')], responses: {
    'theorems/root/decompositions': { decompositions: [reduction('loop', [a]), reduction('blocked', [dead]),
      reduction(null, [{ definition_id: 'definition' }]), reduction('obsolete', [done], { deprecated_at: 'yesterday' })] },
    'theorems/a/decompositions': { decompositions: [reduction('back', [root])] },
    'theorems/dead/decompositions': { decompositions: [] },
    'theorems/done/decompositions': { decompositions: [] },
  } };
  const audit = summarizeSnapshot(snapshot);
  assert.equal(audit.theorem_count, 4, 'display-only orphans are not counted');
  assert.deepEqual(audit.statuses, { Open: 2, Disproved: 1, Proved: 1 });
  assert.equal(audit.definition_count, 1);
  assert.equal(audit.active_reductions, 3); assert.equal(audit.deprecated_reductions, 1);
  assert.equal(audit.blocked_reductions, 1); assert.equal(audit.blocked_parents, 1);
  assert.deepEqual(audit.cycles.map(g => g.map(n => n.theorem_id)), [['a', 'root']]);
  assert.equal(audit.frontier_tasks.cycle_members, 2);
  assert.deepEqual(audit.status_conflicts, []);
  snapshot.responses['theorems/a/decompositions'].decompositions[0].children = [node('root', 'Proved')];
  assert.equal(summarizeSnapshot(snapshot).status_conflicts.length, 1, 'changing captures must be visible');
});
