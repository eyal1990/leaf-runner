import { test, expect } from '@playwright/test';
import { fork } from 'node:child_process';
import { mkdtemp, copyFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { MissionControl, launchMissionControl } from '../mission-control-server.mjs';
import { saveApiKey } from '../credentials-store.mjs';

test('reloading and restarting automatically recover a stale mission with the saved key', async ({ page }) => {
  const runs = await mkdtemp(join(tmpdir(), 'p2m-reopen-browser-'));
  const configPath = join(runs, 'runner-config.json'), credentialsPath = join(runs, 'credentials.json');
  const previousKey = process.env.PROVE2ME_API_KEY;
  delete process.env.PROVE2ME_API_KEY;
  let app, lookups = 0, spawns = 0;
  let releaseLookup;
  const gate = new Promise(resolve => { releaseLookup = resolve; });
  const makeControl = () => new MissionControl({ runs, configPath, credentialsPath,
    spawnRunner: () => { spawns++; throw new Error('Reopening must not start a runner'); },
    resolveTarget: async (argv, key) => {
      expect(key).toBe('saved-reopen-key');
      lookups++;
      await gate;
      return { kind: 'mission', name: 'Automatically recovered mission', root: 'reopen-root' };
    },
  });
  try {
    await copyFile(new URL('../runner-config.json', import.meta.url), configPath);
    await saveApiKey(credentialsPath, 'saved-reopen-key');
    let control = makeControl();
    app = await launchMissionControl([], { control, port: 0, sampling: false, openBrowser: async () => {} });
    const query = 'https://prove2.me/missions/Automatically_recovered_mission';
    const added = await control.command({ id: randomUUID(), revision: control.registry.revision, action: 'add', query });
    const missionId = added.result.missionId;
    const failDiscovery = async () => {
      const mission = control.findMission(missionId);
      Object.assign(mission, { status: 'ERROR', name: query, error: 'Prove2.me HTTP 401 at /api/v1/agent/refresh' });
      delete mission.target;
      await control.persist();
    };
    await failDiscovery();
    // Persist the problem, then restart the server before opening the app.
    await app.close(); app = null;
    control = makeControl();
    app = await launchMissionControl([], { control, port: 0, sampling: false, openBrowser: async () => {} });
    const recovery = page.waitForResponse(response => response.url().endsWith('/api/refresh-missions'));
    await page.goto(app.url);
    expect((await recovery).status()).toBe(202);
    await expect(page.getByRole('heading', { name: query, exact: true })).toBeVisible();
    await expect.poll(() => lookups).toBe(1);
    releaseLookup();
    await expect(page.getByRole('heading', { name: 'Automatically recovered mission', exact: true })).toBeVisible({ timeout: 10000 });
    await expect(page.locator('#mission-select option:checked')).toContainText('Ready to start');
    await expect(page.locator('#credentials-dialog')).not.toBeVisible();

    // A browser reload retries a fresh stale error without restarting the server.
    await failDiscovery();
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Automatically recovered mission', exact: true })).toBeVisible({ timeout: 10000 });
    await expect.poll(() => lookups).toBe(2);
    await expect(page.locator('#main')).not.toContainText('HTTP 401');
    expect(spawns).toBe(0);
  } finally {
    releaseLookup();
    await app?.close();
    await rm(runs, { recursive: true, force: true });
    if (previousKey === undefined) delete process.env.PROVE2ME_API_KEY;
    else process.env.PROVE2ME_API_KEY = previousKey;
  }
});

test('updating a rejected key refreshes the mission title and error dropdown without starting a runner', async ({ page }, testInfo) => {
  const runs = await mkdtemp(join(tmpdir(), 'p2m-key-refresh-browser-'));
  const configPath = join(runs, 'runner-config.json'), credentialsPath = join(runs, 'credentials.json');
  const previousKey = process.env.PROVE2ME_API_KEY;
  delete process.env.PROVE2ME_API_KEY;
  let app, spawns = 0;
  try {
    await copyFile(new URL('../runner-config.json', import.meta.url), configPath);
    await saveApiKey(credentialsPath, 'old-browser-key');
    const control = new MissionControl({ runs, configPath, credentialsPath,
      spawnRunner: () => { spawns++; throw new Error('Saving a key must not start proof work'); },
      resolveTarget: async (argv, key) => {
        if (key !== 'valid-replacement-key') throw new Error('Prove2.me authentication failed (HTTP 401)');
        return { kind: 'mission', name: 'Recovered mission title', root: 'recovered-root' };
      },
    });
    app = await launchMissionControl([], { control, port: 0, sampling: false, openBrowser: async () => {} });
    const query = 'https://prove2.me/missions/Recovered_mission_title';
    const added = await control.command({ id: randomUUID(), revision: control.registry.revision, action: 'add', query });
    Object.assign(control.findMission(added.result.missionId), { status: 'ERROR', error: 'Prove2.me authentication failed (HTTP 401)' });
    await control.persist();
    await page.goto(app.url);
    await expect(page.getByRole('heading', { name: query, exact: true })).toBeVisible();
    await expect(page.locator('#mission-select option:checked')).toContainText('Error');
    await expect(page.locator('#main')).not.toContainText('API key saved');
    await page.getByRole('button', { name: 'App settings', exact: true }).click();
    const settings = page.getByRole('dialog', { name: 'App settings', exact: true });
    await expect(settings).toContainText('API key is saved on this computer');
    await page.screenshot({ path: testInfo.outputPath('app-settings.png'), fullPage: true });
    await settings.getByRole('button', { name: 'Update API key' }).click();
    const dialog = page.getByRole('dialog', { name: 'Connect to Prove2.me' });
    await dialog.getByLabel('Prove2.me API key').fill('still-invalid-key');
    await dialog.getByRole('button', { name: 'Save API key', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('API key saved, but mission lookup failed');
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('Prove2.me API key').fill('valid-replacement-key');
    await dialog.getByRole('button', { name: 'Save API key', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect(page.getByRole('heading', { name: 'Recovered mission title', exact: true })).toBeVisible();
    await expect(page.locator('#mission-select option:checked')).toContainText('Recovered mission title');
    await expect(page.locator('#mission-select option:checked')).toContainText('Ready to start');
    await expect(page.locator('#main')).not.toContainText('HTTP 401');
    await expect(page.locator('#main').getByRole('button', { name: 'Update API key' })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('mission-key-recovered.png'), fullPage: true });
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Recovered mission title', exact: true })).toBeVisible();
    expect(spawns).toBe(0);
  } finally {
    await app?.close();
    await rm(runs, { recursive: true, force: true });
    if (previousKey === undefined) delete process.env.PROVE2ME_API_KEY;
    else process.env.PROVE2ME_API_KEY = previousKey;
  }
});

test('missing credentials prompt, save and start, and update work without editing files', async ({ page }, testInfo) => {
  const runs = await mkdtemp(join(tmpdir(), 'p2m-setup-browser-'));
  const configPath = join(runs, 'runner-config.json'), credentialsPath = join(runs, 'credentials.json');
  const previousKey = process.env.PROVE2ME_API_KEY;
  delete process.env.PROVE2ME_API_KEY;
  let app;
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await copyFile(new URL('../runner-config.json', import.meta.url), configPath);
    const control = new MissionControl({ runs, configPath, credentialsPath,
      resolveTarget: async () => ({ kind: 'mission', name: 'Browser smoke mission', root: 'browser-root' }),
      spawnRunner: () => fork(new URL('./fixtures/runner.mjs', import.meta.url), [runs], {
        windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      }),
    });
    app = await launchMissionControl([], { control, port: 0, sampling: false, openBrowser: async () => {} });
    const added = await control.command({ id: randomUUID(), revision: control.registry.revision,
      action: 'add', query: 'Saved mission', start: true });
    expect(added.result.status).toBe('CREDENTIALS_REQUIRED');
    control.findMission(added.result.missionId).error = "ENOENT: no such file or directory, open 'C:\\Projects\\leaf-runner\\credentials.json'";

    await page.goto(app.url);
    const dialog = page.getByRole('dialog', { name: 'Connect to Prove2.me' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel('Prove2.me API key')).toBeFocused();
    await expect(dialog.getByLabel('Prove2.me API key')).toHaveAttribute('type', 'password');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('credentials-setup.png'), fullPage: true });
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.locator('#main')).not.toContainText('ENOENT');
    await page.getByRole('button', { name: 'Start mission', exact: true }).click();
    await expect(dialog.getByRole('button', { name: 'Save key and start mission' })).toBeVisible();
    await dialog.getByLabel('Prove2.me API key').fill('bad key');
    await dialog.getByRole('button', { name: 'Save key and start mission' }).click();
    await expect(dialog.getByRole('alert')).toContainText('without spaces');
    expect(control.active).toBeUndefined();
    await dialog.getByLabel('Prove2.me API key').fill('private-browser-setup-key');
    await dialog.getByRole('button', { name: 'Save key and start mission' }).click();
    await expect(dialog).not.toBeVisible();
    await expect.poll(() => control.registry.missions[0].status).toBe('RUNNING');
    expect(JSON.parse(await readFile(credentialsPath, 'utf8')).api_key).toBe('private-browser-setup-key');
    await expect(page.locator('#main')).not.toContainText('private-browser-setup-key');
    await expect(page.locator('#prove2me-key')).toHaveValue('');

    await page.reload();
    await expect(page.locator('#main')).not.toContainText('API key saved');
    await expect(page.locator('#main').getByRole('button', { name: 'Update API key' })).toHaveCount(0);
    await expect(dialog).not.toBeVisible();
    await page.getByRole('button', { name: 'App settings', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'App settings', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Update API key' }).click();
    await expect(dialog.getByLabel('Prove2.me API key')).toHaveValue('');
    await dialog.getByLabel('Prove2.me API key').fill('replacement-browser-key');
    await dialog.getByRole('button', { name: 'Save API key' }).click();
    await expect(dialog).not.toBeVisible();
    expect(JSON.parse(await readFile(credentialsPath, 'utf8')).api_key).toBe('replacement-browser-key');

    // A new mission also pauses setup before spawning when its key is missing.
    await control.command({ id: randomUUID(), revision: control.registry.revision,
      action: 'stop', missionId: control.active.missionId, runId: control.active.runId });
    await rm(credentialsPath);
    await page.getByRole('button', { name: 'Refresh status' }).click();
    await page.getByRole('button', { name: 'New mission', exact: true }).click();
    const setup = page.getByRole('dialog', { name: 'Set up your mission' });
    await setup.getByLabel('Mission name, URL, or ID').fill('New mission without a key');
    await setup.getByRole('button', { name: 'Set up mission', exact: true }).click();
    await expect(setup).not.toBeVisible();
    await expect(dialog).toBeVisible();
    expect(control.active).toBeNull();
    await dialog.getByLabel('Prove2.me API key').fill('new-mission-private-key');
    await dialog.getByRole('button', { name: 'Save key and start mission' }).click();
    await expect(dialog).not.toBeVisible();
    await expect.poll(() => control.active?.runId).toBeTruthy();
    expect(errors).toEqual([]);
  } finally {
    await app?.close();
    await rm(runs, { recursive: true, force: true });
    if (previousKey === undefined) delete process.env.PROVE2ME_API_KEY;
    else process.env.PROVE2ME_API_KEY = previousKey;
  }
});
