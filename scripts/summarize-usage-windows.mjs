// Summarize a read-only analyze-agent-usage.mjs capture by allowance reset.
// Token-weighted credits are a comparison proxy, not subscription percentages.
import { readFile } from 'node:fs/promises';
const audit = JSON.parse(await readFile(process.argv[2] ?? '.runs/usage-audit-current.json', 'utf8'));
const rows = audit.sessions.filter(s => (s.is_runner || s.is_mission_review) && s.started >= '2026-10-22');
const windows = [];
for (const row of rows) {
  const reset = row.first_limit?.primary?.resets_at;
  if (!reset) continue;
  let window = windows.find(w => Math.abs(w.reset - reset) < 60);
  if (!window) { window = { reset, rows: [] }; windows.push(window); }
  window.rows.push(row);
}
const sum = (rows, fn) => rows.reduce((total, row) => total + (fn(row) ?? 0), 0);
const median = values => values.length ? values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)] : null;
const proxy = row => {
  if (!row.usage) return 0;
  const u = row.usage, sol = row.model === 'gpt-6.1-sol';
  return ((u.input_tokens - u.cached_input_tokens) * (sol ? 50 : 2.5) +
    u.cached_input_tokens * (sol ? 2.5 : 0.25) + u.output_tokens * (sol ? 250 : 12.5)) / 1e6;
};
const aggregate = rows => ({ sessions: rows.length, with_usage: rows.filter(r => r.usage).length,
  proof_sessions: rows.filter(r => r.is_runner && !r.artifact?.repair).length,
  format_repairs: rows.filter(r => r.artifact?.repair).length,
  research_reviews: rows.filter(r => r.is_mission_review).length,
  proof_accepted: rows.filter(r => !r.artifact?.repair && r.artifact?.result === 'proof_accepted').length,
  sketch_accepted: rows.filter(r => !r.artifact?.repair && r.artifact?.result === 'sketch_accepted').length,
  disproof_accepted: rows.filter(r => !r.artifact?.repair && r.artifact?.result === 'disproof_accepted').length,
  proxy_credits: sum(rows, proxy),
  median_seconds: median(rows.filter(r => r.artifact?.timing).map(r => r.artifact.timing.duration_ms / 1000)),
  median_peak_input: median(rows.filter(r => r.usage).map(r => r.max_input)),
});
console.log(JSON.stringify(windows.toSorted((a, b) => a.reset - b.reset).map(w => {
  const limits = w.rows.flatMap(r => r.limits).filter(r => r.limit_id === 'codex' && Math.abs(r.primary?.resets_at - w.reset) < 60);
  return { reset: new Date(w.reset * 1000).toISOString(),
    first_started: w.rows[0].started, last_started: w.rows.at(-1).started,
    five_hour_percent: [Math.min(...limits.map(r => r.primary.used_percent)), Math.max(...limits.map(r => r.primary.used_percent))],
    ...aggregate(w.rows),
    by_model: Object.fromEntries([...new Set(w.rows.map(r => r.model))].map(model => [model, aggregate(w.rows.filter(r => r.model === model))])),
  };
}), null, 2));
