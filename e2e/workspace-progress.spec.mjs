import { test, expect } from '@playwright/test';
import { fork } from 'node:child_process';
import { mkdtemp, copyFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { MissionControl, launchMissionControl } from '../mission-control-server.mjs';
import { readJson, save } from '../runner-state.mjs';

test('workspace preparation shows live copy progress and clears after the stage changes', async ({ page }, testInfo) => {
  const runs = await mkdtemp(join(tmpdir(), 'p2m-progress-browser-'));
  const configPath = join(runs, 'runner-config.json');
  let app;
  try {
    await copyFile(new URL('../runner-config.json', import.meta.url), configPath);
    const credentialsPath = join(runs, 'credentials.json');
    await writeFile(credentialsPath, JSON.stringify({ api_key: 'browser-test-key' }));
    const control = new MissionControl({ runs, configPath, credentialsPath,
      spawnRunner: () => fork(new URL('./fixtures/runner.mjs', import.meta.url), [runs], {
        windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      }),
    });
    app = await launchMissionControl([], { control, port: 0, sampling: false, openBrowser: async () => {} });
    const added = await control.command({ id: randomUUID(), revision: control.registry.revision,
      action: 'add', query: 'Browser smoke mission', start: true });
    expect(added.status).toBe('APPLIED');
    await expect.poll(() => control.active?.runId).toBeTruthy();
    const summary = await readJson(join(runs, 'last-run.json'));
    const preparation = { phase: 'copy', message: 'Copying Mathlib into a private workspace',
      started_at: new Date(Date.now() - 185000).toISOString(), updated_at: new Date().toISOString(),
      files_copied: 2400, bytes_copied: 64 * 1024 ** 2 };
    const worker = { theorem_id: 'leaf', stage: 'PREPARE', preparation };
    summary.live_workers = [worker];
    const job = { theorem_id: 'leaf', theorem_name: 'A theorem with a private Mathlib workspace',
      root_id: summary.target.root, run_id: summary.run_id, job_status: 'ACTIVE', stage: 'PREPARE',
      operation: 'prepare', dispatch_state: 'RUNNING', history: [] };
    await save(join(runs, 'leaf/state.json'), job);
    await save(join(runs, 'last-run.json'), summary);
    await page.goto(app.url);
    const panel = page.getByRole('region', { name: 'Workspace preparation', exact: true });
    await expect(panel).toBeVisible();
    await expect(panel).toContainText('2,400 files copied · 64.0 MiB copied');
    await expect(panel).toContainText('Elapsed 3m');
    await expect(panel.getByRole('progressbar')).not.toHaveAttribute('aria-valuenow');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await panel.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath('workspace-progress.png'), fullPage: true });

    preparation.files_copied = 4800; preparation.bytes_copied = 128 * 1024 ** 2;
    preparation.updated_at = new Date().toISOString();
    await save(join(runs, 'last-run.json'), summary);
    await page.getByRole('button', { name: 'Refresh status' }).click();
    await expect(panel).toContainText('4,800 files copied · 128.0 MiB copied');
    await panel.getByRole('button', { name: job.theorem_name }).click();
    await expect(page.locator('#inspector')).toContainText('4,800 files copied · 128.0 MiB copied');
    await page.getByRole('button', { name: 'Close inspector' }).click();

    preparation.updated_at = new Date(Date.now() - 60000).toISOString();
    await save(join(runs, 'last-run.json'), summary);
    await page.getByRole('button', { name: 'Refresh status' }).click();
    await expect(panel).toContainText('No recent preparation update');
    await expect(panel.getByRole('progressbar')).toHaveCount(0);

    job.stage = worker.stage = 'CODEX'; job.operation = 'implement';
    await save(join(runs, 'leaf/state.json'), job);
    await save(join(runs, 'last-run.json'), summary);
    await page.getByRole('button', { name: 'Refresh status' }).click();
    await expect(panel).toHaveCount(0);

    // A failed preparation releases the worker but must retain visible diagnostics.
    Object.assign(job, { stage: 'PREPARE', job_status: 'READY', dispatch_state: 'QUEUED',
      retry_after: new Date(Date.now() + 60000).toISOString(),
      recovery_failure: { stage: 'PREPARE', operation: 'reconstruct', code: 'ENOSPC',
        message: 'No space left to copy Mathlib', count: 6 } });
    summary.live_workers = [];
    await save(join(runs, 'leaf/state.json'), job);
    await save(join(runs, 'last-run.json'), summary);
    await page.getByRole('button', { name: 'Refresh status' }).click();
    await expect(page.locator('.attention-panel:visible').first()).toContainText('ENOSPC');
    await page.getByRole('button', { name: 'Waiting', exact: true }).click();
    const row = page.getByRole('row', { name: `Inspect ${job.theorem_name}` });
    await expect(row).toContainText('No space left to copy Mathlib');
    await expect(row).toContainText('Next check');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally {
    await app?.close();
    await rm(runs, { recursive: true, force: true });
  }
});
