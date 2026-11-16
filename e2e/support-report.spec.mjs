import { test, expect } from '@playwright/test';
import { mkdtemp, mkdir, copyFile, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MissionControl, launchMissionControl } from '../mission-control-server.mjs';

test('failed mission offers editable local diagnostics and a manual GitHub report', async ({ page }, testInfo) => {
  const runs = await mkdtemp(join(tmpdir(), 'leaf-support-browser-'));
  const configPath = join(runs, 'runner-config.json'), credentialsPath = join(runs, 'credentials.json');
  const secret = 'support-browser-private-key';
  const errors = [], requests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => requests.push(request.url()));
  let app;
  try {
    await copyFile(new URL('../runner-config.json', import.meta.url), configPath);
    await writeFile(credentialsPath, JSON.stringify({ api_key: secret }));
    await mkdir(join(runs, 'leaf'));
    await writeFile(join(runs, 'leaf', 'state.json'), JSON.stringify({ theorem_id: 'leaf', root_id: 'root', stage: 'CODEX', job_status: 'NEEDS_ATTENTION' }));
    await writeFile(join(runs, 'leaf', 'codex-1.log'), `Sample diagnostic log with ${secret}`);
    const control = new MissionControl({ runs, configPath, credentialsPath });
    app = await launchMissionControl([], { control, port: 0, sampling: false, openBrowser: async () => {} });
    control.registry.missions.push({ id: 'failed', name: 'Failed sample mission', status: 'ERROR',
      error: `Sample failure with ${secret}`, target: { root: 'root', name: 'Failed sample mission' },
      argv: ['--mission', 'Failed sample mission'], createdAt: new Date().toISOString() });
    await control.persist();
    await page.goto(app.url);
    await page.getByRole('button', { name: 'Report a problem' }).click();
    const dialog = page.getByRole('dialog', { name: 'Share diagnostics' });
    await expect(dialog).toBeVisible();
    const preview = page.getByLabel('Diagnostic file');
    await expect(page.getByRole('button', { name: 'Download diagnostics' })).toBeEnabled();
    const content = await preview.inputValue();
    expect(content).toContain('[REDACTED]');
    expect(content).not.toContain(secret);
    const report = JSON.parse(content);
    expect(report.mission.id).toBe('failed');
    expect(report.jobs[0].stage).toBe('CODEX');
    expect(report.logs[0].content).toContain('Sample diagnostic log');
    const issue = dialog.getByRole('link', { name: 'Open GitHub issue' });
    expect(await issue.getAttribute('href')).toMatch(/^https:\/\/github.com\/eyal1990\/leaf-runner\/issues\/new\?/);
    expect(await issue.getAttribute('href')).not.toContain('Sample failure');
    const edited = content.replace('Sample diagnostic log', 'User-reviewed log');
    await preview.fill(edited);
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download diagnostics' }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe('leaf-runner-diagnostics.txt');
    expect(await readFile(await download.path(), 'utf8')).toBe(edited);
    expect(requests.filter(url => !url.startsWith(app.address))).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('support-dialog.png') });
    expect(errors).toEqual([]);
  } finally {
    await app?.close();
    await rm(runs, { recursive: true, force: true });
  }
});
