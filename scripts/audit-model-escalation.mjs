// Read-only analysis of saved mathematical attempts; makes no model/API requests.
// Usage: node scripts/audit-model-escalation.mjs [runs directory]
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { incompleteEscalation } from '../model-policy.mjs';
import { scoreWork } from '../work-policy.mjs';

const runs = process.argv[2] ?? '.runs';
const read = async path => JSON.parse(await readFile(path, 'utf8'));
const checkpoint = await read(join(runs, 'last-run.json'));
const quota = await read(join(runs, 'codex-quota.json'));
const reset = quota.windows.primary.resets_at;
const latestStart = reset - quota.windows.primary.window_minutes * 60000;
const states = new Map();
for (const entry of await readdir(runs, { withFileTypes: true })) {
  if (!entry.isDirectory() || !/^[a-f0-9-]{36}$/.test(entry.name)) continue;
  try { states.set(entry.name, await read(join(runs, entry.name, 'state.json'))); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
const attempts = [];
for (const [id, state] of states) {
  const excluded = new Set((state.history ?? []).filter(e => e.event_type === 'attempt_exclusion').map(e => e.attempt));
  const history = state.history ?? [];
  for (const [index, start] of history.entries()) {
    if (start.event_type !== 'attempt' || start.result !== 'started' || excluded.has(start.attempt)) continue;
    const end = history.find(e => e.attempt_id === start.attempt_id && e.result !== 'started');
    const before = { ...state, context_id: start.context_id, history: history.slice(0, index) };
    const escalation = incompleteEscalation(before, { incompleteEscalation: { after: 2 } });
    attempts.push({ id, attempt: start.attempt, start: start.observed_at, model: start.model,
      result: end?.result ?? 'unfinished', failure: end?.failure?.category,
      escalation: start.escalation, already_escalated: history.slice(0, index).some(event =>
        event.result === 'started' && event.context_id === start.context_id && !excluded.has(event.attempt) &&
        event.escalation?.reason === 'repeated_incomplete' && event.model !== 'gpt-6-luna'),
      trigger_attempt: start.escalation?.trigger_attempt ?? escalation?.trigger_attempt });
  }
}
const group = (rows, key) => Object.fromEntries([...new Set(rows.map(key))].sort().map(k => [k, rows.filter(r => key(r) === k).length]));
const aggregate = rows => ({ attempts: rows.length, distinct_theorems: new Set(rows.map(r => r.id)).size,
  models: group(rows, r => r.model), outcomes: group(rows, r => r.result),
  by_model: Object.fromEntries([...new Set(rows.map(r => r.model))].map(model => {
    const selected = rows.filter(r => r.model === model);
    return [model, { outcomes: group(selected, r => r.result), repeated_escalations: selected.filter(r => r.already_escalated).length }];
  })) });
const graph = await read(join(runs, 'graphs', `${checkpoint.target.root}.json`));
const ready = scoreWork(graph, states, Date.parse(checkpoint.updated_at), { incompleteEscalation: { after: 2 } });
console.log(JSON.stringify({ latest_window: { start: new Date(latestStart).toISOString(), reset: new Date(reset).toISOString(),
  paused_at: quota.paused_at, quota: quota.windows, ...aggregate(attempts.filter(r => Date.parse(r.start) >= latestStart)) },
  by_jerusalem_day: Object.fromEntries(['2026-10-23', '2026-10-24'].map(day => [day, aggregate(attempts.filter(r =>
    new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(r.start)) === day))])),
  ready_frontier: ready.map(r => ({ id: r.theorem_id, score: r.score, attempts: r.totalAttempts,
    stuck: !!incompleteEscalation(r.projected_state), name: r.theorem_name })),
  latest_attempts: attempts.filter(r => Date.parse(r.start) >= latestStart).sort((a, b) => a.start.localeCompare(b.start)),
}, null, 2));
