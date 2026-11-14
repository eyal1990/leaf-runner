// Render the production dashboard with synthetic data only; no account/API/model reads.
// Requires: npm ci && npx playwright install chromium
import { chromium } from '@playwright/test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MissionControl, launchMissionControl } from '../mission-control-server.mjs';
import { buildMissionView } from '../mission-control-data.mjs';
import { pipelineLimits } from '../pipeline-config.mjs';

const runs = await mkdtemp(join(tmpdir(), 'leaf-runner-screenshot-'));
let app, browser;
try {
  const now = new Date().toISOString();
  const mission = { id: 'example-mission', name: 'Example mission', running: true,
    managed: true, processStatus: 'RUNNING', target: { root: 'example-root' }, heartbeatAt: now };
  const leaves = ['addition_identity', 'sum_rearrangement', 'finite_sum_bound'].map((name, i) => ({
    theorem_id: `example-leaf-${i + 1}`, theorem_name: name, status: 'Open', decompositions: [],
  }));
  const jobs = leaves.slice(0, 2).map(node => ({ ...node, root_id: 'example-root',
    stage: 'CODEX', operation: 'implement', job_status: 'ACTIVE', dispatch_state: 'RUNNING',
    model: 'gpt-6-luna', updated_at: now,
  }));
  const summary = { run_id: 'example-run', status: 'RUNNING', root_status: 'Open',
    started_at: now, updated_at: now, limits: pipelineLimits(),
    pipeline: { localActive: 2, remoteActive: 0, active: 2 },
    ready_work: [leaves[2]], live_workers: jobs.map(job => ({ theorem_id: job.theorem_id,
      stage: 'CODEX', model: 'gpt-6-luna' })),
  };
  const selected = buildMissionView({ mission, summary, jobs,
    graph: { updated_at: now, root: { theorem_id: 'example-root', theorem_name: 'Example theorem',
      status: 'Open', decompositions: [{ children: leaves }] }, nodes: leaves, leaves } });
  const snapshot = { selected, missions: [{ mission, counts: selected.counts, currentWork: selected.jobs }],
    observedAt: now, account: {}, totals: {} };
  const control = new MissionControl({ runs });
  app = await launchMissionControl([], { control, port: 0, sampling: false, openBrowser: async () => {} });
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1320 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/state?*', route => route.fulfill({ json: snapshot }));
  await page.goto(app.url);
  await page.getByRole('heading', { name: 'Example mission', exact: true }).waitFor();
  await page.getByRole('heading', { name: 'Theorem queues Now' }).waitFor();
  await page.evaluate(() => document.fonts.ready);
  if (errors.length) throw new Error(errors.join('\n'));
  await mkdir(new URL('../docs/assets/', import.meta.url), { recursive: true });
  await page.screenshot({ path: fileURLToPath(new URL('../docs/assets/mission-control.png', import.meta.url)), fullPage: true });
  console.log('Saved docs/assets/mission-control.png (synthetic example data).');
} finally {
  await browser?.close();
  await app?.close();
  if (!resolve(runs).startsWith(resolve(tmpdir()) + sep)) throw new Error('Unexpected temporary directory');
  await rm(runs, { recursive: true, force: true });
}
