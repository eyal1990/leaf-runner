// Iterative Kosaraju traversal: mission graphs can exceed the JS call-stack limit.
// Edges point from a theorem to its prerequisites. Unknown nodes are excluded.
export function cyclicComponents(ids, dependencies) {
  const vertices = new Set(ids), reverse = new Map([...vertices].map(id => [id, []]));
  for (const id of vertices) for (const child of dependencies.get(id) ?? []) {
    if (vertices.has(child)) reverse.get(child).push(id);
  }
  const visited = new Set(), order = [];
  for (const root of vertices) {
    const stack = [[root, false]];
    while (stack.length) {
      const [id, expanded] = stack.pop();
      if (expanded) { order.push(id); continue; }
      if (visited.has(id)) continue;
      visited.add(id); stack.push([id, true]);
      for (const child of dependencies.get(id) ?? []) {
        if (vertices.has(child) && !visited.has(child)) stack.push([child, false]);
      }
    }
  }
  const assigned = new Set(), cycles = [];
  for (const root of order.reverse()) {
    if (assigned.has(root)) continue;
    const component = [], stack = [root]; assigned.add(root);
    while (stack.length) {
      const id = stack.pop(); component.push(id);
      for (const parent of reverse.get(id)) if (!assigned.has(parent)) {
        assigned.add(parent); stack.push(parent);
      }
    }
    if (component.length > 1 || [...(dependencies.get(root) ?? [])].includes(root)) {
      cycles.push(component.sort());
    }
  }
  return cycles.sort((a, b) => a[0].localeCompare(b[0]));
}
