import { test, expect } from '@playwright/test';
import { fork } from 'node:child_process';
import { mkdtemp, copyFile, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MissionControl, launchMissionControl } from '../mission-control-server.mjs';

test('session login, mission setup, settings persistence, and stop/save', async ({ page, context }) => {
  const runs = await mkdtemp(join(tmpdir(), 'p2m-browser-'));
  const configPath = join(runs, 'runner-config.json');
  let app;
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const json = async path => JSON.parse(await readFile(path, 'utf8'));
  const layout = async () => {
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expect(page.getByRole('heading', { level: 1 })).toBeInViewport();
  };
  try {
    await copyFile(new URL('../runner-config.json', import.meta.url), configPath);
    const credentialsPath = join(runs, 'credentials.json');
    await writeFile(credentialsPath, JSON.stringify({ api_key: 'browser-test-key' }));
    const control = new MissionControl({ runs, configPath, credentialsPath,
      resolveTarget: async () => ({ kind: 'mission', name: 'Browser smoke mission', root: 'browser-root' }),
      spawnRunner: () => fork(new URL('./fixtures/runner.mjs', import.meta.url), [runs], {
        windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      }),
      sampleLimits: async () => { throw new Error('Account sampling must remain disabled in browser tests'); },
    });
    app = await launchMissionControl([], { control, port: 0, sampling: false, openBrowser: async () => {} });
    expect(control.active).toBeUndefined();
    expect(control.registry.missions).toEqual([]);

    await page.goto(app.address);
    await expect(page.getByRole('heading', { name: 'Open Mission Control from your terminal' })).toBeVisible();
    expect((await context.request.get(`${app.address}/api/state`)).status()).toBe(401);
    await page.goto('about:blank');
    await page.goto(`${app.address}/#session=invalid`);
    await expect(page.getByRole('heading', { name: 'Open Mission Control from your terminal' })).toBeVisible();

    await page.goto('about:blank');
    await page.goto(app.url);
    await expect(page.getByRole('heading', { name: 'Your next proof starts here.' })).toBeVisible();
    await expect(page).not.toHaveURL(/#session=/);
    const cookie = (await context.cookies()).find(cookie => cookie.name === 'mission_control');
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Strict' });
    await layout();
    await page.reload();
    await page.getByRole('button', { name: 'Set up mission', exact: true }).click();
    const setup = page.getByRole('dialog', { name: 'Set up your mission' });
    await expect(setup).toBeInViewport();
    await setup.getByLabel('Mission name, URL, or ID').fill('Browser smoke mission');
    await setup.getByLabel('Start working immediately').uncheck();
    await setup.getByRole('button', { name: 'Set up mission', exact: true }).click();
    await expect(setup).not.toBeVisible();
    await expect(page.getByRole('heading', { name: 'Browser smoke mission', exact: true })).toBeVisible();
    await layout();

    // Resolve the stopped mission before editing settings. Reopening retries
    // unresolved discovery and changes the registry revision used by the form.
    await control.refreshMissions();
    await page.getByRole('button', { name: 'Refresh status' }).click();

    await page.getByRole('button', { name: 'Run settings', exact: true }).click();
    const settings = page.getByRole('dialog', { name: 'Run settings' });
    await expect(settings.getByRole('button', { name: /Attempt 1/ })).toHaveAccessibleName(/GPT-6.2 Astra, Max/);
    await settings.getByLabel('Prompt variant', { exact: true }).selectOption('proofOnly');
    await settings.getByLabel('Local job limit', { exact: true }).fill('12');
    await settings.getByRole('button', { name: /Attempt 1/ }).click();
    await settings.locator('#proof-models .model-name-button').click();
    await settings.getByRole('menuitemradio', { name: 'GPT-6.2 Sol', exact: true }).click();
    await settings.getByRole('slider', { name: 'Reasoning effort' }).press('End');
    await page.keyboard.press('Escape');
    await settings.getByLabel('Incomplete-result threshold', { exact: true }).fill('4');
    await settings.getByLabel('Rescue attempt limit', { exact: true }).fill('3');
    await settings.getByRole('button', { name: /Rescue model:/ }).click();
    await settings.locator('#escalation-model .model-name-button').click();
    await settings.getByRole('menuitemradio', { name: 'GPT-6.2 Astra', exact: true }).click();
    await settings.getByRole('slider', { name: 'Reasoning effort' }).press('Home');
    await page.keyboard.press('Escape');
    const save = settings.getByRole('button', { name: 'Save settings' });
    await save.scrollIntoViewIfNeeded();
    await expect(save).toBeInViewport();
    await save.click();
    await expect(settings).not.toBeVisible();
    await expect.poll(() => json(configPath)).toMatchObject({ promptVariant: 'proofOnly', maxActiveJobs: 12,
      attemptModels: ['sol-6.2-ultra'], incompleteEscalation: { after: 4, model: 'astra-6.2-low', maxAttempts: 3 } });
    await page.reload();
    await page.getByRole('button', { name: 'Run settings', exact: true }).click();
    await expect(settings.getByLabel('Prompt variant', { exact: true })).toHaveValue('proofOnly');
    await expect(settings.getByLabel('Local job limit', { exact: true })).toHaveValue('12');
    await expect(settings.getByRole('button', { name: /Attempt 1/ })).toHaveAccessibleName(/GPT-6.2 Sol, Ultra/);
    await expect(settings.getByLabel('Incomplete-result threshold', { exact: true })).toHaveValue('4');
    await expect(settings.getByLabel('Rescue attempt limit', { exact: true })).toHaveValue('3');
    await expect(settings.getByRole('button', { name: /Rescue model:/ })).toHaveAccessibleName(/GPT-6.2 Astra, Low/);
    await settings.getByLabel('Incomplete-result threshold', { exact: true }).fill('0');
    await settings.getByLabel('Rescue attempt limit', { exact: true }).fill('');
    await save.click();
    await expect(settings).not.toBeVisible();
    await expect.poll(() => json(configPath)).toMatchObject({ attemptModels: ['sol-6.2-ultra'],
      incompleteEscalation: { after: 0, model: 'astra-6.2-low', maxAttempts: null } });
    await page.reload();
    await page.getByRole('button', { name: 'Run settings', exact: true }).click();
    await expect(settings.getByLabel('Incomplete-result threshold', { exact: true })).toHaveValue('0');
    await expect(settings.getByLabel('Rescue attempt limit', { exact: true })).toHaveValue('');
    await settings.getByRole('button', { name: 'Cancel', exact: true }).click();

    await page.getByRole('button', { name: /Start (saved run|mission)/ }).click();
    await expect.poll(() => control.registry.missions[0].status).toBe('RUNNING');
    await page.getByRole('button', { name: 'Refresh status' }).click();
    const runnerPid = control.active.child.pid;
    await page.getByRole('button', { name: 'Stop agents', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Resume agents', exact: true })).toBeVisible();
    await expect(page.getByText('Agents stopped for Browser smoke mission', { exact: true })).toBeVisible();
    expect(control.active.child.pid).toBe(runnerPid);
    await layout();
    await page.getByRole('button', { name: 'Resume agents', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Stop agents', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Mission actions' }).click();
    await page.getByRole('button', { name: 'Stop and save', exact: true }).click();
    const confirm = page.getByRole('dialog', { name: 'Stop and save Browser smoke mission?' });
    await expect(confirm).toBeInViewport();
    await confirm.getByRole('button', { name: 'Confirm', exact: true }).click();
    await expect(confirm).not.toBeVisible();
    await expect.poll(() => control.active).toBeNull();
    await expect.poll(() => json(join(runs, 'last-run.json'))).toMatchObject({ status: 'INTERRUPTED',
      preserved_marker: 'browser-checkpoint', target: { root: 'browser-root' } });
    await page.reload();
    await expect(page.getByRole('button', { name: 'Start saved run', exact: true })).toBeVisible();
    expect((await json(control.path)).missions[0].status).toBe('STOPPED');
    await layout();
    expect(errors).toEqual([]);
  } finally {
    await context.close();
    await app?.close();
    await rm(runs, { recursive: true, force: true });
  }
});

test('new missions, previous missions, and stop-and-switch preserve saved runs', async ({ page, context }, testInfo) => {
  const runs = await mkdtemp(join(tmpdir(), 'p2m-mission-navigation-'));
  const configPath = join(runs, 'runner-config.json');
  let app;
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const checkLayout = async () => {
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expect(page.getByRole('navigation', { name: 'Mission navigation' })).toBeInViewport();
    await expect(page.getByRole('button', { name: 'New mission', exact: true })).toBeInViewport();
  };
  try {
    await copyFile(new URL('../runner-config.json', import.meta.url), configPath);
    const credentialsPath = join(runs, 'credentials.json');
    await writeFile(credentialsPath, JSON.stringify({ api_key: 'browser-test-key' }));
    const control = new MissionControl({ runs, configPath, credentialsPath,
      resolveTarget: async argv => ({ kind: 'mission', name: argv[1],
        root: `browser-root-${argv[1].toLowerCase().replace(/[^a-z0-9]+/g, '-')}` }),
      spawnRunner: argv => fork(new URL('./fixtures/runner.mjs', import.meta.url), [runs, argv[1]], {
        windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      }),
    });
    app = await launchMissionControl([], { control, port: 0, sampling: false, openBrowser: async () => {} });
    await page.goto(app.url);
    await page.getByRole('button', { name: 'New mission', exact: true }).click();
    const setup = page.getByRole('dialog', { name: 'Set up your mission' });
    await setup.getByLabel('Mission name, URL, or ID').fill('First saved mission');
    await setup.getByRole('button', { name: 'Set up mission', exact: true }).click();
    await expect.poll(() => control.registry.missions[0]?.status).toBe('RUNNING');
    const first = control.registry.missions[0].id;
    const firstPid = control.active.child.pid;
    const firstRunId = control.active.runId;
    await page.getByRole('button', { name: 'Refresh status' }).click();
    await checkLayout();

    await page.getByRole('button', { name: 'New mission', exact: true }).click();
    await setup.getByLabel('Mission name, URL, or ID').fill('Second saved mission');
    await expect(setup.getByLabel('Start working immediately')).toBeDisabled();
    await expect(setup.getByLabel('Start working immediately')).not.toBeChecked();
    await setup.getByRole('button', { name: 'Set up mission', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Second saved mission');
    const second = control.registry.missions[1].id;
    expect(control.active.child.pid).toBe(firstPid);
    await expect(page.getByRole('button', { name: 'Start mission', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Stop and switch', exact: true })).toBeVisible();
    await checkLayout();
    await page.screenshot({ path: testInfo.outputPath('mission-navigation.png'), fullPage: true });

    await page.getByLabel('Current mission', { exact: true }).selectOption(first);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('First saved mission');
    expect(control.active.child.pid).toBe(firstPid);
    await page.getByLabel('Current mission', { exact: true }).selectOption(second);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Second saved mission');

    await page.getByRole('button', { name: /Previous missions/ }).click();
    const history = page.getByRole('dialog', { name: 'Previous missions' });
    await history.getByLabel('Search missions').fill('FIRST');
    await expect(history.getByRole('heading', { name: 'First saved mission', exact: true })).toBeVisible();
    await expect(history.getByRole('heading', { name: 'Second saved mission', exact: true })).not.toBeVisible();
    await history.getByRole('button', { name: 'Open mission' }).click();
    await expect(history).not.toBeVisible();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('First saved mission');

    await page.getByLabel('Current mission', { exact: true }).selectOption(second);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Second saved mission');
    await page.getByRole('button', { name: 'Stop and switch', exact: true }).click();
    const confirm = page.getByRole('dialog', { name: 'Switch to Second saved mission?' });
    await expect(confirm).toContainText('Stop and save First saved mission');
    await confirm.getByRole('button', { name: 'Confirm', exact: true }).click();
    await expect(confirm).not.toBeVisible();
    await expect.poll(() => control.active?.missionId).toBe(second);
    await expect.poll(() => control.registry.missions[1].status).toBe('RUNNING');
    expect(control.registry.missions[0].status).toBe('STOPPED');
    expect(control.active.child.pid).not.toBe(firstPid);

    await page.getByLabel('Current mission', { exact: true }).selectOption(first);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('First saved mission');
    const savedView = (await control.state({ missionId: first })).selected;
    expect(savedView.summary).toMatchObject({ status: 'INTERRUPTED', run_id: firstRunId });
    await page.reload();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('First saved mission');
    expect(control.active.missionId).toBe(second);
    await page.getByRole('button', { name: 'View running mission' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Second saved mission');
    await checkLayout();
    expect(errors).toEqual([]);
  } finally {
    await context.close();
    await app?.close();
    await rm(runs, { recursive: true, force: true });
  }
});
