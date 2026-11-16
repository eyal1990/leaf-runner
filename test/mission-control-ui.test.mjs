import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createContext, runInContext } from 'node:vm';
import { buildMissionView } from '../mission-control-data.mjs';
import { renderMissionSettings, readMissionSettings } from '../mission-control/mission-settings.js';
import { syncModelPicker } from '../mission-control/model-picker.js';

const source = await readFile(new URL('../mission-control/app.js', import.meta.url), 'utf8');
const shell = await readFile(new URL('../mission-control/index.html', import.meta.url), 'utf8');

function browser(fetch) {
  const elements = new Map(), intervals = [];
  const element = selector => {
    if (!elements.has(selector)) elements.set(selector, { value: '', innerHTML: '', listeners: {},
      addEventListener(type, listener) { this.listeners[type] = listener; }, classList: { toggle() {} } });
    return elements.get(selector);
  };
  const context = createContext({ URLSearchParams, AbortSignal, Intl, console, renderMissionSettings, readMissionSettings, syncModelPicker,
    location: { search: '', hash: '', pathname: '/' }, history: { replaceState() {} },
    document: { querySelector: element, addEventListener() {}, hidden: false, activeElement: null },
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); }, clearInterval() {}, setTimeout, clearTimeout,
    fetch,
  });
  runInContext(source.replace(/^import .*;\r?\n/gm, '').replace('void boot();', ''), context);
  return { context, element, intervals, run: code => runInContext(code, context) };
}

function snapshot(id = 'first') {
  const view = buildMissionView({ mission: { id, name: `${id} mission`, running: true, managed: true, processStatus: 'RUNNING', target: { root: 'root' } },
    summary: { ready_work: [], live_workers: [{ theorem_id: 'leaf', stage: 'CODEX', model: 'gpt-6-luna' }] },
    graph: { root: { theorem_id: 'root', status: 'Open' }, leaves: [{ theorem_id: 'leaf', theorem_name: 'A <bridge> theorem', status: 'Open' }] },
    jobs: [{ theorem_id: 'leaf', stage: 'CODEX', operation: 'implement', job_status: 'ACTIVE', dispatch_state: 'RUNNING' }] });
  return { selected: view, missions: [{ mission: view.mission, counts: view.counts, currentWork: view.jobs }],
    account: { windows: { primary: { used_percent: 34, window_minutes: 300 } } }, totals: {} };
}

test('workspace progress shows counters, elapsed time and freshness without a fabricated percentage', () => {
  const ui = browser(); ui.context.fixture = snapshot(); ui.run('state = fixture');
  const view = ui.context.fixture.selected;
  view.mission.managedRunId = 'run'; view.summary.run_id = 'run';
  Object.assign(view.jobs[0], { stage: 'PREPARE', running: true, preparation: {
    phase: 'copy', message: 'Copying Mathlib <sources>', files_copied: 2400, bytes_copied: 64 * 1024 ** 2,
    started_at: new Date(Date.now() - 185000).toISOString(), updated_at: new Date().toISOString(),
  } });
  let html = ui.run('missionPage(state.selected)');
  assert.match(html, /Preparing workspaces/);
  assert.match(html, /Copying Mathlib &lt;sources&gt;/);
  assert.match(html, /2,400 files copied · 64\.0 MiB copied/);
  assert.match(html, /Elapsed 3m \d+s · Last update 0s ago/);
  assert.match(html, /role="progressbar" aria-label="Workspace preparation in progress"/);
  assert.doesNotMatch(html, /aria-valuenow/);
  assert.doesNotMatch(html, /No recent preparation update/);
  view.jobs[0].preparation.updated_at = new Date(Date.now() - 60000).toISOString();
  html = ui.run('missionPage(state.selected)');
  assert.match(html, /No recent preparation update/);
  assert.doesNotMatch(html, /role="progressbar" aria-label="Workspace preparation/);
  for (const phase of ['seed', 'waiting', 'reset', 'dependencies']) {
    view.jobs[0].preparation.phase = phase;
    assert.doesNotMatch(ui.run('missionPage(state.selected)'), /files copied/);
  }
  view.mission.running = false;
  assert.doesNotMatch(ui.run('missionPage(state.selected)'), /Preparing workspaces/);
  view.mission.running = true; view.mission.managedRunId = 'new-run';
  assert.doesNotMatch(ui.run('missionPage(state.selected)'), /Preparing workspaces/);
});

test('agent stop and resume are prominent while independent pause controls remain available', () => {
  const ui = browser(); ui.context.fixture = snapshot(); ui.run('state = fixture');
  let html = ui.run('missionPage(state.selected)');
  assert.match(html, /data-action="stop-agents"[^>]*>.*Stop agents/);
  assert.match(html, /data-action="pause-admission"/);
  ui.run('state.selected.summary.operator = { agentsStopped: true, dispatchPaused: true, admissionPaused: true }');
  html = ui.run('missionPage(state.selected)');
  assert.match(html, /data-action="resume-agents"/);
  assert.match(html, /Agents stopped for first mission/);
  assert.match(html, /validation, submissions, and server polling continue/);
  assert.match(html, /data-action="resume-dispatch"/);
  assert.match(html, /data-action="resume-admission"/);
  ui.run('state.selected.mission.managed = false');
  assert.doesNotMatch(ui.run('missionPage(state.selected)'), /data-action="resume-agents"/);
});

test('saved interruptions are normal stopped runs without a warning banner', () => {
  const ui = browser(); ui.context.fixture = snapshot(); ui.run('state = fixture');
  for (const processStatus of ['INTERRUPTED', 'STOPPED']) {
    Object.assign(ui.context.fixture.selected.mission, { running: false, managed: false, processStatus, error: 'Operator interrupted runner' });
    Object.assign(ui.context.fixture.selected.summary, { status: 'INTERRUPTED', error: 'Operator interrupted runner',
      codex_quota: { status: 'WAITING' }, api_recovery: { waiting: true }, proof_storage_recovery: { waiting: true, jobs: [] } });
    const html = ui.run('missionPage(state.selected)');
    assert.doesNotMatch(html, /class="banner|status-badge error|Operator interrupted runner/);
    assert.match(html, /data-action="start"/);
    assert.equal(ui.run('processLabel(state.selected.mission)'), 'Stopped');
  }
});

test('a new managed run ignores old diagnostics until its own checkpoint arrives', () => {
  const ui = browser(); ui.context.fixture = snapshot(); ui.run('state = fixture');
  Object.assign(ui.context.fixture.selected.mission, { managedRunId: null, processStatus: 'STARTING' });
  Object.assign(ui.context.fixture.selected.summary, { run_id: 'old', status: 'ERROR', error: 'Old failure',
    codex_quota: { status: 'WAITING' }, api_recovery: { waiting: true }, proof_storage_recovery: { waiting: true, jobs: [] } });
  assert.doesNotMatch(ui.run('missionPage(state.selected)'), /class="banner|Old failure/);
  ui.run("state.selected.mission.managedRunId = 'new'; state.selected.mission.processStatus = 'RUNNING'");
  assert.doesNotMatch(ui.run('missionPage(state.selected)'), /class="banner|Old failure/);
  ui.run("state.selected.summary = { run_id: 'new', status: 'RUNNING', error: 'Current failure' }");
  assert.match(ui.run('missionPage(state.selected)'), /<strong>Current failure<\/strong>/);
  ui.run("state.selected.summary = { run_id: 'new', status: 'RUNNING', codex_quota: { status: 'WAITING' } }");
  assert.match(ui.run('missionPage(state.selected)'), /Codex waiting for account limits/);
});

test('genuine stopped-run failures are explicitly labeled as previous', () => {
  const ui = browser(); ui.context.fixture = snapshot(); ui.run('state = fixture');
  Object.assign(ui.context.fixture.selected.mission, { running: false, processStatus: 'ERROR', error: 'Startup failed' });
  Object.assign(ui.context.fixture.selected.summary, { status: 'INTERRUPTED', error: 'Operator interrupted runner' });
  assert.match(ui.run('missionPage(state.selected)'), /Previous run failed: Startup failed/);
  ui.run("state.selected.mission.error = null; state.selected.summary = { status: 'ERROR', error: 'Server failed <details>' }");
  assert.match(ui.run('missionPage(state.selected)'), /Previous run failed: Server failed &lt;details&gt;/);
});

test('credential setup replaces missing-file diagnostics and keeps the key in a password field', () => {
  const ui = browser(); ui.context.fixture = snapshot(); ui.run('state = fixture');
  Object.assign(ui.context.fixture.selected.mission, { running: false, processStatus: 'ERROR',
    error: "ENOENT: no such file or directory, open 'C:\\Projects\\leaf-runner\\credentials.json'" });
  ui.context.fixture.credentials = { configured: false, source: 'file', editable: true };
  assert.doesNotMatch(ui.run('missionPage(state.selected)'), /ENOENT|Previous run failed/);
  assert.match(ui.run('credentialsBanner()'), /Add your Prove2.me API key/);
  ui.context.fixture.credentials.configured = true;
  assert.doesNotMatch(ui.run('missionPage(state.selected)'), /ENOENT|Previous run failed/);
  assert.equal(ui.run('credentialsBanner()'), '');
  ui.run('renderAppSettings()');
  assert.match(ui.element('#app-credentials').innerHTML, /Update API key/);
  assert.match(shell, /aria-label="App settings"/);
  assert.match(shell, /id="app-settings-dialog"/);
  assert.match(shell, /id="prove2me-key" type="password" required maxlength="4096" autocomplete="off"/);
});

test('one settings form shows the saved prompt and disables all editing for external runners', () => {
  const ui = browser();
  ui.element('#settings-dialog').showModal = () => {};
  ui.context.fixture = snapshot();
  ui.context.fixture.selected.configSettings = { values: { promptVariant: 'balanced' }, revision: 3 };
  ui.run("fixture.selected.promptSettings = { promptVariant: 'proofOnly', revision: 3 }; showSettings(fixture.selected)");
  assert.equal(ui.element('#prompt-variant').value, 'proofOnly');
  assert.equal(ui.element('#prompt-variant').disabled, false);
  ui.run('fixture.selected.mission.managed = false; showSettings(fixture.selected)');
  assert.equal(ui.element('#prompt-variant').disabled, true);
  assert.match(ui.element('#config-error').textContent, /connected/);
  ui.run('fixture.selected.mission.running = false; showSettings(fixture.selected)');
  assert.equal(ui.element('#prompt-variant').disabled, false);
  ui.run('delete fixture.selected.promptSettings; showSettings(fixture.selected)');
  assert.equal(ui.element('#prompt-variant').disabled, false);
  assert.equal(ui.element('#prompt-variant').value, 'balanced');
  ui.run("fixture.selected.configSettings.values.promptVariant = 'original'; showSettings(fixture.selected)");
  assert.equal(ui.element('#prompt-variant').value, 'balanced');
  ui.run('delete fixture.selected.configSettings; showSettings(fixture.selected)');
  assert.equal(ui.element('#prompt-variant').disabled, true);
  const settingsHtml = shell.match(/<dialog id="settings-dialog"[\s\S]*?<\/dialog>/)[0];
  assert.match(settingsHtml, /<option value="balanced">Balanced<\/option>/);
  assert.doesNotMatch(settingsHtml, /value="original"|value="ab_test"|50\/50/);
  assert.equal((settingsHtml.match(/type="submit"/g) ?? []).length, 1);
  assert.match(settingsHtml, />Save settings</);
  assert.doesNotMatch(settingsHtml, /data-action="set-prompt-variant"|Save prompt|Save model/);
});

test('saving the form sends prompt, models and capacities in a single scoped command', async () => {
  const ui = browser();
  const requests = [];
  ui.context.command = async (...args) => { requests.push(args); return { status: 'APPLIED' }; };
  ui.context.readMissionSettings = () => ({ attemptModels: ['sol-6.1-max'], maxActiveJobs: 8 });
  ui.context.fixture = snapshot();
  ui.context.fixture.selected.configSettings = { values: {}, revision: 4, configRevision: 'file-version' };
  ui.element('#settings-dialog').showModal = () => {};
  let closed = false;
  ui.element('#settings-dialog').close = () => { closed = true; };
  ui.run('state = fixture; showSettings(state.selected)');
  ui.element('#prompt-variant').value = 'proofOnly';
  await ui.element('#runtime-settings-form').listeners.submit({ preventDefault() {} });
  assert.equal(requests.length, 1);
  assert.equal(requests[0][0], 'set-runtime-settings');
  assert.equal(requests[0][1].promptVariant, 'proofOnly');
  assert.equal(requests[0][1].settings.attemptModels[0], 'sol-6.1-max');
  assert.equal(requests[0][1].controlRevision, 4);
  assert.equal(requests[0][1].configRevision, 'file-version');
  assert.equal(requests[0][1].missionId, 'first');
  assert.equal(closed, true);
});

test('settings name the shared config file, pending file edits, and explicit CLI overrides', () => {
  const ui = browser();
  ui.element('#settings-dialog').showModal = () => {};
  ui.context.fixture = snapshot();
  ui.context.fixture.selected.configSettings = { values: { attemptModels: ['sol-6.1-high'] }, path: 'custom.json', pending: true,
    runningValues: { attemptModels: ['luna-6-high'] },
    changedKeys: ['attemptModels'], overrides: { '--model': 'sol-6.1-high' } };
  ui.run('state = fixture; showSettings(fixture.selected)');
  const note = ui.element('#settings-note').textContent;
  assert.match(note, /custom.json/);
  assert.match(note, /share these settings/);
  assert.match(note, /running settings differ.*attemptModels/);
  assert.match(note, /--model=sol-6.1-high/);
  assert.match(note, /Saving replaces matching/);
  const differences = ui.element('#settings-differences').innerHTML;
  assert.match(differences, /Saved in file/);
  assert.match(differences, /Running now/);
  assert.match(differences, /sol-6.1-high/);
  assert.match(differences, /luna-6-high/);
  assert.match(ui.run('runnerCard(fixture.selected)'), /Saved settings differ from the running settings/);
});

test('Codex meters display remaining capacity, including exhaustion, unknown and out-of-range readings', () => {
  const ui = browser(); ui.context.fixture = snapshot(); ui.run('state = fixture');
  let html = ui.run('capacityCard(null)');
  assert.match(html, /66% left/);
  assert.match(html, /value="66" max="100" aria-label="5-hour remaining capacity"/);
  for (const [used, remaining] of [[100, 0], [120, 0], [-5, 100], [0, 100]]) {
    ui.context.fixture.account.windows.primary.used_percent = used;
    html = ui.run('capacityCard(null)');
    assert.match(html, new RegExp(`${remaining}% left`));
    assert.match(html, new RegExp(`value="${remaining}" max="100"`));
  }
  ui.context.fixture.account.windows.primary.used_percent = null;
  html = ui.run('capacityCard(null)');
  assert.match(html, /Remaining capacity unknown/);
  assert.doesNotMatch(html, /<progress/);
});

test('start remains blocked while a runner is already active, including without a lock observation', () => {
  const ui = browser(); ui.context.fixture = snapshot();
  ui.run("state = fixture; state.selected.mission.running = false; state.missions.push({ mission: { id: 'other', running: true } })");
  assert.match(ui.run('missionPage(state.selected)'), /data-action="start" disabled title="Stop and save the current runner/);
  ui.run('state.missions.pop()');
  assert.doesNotMatch(ui.run('missionPage(state.selected)'), /data-action="start" disabled/);
});

test('mission navigation, settings, and every detail tab remain accessible', () => {
  const ui = browser(); ui.context.fixture = snapshot(); ui.run('state = fixture');
  assert.match(shell, /id="history-dialog"/);
  assert.match(shell, /Search missions/);
  let html;
  for (const tab of ['work', 'leaves', 'results', 'dependencies', 'research', 'activity']) {
    ui.context.nextTab = tab;
    ui.run('ui.tab = nextTab; render()');
    html = ui.element('#main').innerHTML;
    assert.match(html, /Current mission/);
    assert.match(html, /Previous missions/);
    assert.match(html, /data-action="add"/);
    assert.match(html, /class="button" data-action="settings"/);
    assert.match(html, /Open leaves/);
    assert.match(html, /data-tab="leaves"/);
  }
  ui.context.fixture.selected.frontier.leafIds = ['leaf', 'unclaimed'];
  html = ui.run('openLeavesPanel(state.selected)');
  assert.match(html, /A &lt;bridge&gt; theorem/);
  assert.match(html, /data-inspect="unclaimed"/);
  assert.match(html, /Not currently admitted/);
});

test('mission history searches names and escapes saved mission markup', () => {
  const ui = browser(); ui.context.fixture = snapshot();
  ui.run("state = fixture; state.missions.push({ mission: { id: 'saved', name: 'An <earlier> mission', processStatus: 'STOPPED' }, counts: { proofs: 2, reductions: 3 } })");
  ui.element('#mission-search').value = 'EARLIER';
  ui.run('renderMissionHistory()');
  let html = ui.element('#mission-history').innerHTML;
  assert.match(html, /An &lt;earlier&gt; mission/);
  assert.match(html, /2 proofs · 3 sketches/);
  assert.match(html, /data-mission="saved"/);
  assert.doesNotMatch(html, /first mission/);
  ui.element('#mission-search').value = 'absent';
  ui.run('renderMissionHistory()');
  assert.match(ui.element('#mission-history').innerHTML, /No matching missions/);
});

test('switching missions fetches the selected mission and clears theorem and activity filters without commands', async () => {
  const urls = [];
  const ui = browser(async url => {
    urls.push(url);
    const value = snapshot('saved');
    value.selected.mission.running = false;
    return { ok: true, json: async () => value };
  });
  ui.context.fixture = snapshot();
  ui.run("state = fixture; state.missions.push({ mission: { id: 'saved', name: 'Saved mission' } }); ui.theorem = 'old-theorem'; ui.stage = 'CODEX'; ui.search = 'old'; ui.model = 'old'; ui.filter = 'ready'; ui.range = 'day'; ui.artifactText = 'old artifact'; ui.follow = true");
  await ui.run("selectMission('saved')");
  assert.equal(urls.length, 1);
  assert.match(urls[0], /^\/api\/state\?range=run&missionId=saved$/);
  assert.equal(ui.run('state.selected.mission.id'), 'saved');
  assert.equal(ui.run('ui.theorem'), null);
  for (const key of ['stage', 'search', 'model', 'artifactText']) assert.equal(ui.run(`ui.${key}`), '');
  assert.equal(ui.run('ui.follow'), false);
  assert.equal(ui.run('ui.filter'), 'active');
});

test('viewing a stopped mission identifies the active runner and offers a managed switch only', () => {
  const ui = browser(); ui.context.fixture = snapshot();
  ui.run("state = fixture; state.selected.mission.running = false; state.missions.push({ mission: { id: 'active', name: 'Another <mission>', running: true, managed: true } })");
  let html = ui.run('missionNavigation()');
  assert.match(html, /Another &lt;mission&gt;<\/strong> is still running/);
  assert.match(html, /data-action="switch-run"/);
  assert.match(html, /data-mission="active"/);
  ui.run('state.missions.at(-1).mission.managed = false');
  html = ui.run('missionNavigation()');
  assert.doesNotMatch(html, /data-action="switch-run"/);
  assert.match(html, /Stop it in its terminal/);
});

test('queue blocks count theorem jobs once, distinguish delays and handoffs, and retain stopped work', () => {
  const ui = browser(); ui.context.fixture = snapshot();
  const view = ui.context.fixture.selected;
  view.jobs.push(
    { theorem_id: 'delayed', job_status: 'ACTIVE', stage: 'CODEX', dispatch_state: 'DELAYED' },
    { theorem_id: 'handoff', job_status: 'ACTIVE', stage: 'CODEX', dispatch_state: 'HANDOFF_PENDING' },
    { theorem_id: 'remote', job_status: 'ACTIVE', stage: 'SERVER', remote_issued: true },
    { theorem_id: 'done', job_status: 'DONE', stage: 'CODEX' });
  view.summary.mission_research = { model_running: true };
  // Shared graph membership must not duplicate jobs in the overview.
  ui.context.fixture.missions.unshift({ mission: { running: false }, currentWork: view.jobs });
  ui.run('state = fixture');
  let html = ui.run('pipeline(state.selected)');
  assert.match(html, /Codex queue<\/span><div class="queue-total"><strong>3<\/strong>/);
  assert.match(html, /1 running · 1 waiting/);
  assert.match(html, /1 delayed · 1 handing off/);
  assert.match(html, /Server queue<\/span><div class="queue-total"><strong>1<\/strong>/);
  assert.match(html, /data-stage="CODEX"/);
  html = ui.run('pipeline()');
  assert.match(html, /Codex queue<\/span><div class="queue-total"><strong>3<\/strong>/);
  assert.match(html, /1 running · 1 waiting/);
  view.mission.running = false;
  html = ui.run('pipeline(state.selected)');
  assert.match(html, /0 running · 2 waiting/);
  assert.match(html, /A stopped runner shows saved queues/);
});

test('accepted sketches and unique theorem counts appear beside proofs throughout the UI', () => {
  const ui = browser(); ui.context.fixture = snapshot();
  Object.assign(ui.context.fixture.selected.counts, { proofs: 4, reductions: 3, sketched_theorems: 2 });
  Object.assign(ui.context.fixture.totals, { proofs: 4, sketches: 3, sketched_theorems: 2 });
  ui.run('state = fixture');
  assert.match(ui.run('missionPage(state.selected)'), /Sketches accepted<\/span><small>2 unique theorems/);
  assert.match(ui.run('resultsPanel(state.selected)'), /2 have accepted sketches/);
  assert.equal(ui.run("resultLabel({ result: 'sketch_accepted' })"), 'Sketch accepted');
});

test('a newer coordinator quota observation replaces an older account sampler reading', () => {
  const ui = browser(); ui.context.fixture = snapshot();
  ui.context.fixture.account.checkedAt = '2026-10-27T10:00:00Z';
  ui.context.fixture.selected.summary.codex_quota = { last_checked_at: '2026-10-27T10:00:10Z',
    windows: { primary: { used_percent: 100, window_minutes: 300 } } };
  ui.run('state = fixture');
  assert.match(ui.run('capacityCard(state.selected)'), /0% left/);
  ui.context.fixture.account.checkedAt = '2026-10-27T10:00:20Z';
  assert.match(ui.run('capacityCard(state.selected)'), /66% left/);
});

test('failed preparation remains visible in waiting and attention with no active worker', () => {
  const ui = browser(); ui.context.fixture = snapshot();
  const job = ui.context.fixture.selected.jobs[0];
  Object.assign(job, { job_status: 'READY', stage: 'PREPARE', running: false, dispatch_state: 'QUEUED',
    waiting_reason: 'Previous PREPARE failure (ENOSPC): Cannot copy <Mathlib>',
    next_poll_at: new Date(Date.now() + 60000).toISOString() });
  ui.run('state = fixture');
  assert.match(ui.run('missionPage(state.selected)'), /Work blocked/);
  for (const filter of ['waiting', 'attention']) {
    const table = ui.run(`ui.filter = '${filter}'; workTable(state.selected)`);
    assert.match(table, /ENOSPC.*&lt;Mathlib&gt;/);
    assert.match(table, /Next check/);
    assert.match(table, /data-inspect="leaf"/);
  }
});

test('infrastructure blockers appear in current work, attention and the work table with escaped diagnostics', () => {
  const ui = browser(); ui.context.fixture = snapshot();
  const job = ui.context.fixture.selected.jobs[0];
  Object.assign(job, { running: false, dispatch_state: 'DELAYED',
    waiting_reason: 'Sandbox failed <resource error> (0x800705AA)' });
  ui.run('state = fixture');
  ui.context.fixture.selected.frontier.leafIds = ['leaf'];
  assert.match(ui.run('openLeavesPanel(state.selected)'), /Sandbox failed &lt;resource error&gt;/);
  const page = ui.run('missionPage(state.selected)');
  assert.match(page, /Work blocked/);
  assert.doesNotMatch(page, /No operator action required/);
  const table = ui.run("ui.filter = 'attention'; workTable(state.selected)");
  assert.match(table, /Sandbox failed &lt;resource error&gt;/);
  assert.match(table, /data-inspect="leaf"/);
});

test('the root dashboard adopts the default mission for controls, exports and subsequent refreshes', async () => {
  const urls = [];
  const ui = browser(async url => {
    urls.push(url);
    return { ok: true, json: async () => snapshot() };
  });
  await ui.run('refresh()');
  assert.equal(ui.run('ui.missionId'), 'first');
  assert.match(ui.element('#main').innerHTML, /<h1>first mission<\/h1>/);
  assert.match(ui.element('#main').innerHTML, /\/api\/export\?range=run&amp;missionId=first|\/api\/export\?range=run&missionId=first/);
  await ui.run('refresh()');
  assert.match(urls[1], /missionId=first/);
});

test('an already running supervisor opens the active mission without needing a restart', async () => {
  const urls = [];
  const ui = browser(async url => {
    urls.push(url);
    const value = snapshot();
    value.missions.push({ mission: { id: 'saved', running: false } });
    if (!url.includes('missionId=first')) value.selected = null;
    return { ok: true, json: async () => value };
  });
  await ui.run('refresh()');
  assert.equal(urls.length, 2);
  assert.match(urls[1], /missionId=first/);
  assert.match(ui.element('#main').innerHTML, /<h1>first mission<\/h1>/);
});

test('mission and milestone names appear in the dashboard heading and browser title, with escaped markup', () => {
  const ui = browser(); ui.context.fixture = snapshot();
  ui.run("state = fixture; state.selected.mission.target = { kind: 'milestone', name: 'First <step>', mission: { name: 'A & B' } }; render()");
  assert.match(ui.element('#main').innerHTML, /<h1>A &amp; B \/ First &lt;step&gt;<\/h1>/);
  assert.equal(ui.run('document.title'), 'A & B / First <step> · Leaf Runner');
});

test('an empty dashboard offers mission setup without suggesting a collection of missions', () => {
  const ui = browser();
  ui.run('state = { selected: null, missions: [] }; render()');
  assert.match(ui.element('#main').innerHTML, /Set up mission/);
  assert.doesNotMatch(ui.element('#main').innerHTML, /All missions|Your missions|first mission|Mission workspace/);
});

test('changing the time range during a refresh discards the old response and fetches the new range', async () => {
  let release;
  const urls = [];
  const gate = new Promise(resolve => { release = resolve; });
  const ui = browser(async url => {
    urls.push(url);
    if (urls.length === 1) await gate;
    return { ok: true, json: async () => snapshot() };
  });
  ui.run("ui.missionId = 'first'");
  const refresh = ui.run('refresh()');
  ui.run("ui.range = 'day'");
  const nextRefresh = ui.run('refresh()');
  release();
  await Promise.all([refresh, nextRefresh]);
  assert.equal(urls.length, 2);
  assert.match(urls[1], /range=day/);
  assert.equal(ui.run('state.selected.mission.id'), 'first');
});

test('the four-second poll keeps refreshing while a command is waiting for acknowledgement', async () => {
  let reads = 0, recoveries = 0;
  const ui = browser(async (url, options) => ({ ok: true, json: async () => {
    if (url === '/api/session') return { csrf: 'token' };
    if (url === '/api/refresh-missions') {
      recoveries++;
      assert.equal(options.method, 'POST');
      assert.equal(options.headers['X-CSRF-Token'], 'token');
      return { status: 'REFRESHING' };
    }
    reads++;
    return snapshot();
  } }));
  await ui.run('boot()');
  ui.run('busy = true');
  ui.intervals.find(interval => interval.ms === 4000).fn();
  await ui.run('fetching');
  assert.equal(reads, 2);
  assert.equal(recoveries, 1);
  assert.match(ui.element('#connection').innerHTML, /refreshes every 4s/);
});
