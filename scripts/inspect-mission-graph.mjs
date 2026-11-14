#!/usr/bin/env node
// Read-only server inspection. Also accepts a saved snapshot for offline replay.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { Client } from '../prove2me.mjs';
import { save } from '../runner-state.mjs';
import { cyclicComponents } from '../graph-cycles.mjs';
import { acceptedReduction, usableReduction, workFrontier } from '../work-policy.mjs';

export function summarizeSnapshot(snapshot) {
  const nodes = new Map((snapshot.nodes ?? []).map(n => [n.theorem_id, n]));
  const definitions = new Set((snapshot.nodes ?? []).filter(n => n.status === 'Definition').map(n => n.theorem_id));
  const expanded = new Set(), reductions = [], conflicts = [];
  for (const [path, data] of Object.entries(snapshot.responses)) {
    const id = decodeURIComponent(path.split('/')[1]); expanded.add(id);
    for (const reduction of data.decompositions) {
      if (reduction.submission_id != null) reductions.push({ ...reduction, parent: id });
      for (const child of reduction.children) {
        if (child.definition_id) definitions.add(child.definition_id);
        else if (child.theorem_id) {
          const old = nodes.get(child.theorem_id);
          if (old && (old.status !== child.status || !!old.deprecated_at !== !!child.deprecated_at)) {
            conflicts.push({ id: child.theorem_id, statuses: [old.status, child.status] });
          }
          if (!old) nodes.set(child.theorem_id, child);
        }
      }
    }
    nodes.set(id, { ...nodes.get(id), reductions: data.decompositions });
  }
  const active = reductions.filter(acceptedReduction), edges = new Map();
  for (const reduction of active) {
    const children = edges.get(reduction.parent) ?? [];
    children.push(...reduction.children.filter(c => c.theorem_id).map(c => c.theorem_id));
    edges.set(reduction.parent, children);
  }
  const theorems = [...expanded].map(id => nodes.get(id));
  const blocked = active.filter(r => !usableReduction(r, nodes));
  const root = nodes.get(snapshot.root_id);
  const frontier = workFrontier({ root, nodes: [...nodes.values()], leaves: [] });
  const repairComponents = new Map(frontier.tasks.filter(t => t.cycle_members)
    .map(t => [t.cycle_members.map(n => n.theorem_id).join(','), t.cycle_members]));
  return { root_id: snapshot.root_id, captured_at: snapshot.captured_at, complete: snapshot.complete,
    theorem_count: theorems.length, definition_count: definitions.size,
    statuses: Object.fromEntries([...new Set(theorems.map(n => n.status))]
      .map(status => [status, theorems.filter(n => n.status === status).length])),
    active_reductions: active.length, deprecated_reductions: reductions.filter(r => r.deprecated_at).length,
    blocked_reductions: blocked.length, blocked_parents: new Set(blocked.map(r => r.parent)).size,
    cycles: cyclicComponents(expanded, edges).map(component => component.map(id => ({
      theorem_id: id, theorem_name: nodes.get(id).theorem_name, status: nodes.get(id).status }))),
    cycle_repair_components: [...repairComponents.values()],
    frontier_tasks: { leaves: frontier.tasks.filter(t => t.task_kind === 'leaf').length,
      invalidated_parents: frontier.tasks.filter(t => t.task_kind === 'parent' && !t.cycle_members).length,
      cycle_members: frontier.tasks.filter(t => t.cycle_members).length },
    status_conflicts: conflicts };
}

async function main() {
  const { values } = parseArgs({ options: { root: { type: 'string' }, snapshot: { type: 'string' }, out: { type: 'string' } } });
  if (values.snapshot) {
    if (values.root || values.out) throw new Error('--snapshot is offline; use it without --root/--out');
    console.log(JSON.stringify(summarizeSnapshot(JSON.parse(await readFile(values.snapshot, 'utf8'))), null, 2));
    return;
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(values.root ?? '')) throw new Error('Supply --root THEOREM_ID or --snapshot FILE');
  const project = fileURLToPath(new URL('..', import.meta.url));
  const out = values.out ?? resolve(project, '.runs', 'diagnostics', `mission-graph-${values.root}.json`);
  const key = JSON.parse(await readFile(resolve(project, 'credentials.json'), 'utf8')).api_key;
  const client = new Client(key), root = await client.request(`theorems/${values.root}`);
  const nodes = new Map([[root.theorem_id, root]]), queue = [root.theorem_id], responses = {};
  const started_at = new Date().toISOString();
  let snapshot;
  // Unlike solver discovery, expand proved and disproved nodes too: this is an audit.
  for (let offset = 0; offset < queue.length;) {
    const batch = queue.slice(offset, offset + 4);
    const results = await Promise.allSettled(batch.map(id => client.request(`theorems/${encodeURIComponent(id)}/decompositions`)));
    for (const [i, result] of results.entries()) {
      if (result.status === 'rejected') throw result.reason;
      responses[`theorems/${encodeURIComponent(batch[i])}/decompositions`] = result.value;
      for (const reduction of result.value.decompositions) for (const child of reduction.children) if (child.theorem_id && !nodes.has(child.theorem_id)) {
        if (nodes.size >= 10000) throw new Error('Audit exceeds 10000 theorems; choose a smaller root');
        nodes.set(child.theorem_id, child); queue.push(child.theorem_id);
      }
    }
    offset += batch.length;
    snapshot = { started_at, captured_at: new Date().toISOString(), root_id: root.theorem_id,
      complete: offset >= queue.length, nodes: [...nodes.values()], responses };
    await save(out, snapshot);
    if (offset % 40 === 0 || snapshot.complete) console.error(`Expanded ${offset}/${queue.length} theorems`);
  }
  console.log(JSON.stringify(summarizeSnapshot(snapshot), null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
