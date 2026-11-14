// Target resolution, frontier discovery/ranking, and work scheduling policy.
// Platform data is refreshed independently of persistent local attempt history.
import { ApiError, transientReadError } from './api-errors.mjs';
import { join } from 'node:path';
import { save, targetFingerprint } from './runner-state.mjs';
import { JobStore, JobPersistenceError, transaction, readRecord } from './job-store.mjs';
import { selectWork, workFrontier } from './work-policy.mjs';
import { applyGraphUpdates, graphOutcome, reconciledUpdate, readGraphUpdate, sameGraphTarget, GraphUpdatePending } from './graph-updates.mjs';
export { scoreWork, selectWork } from './work-policy.mjs';

const enc = encodeURIComponent;
const idOf = row => row.theorem_id ?? row.definition_id ?? row.id;
const normalize = text => text.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
const isUuid = text => /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(text ?? '');

export const retryFrontierError = error => transientReadError(error) || error.message.includes('changed during frontier discovery');
// A theorem may temporarily disappear while the server updates its graph.
// Keep this policy at the graph-read boundary, away from publication/upload errors.
export const retryGraphRefreshError = error => retryFrontierError(error) || error instanceof ApiError && error.status === 404;

const recoverable = new Set(['SUBMITTING', 'SUBMISSION_UNKNOWN', 'PENDING',
  'PUBLISH_PENDING', 'PUBLISH_UNKNOWN', 'PUBLISHING', 'PUBLICATIONS_READY', 'PREPARED', 'COUNTEREXAMPLE']);
async function readSaved(path) {
  return readRecord(path);
}

// Replace the platform snapshot, retaining history even for nodes that disappear
// from this root. Leaf state files are authoritative and shared across roots.
export async function buildGraph(client, rootId, { runs, readOnly = false }, discover = discoverFrontier) {
  const frontier = await discover(client, rootId);
  const path = join(runs, 'graphs', `${enc(rootId)}.json`);
  const previous = await readSaved(path);
  const savedStates = {};
  const attempts = new Map(Object.entries(previous?.attempts ?? {}));
  const nodes = frontier.nodes ?? [...new Map([frontier.root, ...frontier.leaves]
    .map(node => [idOf(node), node])).values()];
  for (let offset = 0; offset < nodes.length; offset += 32) {
    const batch = nodes.slice(offset, offset + 32);
    const states = await Promise.allSettled(batch.map(node => readSaved(join(runs, idOf(node), 'state.json'))));
    for (const [index, result] of states.entries()) {
      if (result.status === 'rejected') throw result.reason;
      const id = idOf(batch[index]), state = result.value;
      if (state) savedStates[id] = state;
      if (state) {
        if (state.schema_version !== undefined) await new JobStore(runs).read(id);
        if (state.theorem_id !== id) throw new Error('Saved state identity mismatch');
        const count = state.attempt_count ?? state.attempt ?? 0;
        attempts.set(id, { attempt_count: count,
          attempts_by_model: state.attempts_by_model ?? (count ? { unknown: count } : {}), work_status: state.status,
          job_status: state.job_status, job_id: state.job_id, root_id: state.root_id,
          next_poll_at: state.next_poll_at, stage: state.stage });
      }
    }
  }
  const annotate = node => ({ ...node, attempt_count: 0, attempts_by_model: {}, ...attempts.get(idOf(node)) });
  const graph = { ...frontier, root: annotate(frontier.root), nodes: nodes.map(annotate),
    leaves: frontier.leaves.map(annotate), states: savedStates, attempts: Object.fromEntries(attempts), schema_version: 1,
    graph_version: (previous?.graph_version ?? 0) + 1, updated_at: new Date().toISOString() };
  graph.snapshot_ref = path;
  if (!readOnly) {
    await new JobStore(runs).observeGraph(graph);
    for (const id of Object.keys(savedStates)) savedStates[id] = await new JobStore(runs).read(id);
    await transaction(runs, () => save(path, graph));
  }
  return graph;
}

// Fresh graphs and durable history supply continuous scored work.
export class WorkSelection {
  #visited = new Set();
  visits = 0;

  constructor(options = {}) {
    const { runs, attempts, model } = options;
    this.options = options;
    this.runs = runs;
    this.store = runs ? new JobStore(runs) : null;
    this.attempts = attempts; this.model = model;
    this.requestedGeneration = 0; this.committedGeneration = 0;
    this.requiredGeneration = 0;
    this.updates = []; this.graphWriter = Promise.resolve();
  }

  requestGraphRefresh(reason = 'requested', { background = false } = {}) {
    this.lastRefreshReason = reason;
    this.request = transaction(this.runs, () => {
      this.requestedGeneration++;
      if (!background) this.requiredGeneration = this.requestedGeneration;
    });
    return this.request;
  }

  get canSelect() { return !!this.graph && this.committedGeneration >= this.requiredGeneration; }

  writeGraph(action) {
    const result = this.graphWriter.then(async () => {
      this.graphWriting = true;
      try { return await action(); }
      catch (error) {
        if (error.code || error instanceof SyntaxError) throw new JobPersistenceError(`Cannot persist graph update: ${error.message}`, { cause: error });
        throw error;
      } finally { this.graphWriting = false; }
    });
    this.graphWriter = result.catch(() => {});
    return result;
  }

  async loadUpdates(rootId) {
    if (this.updatePath) {
      if (this.updateRootId !== rootId) throw new JobPersistenceError('Graph update root identity changed');
      return;
    }
    this.updatePath = join(this.runs, 'graph-updates', `${enc(rootId)}.json`);
    const journal = await readSaved(this.updatePath);
    if (journal && (journal.schema_version !== 1 || journal.root_id !== rootId || !Array.isArray(journal.events) ||
      journal.events.some(e => !e || typeof e.id !== 'string' || typeof e.theorem_id !== 'string' ||
        !['status', 'sketch', 'inspect'].includes(e.kind) || typeof e.pending !== 'boolean' ||
        e.pending && !Number.isFinite(e.next_check_at) || e.nodes !== undefined && !Array.isArray(e.nodes)))) {
      throw new JobPersistenceError('Invalid graph update journal');
    }
    this.updates = journal?.events ?? [];
    this.updateRootId = rootId;
  }

  saveUpdates() {
    return save(this.updatePath, { schema_version: 1, root_id: this.updateRootId, events: this.updates });
  }

  async installUpdates() {
    if (!this.graph) return;
    const frontier = applyGraphUpdates(this.graph, this.updates);
    this.graph = await buildGraph(null, this.updateRootId, { runs: this.runs }, async () => frontier);
  }

  async recordOutcome(job, rootId) {
    const event = graphOutcome(job);
    if (!event) return false;
    return this.writeGraph(async () => {
      await this.loadUpdates(rootId);
      if (this.updates.some(e => e.id === event.id)) return false;
      const node = this.graph?.nodes?.find(n => n.theorem_id === event.theorem_id);
      if (node && event.status && !sameGraphTarget(node, event)) {
        event.pending = true; event.verify_identity = true;
      }
      this.updates.push(event);
      await this.saveUpdates();
      if (!event.pending) await this.installUpdates();
      return true;
    });
  }

  async confirmRoot(root) {
    return this.writeGraph(async () => {
      if (root.theorem_id !== this.graph.root.theorem_id || !['Open', 'Proved', 'Disproved'].includes(root.status) || root.deprecated_at) {
        throw new Error(`Target root is ${root.status}${root.deprecated_at ? ' and deprecated' : ''}; the requested target is not proved`);
      }
      if (root.status === 'Open') return;
      this.updates = this.updates.filter(e => e.theorem_id !== root.theorem_id);
      this.updates.push({ id: `${root.theorem_id}:confirmed:${root.status}`, theorem_id: root.theorem_id,
        kind: 'status', status: root.status, pending: false,
        target_hash: root.formal_statement ? targetFingerprint(root) : undefined,
        previous_target_hash: this.graph.root.formal_statement ? targetFingerprint(this.graph.root) : undefined,
        nodes: [{ ...this.graph.root, ...root }] });
      await this.saveUpdates(); await this.installUpdates(); this.rootConfirmed = true;
    });
  }

  async refreshUpdates(client, { now = Date.now, retryMs = 30000, signal } = {}) {
    const pending = this.updates.filter(e => e.pending && e.next_check_at <= now());
    for (const event of pending) {
      signal?.throwIfAborted();
      let patch;
      try { patch = await readGraphUpdate(client, event, this.graph); }
      catch (error) {
        if (!(error instanceof GraphUpdatePending) && !retryGraphRefreshError(error)) throw error;
        await this.writeGraph(async () => {
          const current = this.updates.find(e => e.id === event.id);
          if (!current?.pending) return;
          current.next_check_at = now() + retryMs; current.last_error = error.message;
          await this.saveUpdates();
        });
        continue;
      }
      signal?.throwIfAborted();
      await this.writeGraph(async () => {
        const current = this.updates.find(e => e.id === event.id);
        if (!current?.pending) return;
        const previous = this.graph.nodes.find(n => n.theorem_id === current.theorem_id);
        Object.assign(current, patch, { previous_target_hash: previous?.formal_statement ? targetFingerprint(previous) : current.target_hash,
          pending: false }); delete current.last_error;
        await this.saveUpdates(); await this.installUpdates();
      });
    }
  }

  async buildGraph(client, rootId, discover) {
    this.refreshArguments = [client, rootId, discover];
    if (!this.requestedGeneration || this.requestedGeneration === this.committedGeneration && !this.refresh) {
      await this.requestGraphRefresh('explicit refresh');
    }
    if (this.refresh) return this.refresh;
    this.refresh = (async () => {
      for (;;) {
        await this.request;
        const generation = this.requestedGeneration;
        const frontier = await (discover ?? discoverFrontier)(client, rootId);
        await this.writeGraph(async () => {
          await this.loadUpdates(rootId);
          for (const event of this.updates) {
            const node = (frontier.nodes ?? [frontier.root, ...frontier.leaves]).find(n => n.theorem_id === event.theorem_id);
            if (node && event.status && (!sameGraphTarget(node, event) ||
                node.status !== 'Open' && node.status !== event.status || node.deprecated_at)) {
              event.pending = true; event.verify_identity = true; event.next_check_at = 0;
            }
          }
          // Keep events a scan did not observe. This also recovers an outcome
          // whose journal committed just before a crash or snapshot replacement.
          this.updates = this.updates.filter(event => !reconciledUpdate(frontier, event));
          const merged = applyGraphUpdates(frontier, this.updates);
          this.graph = await buildGraph(client, rootId, { runs: this.runs }, async () => merged);
          await this.saveUpdates();
          this.rootConfirmed = ['Proved', 'Disproved'].includes(frontier.root.status);
          this.committedGeneration = generation;
        });
        await this.request;
        if (this.committedGeneration === this.requestedGeneration) return this.graph;
      }
    })();
    try { return await this.refresh; }
    finally { this.refresh = null; }
  }

  selectCandidate(frontier = this.graph) {
    return this.next(frontier, false, false).leaf ?? null;
  }

  async getWork(options = {}) {
    const waitRequired = async pending => {
      if (!options.signal) return pending;
      options.signal.throwIfAborted();
      let abort;
      try {
        return await Promise.race([pending, new Promise((_resolve, reject) => {
          abort = () => reject(options.signal.reason);
          options.signal.addEventListener('abort', abort, { once: true });
        })]);
      } finally { options.signal.removeEventListener('abort', abort); }
    };
    for (;;) {
      options.signal?.throwIfAborted();
      await waitRequired(this.request);
      if (this.refresh && !(options.allowCommitted && this.canSelect)) await waitRequired(this.refresh);
      else if (this.requestedGeneration !== this.committedGeneration && this.refreshArguments && !(options.allowCommitted && this.canSelect)) {
        await waitRequired(this.buildGraph(...this.refreshArguments));
      }
      if (!this.store || !this.graph) throw new Error('Durable selection requires a store and refreshed graph');
      await waitRequired(this.graphWriter);
      const candidateGraph = this.graph;
      let dirty = false;
      const claimed = await this.store.claim(candidateGraph, { ...this.options, attempts: this.attempts, model: this.model, ...options,
        excluded: new Set([...(options.excluded ?? []), ...this.updates.filter(e => e.pending).map(e => e.theorem_id)]),
        canClaim: index => {
          options.signal?.throwIfAborted();
          dirty = this.graphWriting || this.graph !== candidateGraph ||
            (options.allowCommitted ? !this.canSelect : this.requestedGeneration !== this.committedGeneration);
          return !dirty && (!options.canClaim || options.canClaim(index));
        } });
      if (!dirty) return claimed;
    }
  }

  next(frontier, resetRecovery = true, includeRecovery = true) {
    const { root, leaves } = frontier;
    if (root.deprecated_at || !['Open', 'Proved', 'Disproved'].includes(root.status)) {
      throw new Error(`Target root is ${root.status}${root.deprecated_at ? ' and deprecated' : ''}; the requested target is not proved`);
    }
    // Only a refreshed root can confirm completion.
    if (root.status === 'Proved') return { kind: 'complete' };
    if (root.status === 'Disproved') return { kind: 'disproved' };
    if (includeRecovery) {
      const { needed } = workFrontier(frontier);
      const recovery = (frontier.nodes ?? leaves).find(leaf => !this.#visited.has(idOf(leaf)) &&
        (needed.has(idOf(leaf)) || ['SUBMITTING', 'SUBMISSION_UNKNOWN', 'PENDING',
          'PUBLISH_PENDING', 'PUBLISH_UNKNOWN', 'PUBLISHING'].includes(leaf.work_status)) &&
        (leaf.job_status === 'ACTIVE' || recoverable.has(leaf.work_status)) &&
        (!leaf.next_poll_at || Date.parse(leaf.next_poll_at) <= Date.now()));
      if (recovery) return { kind: 'resume', leaf: recovery };
    }
    const leaf = selectWork(frontier, undefined, this.options);
    if (leaf) return { kind: 'work', leaf };
    if (resetRecovery) this.#visited.clear();
    return { kind: 'wait', reason: 'waiting for pending work, valid children, or graph propagation' };
  }

  startVisit(leaf) {
    this.#visited.add(idOf(leaf));
    this.visits++;
  }

  deferVisit(leaf) {
    if (this.#visited.delete(idOf(leaf))) this.visits--;
  }

}

// A graph rebuilt from disk already contains everything needed for selection.
export function selectCandidate(graph) {
  return new WorkSelection().selectCandidate(graph);
}

// Translate CLI selectors into the mission or milestone lookup.
export function selectTargetQuery(values, query) {
  const missionSelector = values.mission ?? values['mission-id'];
  const selection = { ...values };
  if (values.milestone !== undefined) {
    if (values.kind === 'mission') throw new Error('--milestone cannot be combined with --kind mission');
    if (query && missionSelector) throw new Error('With --milestone, specify the mission either positionally or with --mission/--mission-id, not both');
    selection.mission = missionSelector ?? query;
    if (!selection.mission) throw new Error('--milestone requires --mission "name or ID" or a positional mission name');
    selection.kind = 'milestone';
    query = values.milestone;
  } else if (!query && missionSelector) {
    if (values.kind === 'milestone') throw new Error('--kind milestone requires a milestone name; use --milestone "name or ID"');
    query = missionSelector;
    selection.kind = 'mission';
    delete selection.mission;
  } else if (query && (values['mission-id'] || isUuid(missionSelector)) && values.kind === 'auto') {
    selection.kind = 'milestone';
  }
  return { query, selection };
}

// Walk immediate decompositions ourselves. /graph is a display graph that may
// omit sketches even when has_more_children is false; /open-leaves currently
// times out on some missions. A visited queue bounds shared paths and cycles.
export async function discoverFrontier(client, rootId) {
  const root = await client.request(`theorems/${enc(rootId)}`);
  const nodes = new Map(), queue = [], plans = new Map(), parents = new Map(), links = new Map(), reductions = new Map();
  const snapshot = () => [...nodes].map(([id, node]) => ({ ...node, children: [...(links.get(id) ?? [])], reductions: reductions.get(id) ?? [] }));
  const live = node => node.status === 'Open' && !node.deprecated_at;
  function remember(node) {
    const id = node.theorem_id;
    if (typeof id !== 'string' || !id || typeof node.theorem_name !== 'string' || typeof node.status !== 'string') throw new Error('Invalid frontier theorem');
    const previous = nodes.get(id);
    if (previous) {
      if (previous.status !== node.status || previous.theorem_name !== node.theorem_name ||
          (previous.deprecated_at ?? null) !== (node.deprecated_at ?? null)) throw new Error('Theorem changed during frontier discovery; rerun');
      return id;
    }
    if (nodes.size >= 10000) throw new Error('Frontier exceeds 10000 theorems; select a smaller milestone');
    nodes.set(id, node);
    if (live(node)) queue.push(id);
    return id;
  }
  if (root.theorem_id !== rootId) throw new Error('Invalid frontier root response');
  remember(root);
  if (!live(root)) return { root, leaves: [], nodes: snapshot() };
  client.report?.('Discovering open leaves locally through immediate decompositions');
  for (let offset = 0; offset < queue.length; ) {
    const batch = queue.slice(offset, offset + 4);
    // Bound API concurrency and finish all in-flight reads before propagating errors.
    const responses = await Promise.allSettled(batch.map(id => client.request(`theorems/${enc(id)}/decompositions`)));
    const failure = responses.find(result => result.status === 'rejected');
    if (failure) throw failure.reason;
    for (const [index, result] of responses.entries()) {
      const id = batch[index], decompositions = result.value.decompositions;
      if (!Array.isArray(decompositions)) throw new Error('Invalid frontier decompositions');
      reductions.set(id, decompositions.map(reduction => ({ ...reduction, children: structuredClone(reduction.children ?? []),
        blockers: (reduction.children ?? []).filter(child => child.deprecated_at ||
          (!child.definition_id && !['Open', 'Proved'].includes(child.status))),
        usable: reduction.submission_id !== null && !reduction.deprecated_at &&
          (reduction.status === undefined || ['ACCEPTED', 'SKETCH_ACCEPTED'].includes(reduction.status)) &&
          !(reduction.children ?? []).some(child => child.deprecated_at || (!child.definition_id && !['Open', 'Proved'].includes(child.status))) })));
      const alternatives = [], allChildren = new Set();
      for (const decomposition of decompositions) {
        if (!decomposition || typeof decomposition !== 'object') throw new Error('Invalid frontier reduction');
        // Null submission IDs are structural imports, not proof reductions.
        if (decomposition.submission_id === null || decomposition.deprecated_at ||
            (decomposition.status !== undefined && !['ACCEPTED', 'SKETCH_ACCEPTED'].includes(decomposition.status))) continue;
        if (typeof decomposition.submission_id !== 'string' || !decomposition.submission_id || !Array.isArray(decomposition.children)) throw new Error('Invalid frontier reduction');
        const dependencies = new Set();
        let blocked = false;
        for (const child of decomposition.children) {
          if (child.definition_id) { if (child.deprecated_at) blocked = true; continue; }
          const childId = remember(child);
          allChildren.add(childId);
          dependencies.add(childId);
          if (!live(child) && (child.status !== 'Proved' || child.deprecated_at)) blocked = true;
        }
        if (!blocked) alternatives.push(dependencies);
      }
      links.set(id, allChildren);
      plans.set(id, alternatives);
      for (const dependencies of alternatives) for (const child of dependencies) {
        if (!parents.has(child)) parents.set(child, new Set());
        parents.get(child).add(id);
      }
    }
    offset += batch.length;
  }
  // Use the same AND/OR projection as admission and graph updates. Structural
  // leaves can belong exclusively to a sketch refuted by a sibling disproof.
  const leaves = workFrontier({ root, nodes: snapshot(), leaves: [] }).tasks
    .filter(task => !task.cycle_members).map(task => task.theorem_id);

  // AND within a reduction; OR between alternative reductions. Each newly
  // closed ancestor counts once, even with shared children or duplicate sketches.
  function cascade(seeds, resolved = new Set()) {
    const pending = [];
    for (const id of seeds) if (!resolved.has(id)) { resolved.add(id); pending.push(id); }
    for (let offset = 0; offset < pending.length; offset++) {
      for (const parent of parents.get(pending[offset]) ?? []) {
        if (!resolved.has(parent) && plans.get(parent).some(deps => [...deps].every(child => nodes.get(child).status === 'Proved' || resolved.has(child)))) {
          resolved.add(parent); pending.push(parent);
        }
      }
    }
    return resolved;
  }
  // Do not credit a candidate for already-satisfied reductions in a stale snapshot.
  const baseline = cascade(queue.filter(id => plans.get(id).some(deps => [...deps].every(child => nodes.get(child).status === 'Proved'))));
  const ranked = leaves.map(id => ({ theorem_id: id, theorem_name: nodes.get(id).theorem_name, status: 'Open',
    closability: cascade([id], new Set(baseline)).size - baseline.size - (baseline.has(id) ? 0 : 1) }));
  ranked.sort((a, b) => b.closability - a.closability || a.theorem_name.localeCompare(b.theorem_name) || a.theorem_id.localeCompare(b.theorem_id));
  client.report?.(`Discovered ${ranked.length} open leaves from ${queue.length} open theorems`);
  return { root, leaves: ranked, nodes: snapshot() };
}

export async function openLeaves(client, rootId) {
  return (await discoverFrontier(client, rootId)).leaves;
}

function uniqueMatch(candidates, query) {
  const exact = candidates.filter(c => normalize(c.name) === normalize(query) || c.id === query);
  const found = exact.length ? exact : candidates.filter(c => normalize(c.name).includes(normalize(query)));
  if (found.length === 1) return found[0];
  if (!found.length) throw new Error(`No mission or milestone matches "${query}"`);
  throw new Error(`Ambiguous target "${query}". Use --mission or a full name/ID:\n` + found.map(c => `  ${c.kind}: ${c.name} (${c.id}) — ${c.mission.name}`).join('\n'));
}

function missionSelector(value) {
  const decode = text => {
    try { return decodeURIComponent(text); }
    catch { return text; } // A literal percent sign is valid in a mission name.
  };
  const text = value.trim(), decoded = decode(text);
  if (!/^https?:\/\//i.test(decoded)) return { name: decoded.trim().replace(/\s+/g, ' ') };
  const url = new URL(/^https?:\/\//i.test(text) ? text : decoded);
  const match = url.pathname.match(/^\/missions\/([^/]+)\/?$/);
  if (url.origin !== 'https://prove2.me' || !match) throw new Error('Expected a https://prove2.me/missions/<name> URL');
  // Decode after replacing slug separators so an encoded literal underscore survives.
  return { name: decode(match[1].replaceAll('_', ' ')).trim(), url: true };
}

export async function findTarget(client, query, { kind = 'auto', mission: filter, 'mission-id': missionId } = {}) {
  if (filter) filter = missionSelector(filter).name;
  if (kind !== 'milestone') {
    const selected = missionSelector(query);
    query = selected.name;
    if (selected.url) kind = 'mission';
  }
  missionId ??= isUuid(filter) ? filter : kind === 'mission' && isUuid(query) ? query : undefined;
  let missions;
  if (missionId) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(missionId)) throw new Error('Invalid mission ID');
    if (kind === 'milestone') {
      // This endpoint already scopes and checks access by mission ID. No
      // catalog or mission detail is needed to resolve its linked theorem.
      client.report?.(`Looking up milestones directly for mission ID ${missionId}`);
      missions = [{ id: missionId, name: missionId }];
    } else {
      client.report?.(`Fetching mission ID ${missionId} directly`);
      try {
        const detail = await client.request(`missions/${enc(missionId)}`);
        const mission = detail.mission ?? detail;
        if (mission.id !== missionId || typeof mission.name !== 'string') throw new Error('Invalid mission detail response');
        missions = [mission];
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 405) throw error;
        client.report?.('Direct mission lookup is unsupported (HTTP 405); scanning catalog pages only until the ID is found');
        missions = (await client.pages('missions', 'missions', { until: rows => rows.some(m => m.id === missionId) })).filter(m => m.id === missionId);
      }
    }
  } else if (filter || kind !== 'milestone') {
    const name = filter ?? query;
    client.report?.(`Looking up mission by name: ${name}`);
    missions = await client.pages(`missions?name=${enc(name)}`, 'missions', { limit: 1 });
    // The positional auto syntax can also name a milestone. Only that legacy
    // cross-mission search needs the catalog when no exact mission was found.
    if (kind === 'auto' && !filter && !missions.some(m => normalize(m.name) === normalize(query) || m.id === query)) {
      client.report?.('No exact mission match; loading mission catalog to search milestones');
      missions = await client.pages('missions', 'missions');
    }
  } else {
    client.report?.('Loading mission catalog');
    missions = await client.pages('missions', 'missions');
  }
  if (filter && !missionId) {
    const chosen = uniqueMatch(missions.map(m => ({ kind: 'mission', name: m.name, id: m.id, mission: m })), filter);
    missions = [chosen.mission];
  }
  const candidates = kind === 'milestone' ? [] : missions.map(m => ({ kind: 'mission', name: m.name, id: m.id, root: m.main_theorem?.theorem_id, mission: m }));
  // An explicit mission name/ID is enough to resolve the target. Avoid one
  // milestone request per catalog mission just to rediscover that exact match.
  const exactMissions = candidates.filter(c => normalize(c.name) === normalize(query) || c.id === query);
  if (exactMissions.length) {
    const target = uniqueMatch(exactMissions, query);
    if (!target.root) throw new Error(`"${target.name}" has no linked theorem. There is no open-leaf tree to fetch yet.`);
    client.report?.(`Matched mission: ${target.name}; skipping milestone search`);
    return target;
  }
  if (kind !== 'mission') {
    for (const [index, mission] of missions.entries()) {
      client.report?.(`Searching milestones ${index + 1}/${missions.length}: ${mission.name}`);
      const milestones = await client.pages(`missions/${enc(mission.id)}/milestones`, 'milestones');
      candidates.push(...milestones.map(m => ({ kind: 'milestone', name: m.title, id: m.id, root: idOf(m.theorem ?? {}), mission, milestone: m })));
    }
  }
  const target = uniqueMatch(candidates, query);
  if (!target.root) throw new Error(`"${target.name}" has no linked theorem. There is no open-leaf tree to fetch yet.`);
  return target;
}

