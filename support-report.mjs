import { execFile } from 'node:child_process';
import { homedir, platform, release, arch } from 'node:os';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { artifactList, readArtifact, redact, safeId } from './mission-control-data.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const pick = (value, keys) => Object.fromEntries(keys.filter(key => value?.[key] !== undefined).map(key => [key, value[key]]));
const sensitive = /api.?key|token|secret|password|authorization|cookie|credential|^argv$|^nextArgv$/i;

// Logs can contain private mission data. Preview the exact file before sharing.
export function sanitizeSupport(value, secrets = []) {
  let budget = 350000;
  const clean = (input, depth = 0) => {
    if (budget <= 0 || depth > 12) return '[OMITTED: report limit]';
    if (typeof input === 'string') {
      let text = redact(input, secrets);
      for (const secret of secrets.filter(item => typeof item === 'string' && item.length)) text = text.split(secret).join('[REDACTED]');
      const home = homedir();
      for (const path of [home, home.replaceAll('\\', '/')]) text = text.split(path).join('[HOME]');
      text = text.replace(/([?&#](?:session|token|key|api_key|access_token)=)[^\s&#"'<>]+/gi, '$1[REDACTED]');
      text = text.replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b/g, '[REDACTED]')
        .replace(/((?:password|client_secret|session_token|cookie)["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi, '$1[REDACTED]');
      const limit = Math.min(32768, budget);
      budget -= Math.min(text.length, limit);
      return text.length > limit ? text.slice(0, limit) + '\n[TRUNCATED]' : text;
    }
    if (Array.isArray(input)) {
      const items = input.slice(0, 100).map(item => clean(item, depth + 1));
      if (input.length > 100) items.push(`[OMITTED: ${input.length - 100} items]`);
      return items;
    }
    if (input && typeof input === 'object') {
      const entries = Object.entries(input);
      const result = Object.fromEntries(entries.slice(0, 100)
        .map(([key, item]) => [key, sensitive.test(key) ? '[REDACTED]' : clean(item, depth + 1)]));
      if (entries.length > 100) result._omittedFields = entries.length - 100;
      return result;
    }
    budget -= 16;
    return input;
  };
  return clean(value);
}

export async function buildSupportReport({ runs, view, secrets = [] }) {
  let revision = 'unavailable';
  try {
    const { stdout } = await promisify(execFile)('git', ['rev-parse', 'HEAD'], {
      cwd: root, windowsHide: true, timeout: 3000, maxBuffer: 1024,
    });
    revision = stdout.trim();
  } catch { /* Installed copies may not have Git metadata. */ }
  const missionRoot = view.mission.target?.root;
  const scopedJobs = view.jobs.filter(job => !job.root_id || job.root_id === missionRoot);
  const jobs = [...scopedJobs].sort((a, b) => Number(!!b.failure) - Number(!!a.failure)
    || String(b.updated_at ?? '').localeCompare(String(a.updated_at ?? ''))).slice(0, 40);
  const logs = [], notes = [];
  for (const job of jobs.slice(0, 8)) {
    if (!safeId(job.theorem_id) || logs.length >= 8) continue;
    try {
      const files = (await artifactList(runs, job.theorem_id)).filter(file => file.log)
        .filter(file => {
          const attempt = /^codex-(\d+)(?:-repair)?\.log$/.exec(file.name)?.[1];
          return !attempt || !(job.history ?? []).some(event => String(event.attempt) === attempt && event.root_id && event.root_id !== missionRoot);
        })
        .sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true })).slice(0, 2);
      for (const file of files) {
        if (logs.length >= 8) break;
        const artifact = await readArtifact(runs, job.theorem_id, file.name);
        const truncated = artifact.truncated || artifact.content.length > 32768;
        let content = artifact.content.slice(-32768);
        // A tail can start halfway through a credential. Keep complete lines so
        // redaction still sees the credential's prefix or its complete value.
        if (truncated) content = content.includes('\n') ? content.slice(content.indexOf('\n') + 1) : '[OMITTED: log tail starts mid-line]';
        logs.push({ source: `.runs/${job.theorem_id}/${file.name}`, bytes: artifact.bytes,
          truncated, content });
      }
    } catch { notes.push(`Logs unavailable for ${job.theorem_id}; they may have moved or been removed.`); }
  }
  const report = sanitizeSupport({
    format: 'leaf-runner-support-v1', generatedAt: new Date().toISOString(),
    runtime: { revision, node: process.version, platform: platform(), release: release(), arch: arch() },
    mission: { ...pick(view.mission, ['id', 'processStatus', 'running', 'managed', 'managedRunId', 'heartbeatAt', 'error']),
      root: view.mission.target?.root },
    checkpoint: view.summary,
    settings: pick(view.configSettings, ['values', 'effectiveValues', 'runningValues', 'overrides', 'pending', 'changedKeys']),
    jobs: jobs.map(job => {
      const { theorem_name, ...state } = job;
      return { ...state, history: (job.history ?? []).filter(event => !event.root_id || event.root_id === missionRoot) };
    }),
    logs, notes,
    coverage: { jobsIncluded: jobs.length, jobsTotal: scopedJobs.length, jobsFromOtherRootsExcluded: view.jobs.length - scopedJobs.length,
      maxLogs: 8, logTailCharacters: 32768,
      description: 'Selected mission checkpoint and job state from .runs, plus recent log excerpts. Not a backup of .runs. Prompts, source files, credentials files, account data and environment variables are excluded. Arrays, strings and total text are bounded; omitted or truncated data is marked.' },
  }, secrets);
  return { filename: 'leaf-runner-diagnostics.txt', content: JSON.stringify(report, null, 2) + '\n' };
}
