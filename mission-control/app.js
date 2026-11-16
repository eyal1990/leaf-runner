import { syncModelPicker } from './model-picker.js';
import { renderMissionSettings, readMissionSettings } from './mission-settings.js';

const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = value => value == null ? '—' : Number(value).toLocaleString();
const paths = {
  stop: '<rect x="6" y="6" width="12" height="12" rx="1"/>',
  pause: '<path d="M8 5v14M16 5v14"/>', play: '<path d="m8 5 11 7-11 7Z"/>',
  refresh: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 8a7 7 0 0 1 12-3l2 3M4 16l2 3a7 7 0 0 0 12-3"/>',
  prepare: '<path d="M7 3h7l4 4v14H6V3Z"/><path d="M13 3v5h5M9 12h6M9 16h4"/>',
  codex: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="m10 8-3 3 3 3M13 15h4"/>',
  validate: '<path d="m12 3 8 3v6c0 4-8 9-8 9s-8-5-8-9V6Z"/><path d="m8 11 3 3 5-6"/>',
  server: '<rect x="4" y="3" width="16" height="7" rx="1"/><rect x="4" y="14" width="16" height="7" rx="1"/><path d="M7 6h1M7 17h1M12 7h5M12 18h5"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  arrow: '<path d="M4 12h16m-6-6 6 6-6 6"/>', plus: '<path d="M12 5v14M5 12h14"/>',
  export: '<path d="M12 3v12m-4-4 4 4 4-4M5 16v5h14v-5"/>', settings: '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="15" cy="17" r="3"/>',
};
const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] ?? paths.prepare}</svg>`;
const params = new URLSearchParams(location.search);
const ui = { missionId: params.get('mission') || null, tab: params.get('tab') || 'work', range: params.get('range') || 'run',
  filter: params.get('filter') || 'active', stage: params.get('stage') || '', search: params.get('search') || '',
  model: params.get('model') || '', taskKind: params.get('kind') || '', sort: params.get('sort') || 'name',
  since: params.get('since') || '', until: params.get('until') || '', theorem: params.get('theorem') || null,
  artifact: '', artifactText: '', artifactSearch: '', follow: false };
let state, csrf, busy = false, connected = false, refreshedAt = 0, toastTimer, inspectorKey, previousFocus;
let confirmAction, fetching, artifactTimer, settingsScope;
let credentialsScope, pendingCredentialStart;
const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
$('#timezone').textContent = timezone;
const fmtDate = value => value ? new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Not observed';
const age = value => {
  if (!value) return '—';
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  return seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s`
    : seconds < 86400 ? `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m` : `${Math.floor(seconds / 86400)}d`;
};
const countdown = value => {
  if (!value) return 'Reset not reported';
  const minutes = Math.ceil((new Date(value).getTime() - Date.now()) / 60000);
  return minutes <= 0 ? 'Reset time passed; awaiting observation' : minutes < 60 ? `Resets in ${minutes}m`
    : `Resets in ${Math.floor(minutes / 60)}h ${minutes % 60}m`;
};
const pretty = text => String(text ?? 'Unknown').replaceAll('_', ' ').toLowerCase().replace(/^./, c => c.toUpperCase());
const periodLabel = () => ({ run: 'Since run start', hour: 'Last hour', day: 'Last 24 hours', custom: 'Custom period' }[ui.range] ?? 'Since run start');
const empty = (title, description) => `<div class="empty-state"><h3>${esc(title)}</h3><p>${esc(description)}</p></div>`;
const badge = (label, kind = '') => `<span class="status-badge ${kind}">${esc(label)}</span>`;
const resultLabel = row => ({ proof_accepted: 'Proof accepted', sketch_accepted: 'Sketch accepted', disproof_accepted: 'Disproof accepted', started: 'Attempt started' }[row.result] ?? pretty(row.result));
const needsAttention = job => !!job.waiting_reason || job.job_status === 'NEEDS_ATTENTION' || /UNKNOWN/.test(job.status ?? '');
const processLabel = mission => mission.running ? mission.processStatus === 'STARTING' ? 'Starting' : mission.processStatus === 'STOPPING' ? 'Saving' : 'Running'
  : ({ REGISTERED: 'Ready to start', COMPLETE: 'Completed', DISPROVED: 'Root disproved', ERROR: 'Error', NEEDS_ATTENTION: 'Needs attention' }[mission.processStatus] ?? 'Stopped');

async function api(path, options = {}) {
  const response = await fetch(path, { signal: AbortSignal.timeout(options.method === 'POST' ? 75000 : 15000), ...options, headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    ...(options.method && options.method !== 'GET' ? { 'X-CSRF-Token': csrf } : {}), ...options.headers } });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? `Request failed (${response.status})`);
  return value;
}
function updateUrl() {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries({ mission: ui.missionId, tab: ui.tab === 'work' ? '' : ui.tab,
    range: ui.range === 'run' ? '' : ui.range, filter: ui.filter === 'active' ? '' : ui.filter, stage: ui.stage,
    search: ui.search, model: ui.model, kind: ui.taskKind, sort: ui.sort === 'name' ? '' : ui.sort,
    since: ui.since, until: ui.until, theorem: ui.theorem })) if (value) query.set(key, value);
  history.replaceState(null, '', `${location.pathname}${query.size ? `?${query}` : ''}`);
}
function queryForState() {
  const query = new URLSearchParams({ range: ui.range });
  if (ui.missionId) query.set('missionId', ui.missionId);
  if (ui.range === 'custom') { query.set('since', ui.since); query.set('until', ui.until); }
  return query;
}
function toast(message) {
  clearTimeout(toastTimer); $('#toast').textContent = message; $('#toast').hidden = false;
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 7000);
}
async function refresh() {
  if (fetching) return fetching;
  fetching = (async () => {
    try {
      let query, next;
      do {
        query = queryForState().toString();
        next = await api(`/api/state?${query}`);
        // Supervisors already running when the UI is updated may still return
        // an overview. Resolve the current mission before showing the dashboard.
        if (query === queryForState().toString() && !next.selected) {
          const current = next.missions.find(row => row.mission.running) ?? next.missions.at(-1);
          if (current && current.mission.id !== ui.missionId) {
            ui.missionId = current.mission.id; updateUrl();
          }
        }
      } while (query !== queryForState().toString());
      state = next;
      if (state.selected && state.selected.mission.id !== ui.missionId) {
        ui.missionId = state.selected.mission.id; updateUrl();
      }
      connected = true; refreshedAt = Date.now();
      render();
      await renderInspector();
    } catch (error) {
      connected = false;
      if (!state) $('#main').innerHTML = `<div class="loading-state"><span class="eyebrow">Connection needed</span><h1>Connect to your mission</h1><p>${esc(error.message)}</p><p class="subtitle">Use the full Mission Control link printed in the terminal.</p></div>`;
      else toast(error.message);
    } finally { fetching = null; renderConnection(); }
  })();
  return fetching;
}
function renderConnection() {
  const elapsed = refreshedAt ? Math.floor((Date.now() - refreshedAt) / 1000) : null;
  $('#connection').innerHTML = `<span class="dot ${connected ? 'live' : 'warn'}"></span>${connected ? 'Connected' : 'Disconnected'}<span class="connection-age"> · ${elapsed === null ? 'no observation' : `updated ${elapsed}s ago`} · refreshes every 4s</span>`;
}
function saveFocus() {
  const focused = document.activeElement;
  return focused?.id ? { id: focused.id, start: focused.selectionStart, end: focused.selectionEnd } : null;
}
function restoreFocus(focus) {
  const element = focus && document.getElementById(focus.id);
  if (!element) return;
  element.focus({ preventScroll: true });
  if (focus.start != null && typeof element.setSelectionRange === 'function' && !['datetime-local', 'number'].includes(element.type)) element.setSelectionRange(focus.start, focus.end);
}
function missionTitle(mission) {
  const target = mission.target;
  const name = target?.name ?? mission.name;
  return target?.kind === 'milestone' && target.mission?.name && target.mission.name !== name
    ? `${target.mission.name} / ${name}` : name;
}
function render() {
  const focus = saveFocus();
  const selected = state.selected;
  document.title = selected ? `${missionTitle(selected.mission)} · Leaf Runner` : 'Mission Control · Leaf Runner';
  $('#main').innerHTML = missionNavigation() + credentialsBanner() + (selected ? missionPage(selected) : setupPage());
  if ($('#app-settings-dialog').open) renderAppSettings();
  if ($('#history-dialog').open) renderMissionHistory();
  restoreFocus(focus);
}
function credentialsBanner() {
  if (!state.credentials || state.credentials.configured) return '';
  return `<div class="banner"><span>${icon('settings')}</span><div><strong>Add your Prove2.me API key</strong><p>Paste your key to start missions. Mission Control saves it for you.</p>${state.credentials.editable ? '<button class="text-button" data-action="credentials">Add API key</button>' : ''}</div></div>`;
}
function renderAppSettings() {
  const credentials = state.credentials;
  $('#app-credentials').innerHTML = `<h3>Prove2.me connection</h3><p class="form-note">${credentials?.source === 'environment' ? 'Using PROVE2ME_API_KEY from the launcher environment. Update it there and restart Mission Control to change keys.' : credentials?.configured ? 'Your Prove2.me API key is saved on this computer.' : 'Add your Prove2.me API key to start missions.'}</p>${credentials?.editable ? `<button class="button" data-action="credentials">${credentials.configured ? 'Update API key' : 'Add API key'}</button>` : ''}`;
}
function showCredentials(startMissionId = null) {
  credentialsScope = { missionId: startMissionId ?? state.selected?.mission.id };
  pendingCredentialStart = startMissionId;
  $('#credentials-error').textContent = '';
  $('#prove2me-key').value = '';
  $('#prove2me-key').disabled = state.credentials?.editable === false;
  $('#credentials-submit').disabled = state.credentials?.editable === false;
  $('#credentials-submit').textContent = startMissionId ? 'Save key and start mission' : 'Save API key';
  if (state.credentials?.editable === false) $('#credentials-error').textContent = 'Update PROVE2ME_API_KEY in the launcher environment, then restart Mission Control.';
  $('#credentials-dialog').showModal();
  $('#prove2me-key').focus();
}
function missionNavigation() {
  const missions = state.missions ?? [];
  const active = missions.find(row => row.mission.running && row.mission.id !== state.selected?.mission.id)?.mission;
  return `<nav class="mission-navigation" aria-label="Mission navigation"><div class="mission-selector"><label for="mission-select">Current mission</label><select id="mission-select" ${missions.length ? '' : 'disabled'}>${missions.length ? missions.map(({ mission }) => `<option value="${esc(mission.id)}" ${mission.id === state.selected?.mission.id ? 'selected' : ''}>${esc(missionTitle(mission))} · ${esc(processLabel(mission))}</option>`).join('') : '<option>No mission selected</option>'}</select></div><div class="mission-navigation-actions"><button class="button" data-action="history">${icon('prepare')} Previous missions <span class="count-label">${missions.length}</span></button><button class="button primary" data-action="add">${icon('plus')} New mission</button></div></nav>${active ? `<div class="mission-running-note"><span><strong>${esc(missionTitle(active))}</strong> is still running. Stop and save it before starting this mission.</span><div><button class="text-button" data-mission="${esc(active.id)}">View running mission ${icon('arrow')}</button>${active.managed ? '<button class="button" data-action="switch-run">Stop and switch</button>' : '<span class="muted">Stop it in its terminal.</span>'}</div></div>` : ''}`;
}
function renderMissionHistory() {
  const query = $('#mission-search').value.trim().toLocaleLowerCase();
  const rows = [...(state.missions ?? [])].reverse().filter(({ mission }) => missionTitle(mission).toLocaleLowerCase().includes(query));
  $('#mission-history').innerHTML = rows.length ? rows.map(({ mission, counts }) => {
    const selected = mission.id === state.selected?.mission.id;
    const saved = mission.finishedAt ?? mission.summaryAt ?? mission.startedAt ?? mission.createdAt;
    return `<article class="mission-history-row"><div class="mission-history-details"><h3>${esc(missionTitle(mission))}</h3><p>${badge(processLabel(mission), mission.running ? 'live' : '')}${selected ? '<span class="muted">Currently viewing</span>' : ''}</p><p class="muted">${saved ? `Last saved or started ${esc(fmtDate(saved))} · ` : ''}${num(counts?.proofs ?? 0)} proofs · ${num(counts?.reductions ?? 0)} sketches</p></div><button class="button" data-mission="${esc(mission.id)}">Open mission</button></article>`;
  }).join('') : empty(query ? 'No matching missions' : 'No saved missions yet', query ? 'Try another mission name.' : 'Choose New mission to get started.');
}
async function selectMission(id) {
  if (busy) { toast('Wait for the current command to finish before switching missions.'); return; }
  if (!state.missions.some(row => row.mission.id === id)) return;
  Object.assign(ui, { missionId: id, tab: 'work', range: 'run', filter: 'active', stage: '', search: '', model: '', taskKind: '', sort: 'name',
    since: '', until: '', theorem: null, artifact: '', artifactText: '', artifactSearch: '', follow: false });
  clearInterval(artifactTimer);
  if ($('#history-dialog').open) $('#history-dialog').close();
  updateUrl(); await renderInspector(); await refresh();
}
function rangeControl() {
  return `<div class="date-filter">${icon('prepare')}<select id="range" aria-label="Activity time range">${[['run', 'Since run start'], ['hour', 'Last hour'], ['day', 'Last 24 hours'], ['custom', 'Custom period']].map(([value, label]) => `<option value="${value}" ${ui.range === value ? 'selected' : ''}>${label}</option>`).join('')}</select></div>`;
}
function customControl() {
  if (ui.range !== 'custom') return '';
  const localInput = value => value ? new Date(new Date(value).getTime() - new Date(value).getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '';
  return `<form id="custom-form" class="custom-dates"><label for="since">From</label><input id="since" type="datetime-local" required value="${localInput(ui.since)}"><label for="until">To</label><input id="until" type="datetime-local" required value="${localInput(ui.until)}"><button class="button small">Apply period</button><span class="muted">${esc(timezone)}</span></form>`;
}
function setupPage() {
  return `<section class="empty-workspace"><span class="empty-symbol" aria-hidden="true">◇</span><p class="eyebrow">Mission Control</p><h1>Your next proof starts here.</h1><p>Set up your mission to follow its frontier, accepted results, and runner status.</p><button class="button primary" data-action="add">${icon('plus')} Set up mission</button><p class="subtitle">You can also launch with <code>--mission "Mission name"</code>.</p></section>`;
}
function missionPage(view) {
  const m = view.mission, s = view.summary, live = m.running, controlled = live && m.managed && m.processStatus === 'RUNNING';
  const paused = s?.operator?.admissionPaused;
  const agentsStopped = s?.operator?.agentsStopped;
  const startBlocked = state.lock || state.missions.some(row => row.mission.running && row.mission.id !== m.id);
  const unresolved = view.jobs.filter(needsAttention);
  // A new managed process can still be paired with the previous checkpoint
  // until its first save. Only that process's diagnostics describe live work.
  const currentSummary = live && (!m.managed || m.managedRunId && m.managedRunId === s?.run_id) ? s : null;
  const savedInterruption = !live && (m.processStatus === 'INTERRUPTED' || s?.status === 'INTERRUPTED') && m.processStatus !== 'ERROR';
  const diagnostic = (savedInterruption ? null : m.error) || (live ? currentSummary?.error : s?.status !== 'INTERRUPTED' && s?.error);
  const credentialFailure = !live && /ENOENT.*credentials.*\.json|Prove2\.me API key required|Fill in api_key/i.test(diagnostic ?? '');
  const error = credentialFailure ? null : diagnostic;
  const waitingQuota = currentSummary?.codex_quota?.status === 'WAITING';
  const banner = error || currentSummary?.api_recovery?.waiting || waitingQuota || !m.managed && live || !live && s?.status === 'RUNNING';
  return `<div class="page-heading"><div><p class="eyebrow heading-kicker">${esc(m.target?.kind === 'milestone' ? 'Mission / milestone' : 'Proof mission')}</p><div class="heading-title"><h1>${esc(missionTitle(m))}</h1>${badge(agentsStopped && live ? 'Agents stopped' : paused && live ? 'Admission paused' : processLabel(m), live ? 'live' : error ? 'error' : '')}</div><p class="subtitle">Root ${esc((s?.root_status ?? 'unobserved').toLowerCase())}<span class="separator">·</span>${esc(s?.limits?.verificationMode === 'server-only' ? 'Server-only verification' : s?.limits?.verificationMode === 'local' ? 'Local verification' : 'Verification mode available on start')}<span class="separator">·</span>${live ? `Running ${age(s?.started_at ?? m.startedAt)}` : s?.finished_at ? `Saved ${fmtDate(s.finished_at)}` : 'Ready when you are'}</p></div>
    <div class="header-actions">${controlled ? `<button class="button outline-teal" data-action="${agentsStopped ? 'resume-agents' : 'stop-agents'}">${icon(agentsStopped ? 'play' : 'stop')} ${agentsStopped ? 'Resume agents' : 'Stop agents'}</button>` : !live ? `<button class="button primary" data-action="start" ${startBlocked ? 'disabled title="Stop and save the current runner before starting."' : ''}>${icon('play')} ${s ? 'Start saved run' : 'Start mission'}</button>` : ''}<button class="button" data-action="settings">${icon('settings')} Run settings</button><button class="button icon-only" data-action="refresh" aria-label="Refresh status" title="Refresh saved status">${icon('refresh')}</button><div class="menu-wrap"><button class="button icon-only" data-action="menu" aria-label="Mission actions" aria-expanded="false">${icon('more')}</button><div class="overflow-menu" id="mission-menu" hidden>${controlled ? `<button data-action="${paused ? 'resume-admission' : 'pause-admission'}">${icon(paused ? 'play' : 'pause')} ${paused ? 'Resume new work' : 'Pause new work'}</button><button data-action="${s?.operator?.dispatchPaused ? 'resume-dispatch' : 'pause-dispatch'}">${icon(s?.operator?.dispatchPaused ? 'play' : 'pause')} ${s?.operator?.dispatchPaused ? 'Resume Codex dispatch' : 'Pause Codex dispatch'}</button>` : ''}<a href="/api/export?${queryForState()}">${icon('export')} Export report</a>${live && m.managed ? `<button class="danger" data-action="stop">${icon('pause')} Stop and save</button>` : ''}</div></div></div></div>
    <div class="toolbar"><span class="muted">Controls apply to <strong>${esc(m.name)}</strong>${m.target?.root ? ` · <a href="https://prove2.me/theorems/${encodeURIComponent(m.target.root)}" target="_blank" rel="noreferrer">Exact root ↗</a>` : ''}</span>${rangeControl()}</div>${customControl()}
    ${banner ? `<div class="banner"><span class="banner-icon">!</span><div><strong>${esc(waitingQuota ? 'Codex waiting for account limits. Submitted work continues.' : !m.managed && live ? 'Monitoring a runner started outside Mission Control' : !live && s?.status === 'RUNNING' ? 'The saved checkpoint says running; no live process is connected' : error ? `${live ? '' : 'Previous run failed: '}${error}` : 'Waiting for shared API recovery')}</strong><p>${waitingQuota ? `Next availability check ${fmtDate(s.codex_quota.next_check_at)}. ${s.codex_quota.last_check_error ? esc(s.codex_quota.last_check_error) : 'Recovery is automatic. You can check immediately after an early reset.'}` : !m.managed && live ? 'Use its console to stop it. Start it here afterward to enable managed controls.' : 'Saved work and remote-operation identities are preserved. Inspect the details before restarting.'}</p></div></div>` : ''}
    ${agentsStopped && live ? `<div class="banner neutral"><span>${icon('stop')}</span><div><strong>Agents stopped for ${esc(m.name)}</strong><p>Active proof, repair, and research agents are cancelled. No new agent starts until you resume. Preparation, validation, submissions, and server polling continue.</p></div></div>` : ''}
    ${s?.operator?.dispatchPaused && live ? `<div class="banner neutral"><span>${icon('pause')}</span><div><strong>Codex dispatch paused for ${esc(m.name)}</strong><p>No new proof, repair, or research invocation starts. Active invocations finish; validation and server work continue. Account recovery leaves this operator pause in place.</p></div></div>` : paused && live ? `<div class="banner neutral"><span>${icon('pause')}</span><div><strong>New theorem admission paused for ${esc(m.name)}</strong><p>Already admitted work continues. Queued jobs can still invoke Codex.</p></div></div>` : ''}
    ${unresolved.length ? `<div class="mobile-attention">${attentionCard(view, unresolved)}</div>` : ''}
    ${currentSummary?.proof_storage_recovery?.waiting ? `<div class="banner"><span>${icon('pause')}</span><div><strong>Codex paused while proof storage recovers</strong><p>Retrying ${num(s.proof_storage_recovery.jobs.length)} saved proof(s) automatically. New Codex runs resume when every affected proof gets a completed result other than the storage error. Active runs can finish.</p></div></div>` : ''}
    <div class="dashboard-grid"><div class="main-column">
    <section class="panel panel-inner"><div class="summary-label"><span class="eyebrow">Results <span class="muted">/ ${esc(periodLabel())}</span></span><span class="muted" title="Counts use confirmed submission IDs and local verdict observation times">↗</span></div><div class="metric-grid">${[['Proofs accepted', view.counts.proofs, 'teal', `${view.counts.proved_theorems} unique theorems`], ['Sketches accepted', view.counts.reductions, 'teal', `${num(view.counts.sketched_theorems)} unique theorems`], ['Disproofs accepted', view.counts.disproofs, '', 'May apply to child theorems'], ['Pending remote · Now', view.counts.pending, view.counts.unknown ? 'amber' : '', view.counts.unknown ? `${view.counts.unknown} status unknown` : 'Unfinished operations']].map(([label, value, color, note]) => `<div class="metric"><strong class="metric-number ${color}">${num(value)}</strong><span class="metric-label">${label}</span><small>${esc(note)}</small></div>`).join('')}</div></section>
    ${pipeline(view)}
    ${preparationPanel(view, currentSummary)}
    <section class="panel panel-inner"><div class="summary-label"><span class="eyebrow">Open leaves <span class="muted">/ Now</span></span><button class="text-button" data-tab="dependencies">Dependencies ${icon('arrow')}</button></div><div class="frontier"><button class="frontier-stat text-button" data-tab="leaves" aria-label="View open leaves"><strong>${num(view.frontier?.leaves)}</strong><span>open leaf theorems</span></button><div class="frontier-stat"><strong>${num(view.frontier?.selectable)}</strong><span>selectable tasks</span></div><span class="muted">${num(view.frontier?.repairs)} repairs</span></div><p class="frontier-meta">${view.graph ? `Open leaves are unresolved theorems with no usable reduction into smaller tasks, including parents needing a new sketch and theorems already claimed by a worker. Siblings needed only by a disproved sketch are excluded. Graph observed ${fmtDate(view.graph.observed_at)} (${age(view.graph.observed_at)} ago).${s?.graph_reconciling ? ' Refreshing graph…' : ''}` : s?.graph_reconciling || m.running ? 'Refreshing graph… Frontier counts will appear when it completes.' : 'Frontier counts will appear after the runner observes the graph.'}</p></section>
    <div class="tabs" role="tablist" aria-label="Mission detail">${['work', 'leaves', 'results', 'dependencies', 'research', 'activity'].map(tab => `<button class="tab ${ui.tab === tab ? 'selected' : ''}" data-tab="${tab}" role="tab" aria-selected="${ui.tab === tab}" id="tab-${tab}" aria-controls="tab-content">${tab === 'leaves' ? 'Open leaves' : pretty(tab)}</button>`).join('')}</div>
    <div id="tab-content" role="tabpanel" aria-labelledby="tab-${ui.tab}">${({ work: workTable, leaves: openLeavesPanel, results: resultsPanel, dependencies: dependencyPanel, research: researchPanel, activity: activityPanel }[ui.tab] ?? workTable)(view)}</div>
    ${ui.tab === 'work' ? recentResults(view) : ''}
    </div><div class="side-column">${capacityCard(view)}${attentionCard(view, unresolved)}${runnerCard(view)}</div></div>`;
}
function preparationCounts(status) {
  return status?.phase === 'copy' ? `${num(status.files_copied ?? 0)} files copied · ${((status.bytes_copied ?? 0) / 1024 ** 2).toFixed(1)} MiB copied` : '';
}
function preparationDetails(status) {
  const recent = Date.now() - Date.parse(status.updated_at) < 20000;
  return `<p class="preparation-message">${esc(status.message)}</p>${preparationCounts(status) ? `<p class="preparation-counts">${esc(preparationCounts(status))}</p>` : ''}<p class="capacity-help">Elapsed ${age(status.started_at)} · Last update ${age(status.updated_at)} ago</p>${recent ? '<div class="preparation-bar" role="progressbar" aria-label="Workspace preparation in progress" aria-valuetext="In progress; total size unknown"><span></span></div>' : '<p class="capacity-help amber">No recent preparation update. Check the runner connection and terminal for details.</p>'}`;
}
function preparationPanel(view, currentSummary) {
  if (!currentSummary) return '';
  const jobs = view.jobs.filter(job => job.running && job.preparation);
  if (!jobs.length) return '';
  return `<section class="panel workspace-preparation" aria-label="Workspace preparation"><div class="panel-heading"><h2>Preparing workspaces</h2></div><p class="panel-note">First-time setup can take several minutes. Progress updates automatically; a large file can take time before the counters increase.</p><div role="status" aria-live="polite">${jobs.map(job => `<div class="preparation-job"><button class="text-button" data-inspect="${esc(job.theorem_id)}">${esc(job.theorem_name)}</button>${preparationDetails(job.preparation)}</div>`).join('')}</div></section>`;
}
function pipeline(view) {
  const sources = view ? [{ mission: view.mission, jobs: view.jobs }] : state.missions.map(row => ({ mission: row.mission, jobs: row.currentWork ?? [] }));
  const uniqueJobs = new Map();
  for (const source of sources) for (const job of source.jobs) {
    if (job.job_status !== 'ACTIVE') continue;
    if (!uniqueJobs.has(job.theorem_id) || source.mission.running) {
      uniqueJobs.set(job.theorem_id, { ...job, running: source.mission.running && job.running });
    }
  }
  const jobs = [...uniqueJobs.values()];
  return `<section class="panel"><div class="panel-heading"><h2>Theorem queues <span class="muted now">Now</span></h2>${view ? `<button class="text-button" data-action="all-work">View all work ${icon('arrow')}</button>` : ''}</div><div class="pipeline-grid">${['PREPARE', 'CODEX', 'VALIDATE', 'SERVER'].map(stage => {
    const rows = jobs.filter(job => job.stage === stage);
    const running = rows.filter(job => job.running).length;
    const handoffs = rows.filter(job => !job.running && job.dispatch_state === 'HANDOFF_PENDING').length;
    const delayed = rows.filter(job => !job.running && job.dispatch_state === 'DELAYED').length;
    const waiting = rows.length - running - handoffs;
    const cap = view?.summary?.limits?.queues?.[stage];
    const tag = view ? 'button' : 'div';
    return `<${tag} class="stage-card ${running ? 'active' : ''} ${view && ui.stage === stage ? 'chosen' : ''}" ${view ? `data-stage="${stage}" title="Show theorem jobs in the ${pretty(stage)} queue"` : ''}><span class="stage-name">${icon(stage.toLowerCase())}${pretty(stage)} queue</span><div class="queue-total"><strong>${num(rows.length)}</strong><span>theorem jobs</span></div><div class="stage-count">${num(running)} running · ${num(waiting)} waiting</div><div class="stage-foot">${num(delayed)} delayed · ${num(handoffs)} handing off</div>${cap ? `<div class="stage-foot">Worker capacity: ${num(cap.concurrency)}</div>` : ''}</${tag}>`;
  }).join('')}</div><div class="panel-note">Each active theorem job appears in its current queue. Delayed jobs are included in waiting. Saved handoffs stay in their current queue until transferred. Research uses Codex capacity separately.${sources.some(source => !source.mission.running && source.jobs.some(job => job.job_status === 'ACTIVE')) ? ' A stopped runner shows saved queues with zero running workers.' : ''}</div></section>`;
}
function capacityCard(view) {
  const s = view?.summary, account = state.account, quota = s?.codex_quota;
  const useQuota = quota?.windows && (!account.windows || (Date.parse(quota.last_checked_at) || 0) > (Date.parse(account.checkedAt) || 0));
  const windows = Object.values((useQuota ? quota.windows : account.windows) ?? {});
  const checkedAt = useQuota ? quota.last_checked_at : account.checkedAt;
  const meter = (label, value, cap, note) => `<div class="capacity-item"><div class="capacity-title"><span>${label}</span><strong>${num(value)} / ${num(cap)}</strong></div>${value != null && cap ? `<progress value="${value}" max="${cap}" aria-label="${label}"></progress>` : ''}<p class="capacity-help">${esc(note)}</p></div>`;
  return `<section class="panel capacity-panel"><div class="panel-heading"><h2>Capacity <span class="muted now">Now</span></h2>${icon('server')}</div><div class="panel-inner">
    ${s ? `${meter('Local jobs', s.pipeline?.localActive, s.limits?.maxActiveJobs, 'Admitted local theorem jobs')}${s.limits?.verificationMode === 'server-only' ? meter('Remote commitment', (s.pipeline?.remoteActive ?? 0) + (s.pipeline?.localActive ?? 0), s.limits?.maxRemoteJobs, `${num(s.pipeline?.remoteActive)} remote + ${num(s.pipeline?.localActive)} local reservations`)
      : meter('Active jobs', s.pipeline?.active, s.limits?.maxActiveJobs, 'Local mode: overall active-job cap')}<hr class="section-divider">` : ''}
    <h3 class="account-heading">Codex account limits</h3><p class="account-scope">${esc(account.account ?? 'Current local Codex account')}<br>Shared account usage; includes activity outside this run.</p>
    ${windows.length ? windows.map(w => {
      const duration = w.window_minutes >= 1440 && w.window_minutes % 1440 === 0 ? `${w.window_minutes / 1440}-day` : w.window_minutes >= 60 && w.window_minutes % 60 === 0 ? `${w.window_minutes / 60}-hour` : `${w.window_minutes ?? 'Unknown'}-minute`;
      const remaining = w.used_percent == null ? null : Math.min(100, Math.max(0, 100 - w.used_percent));
      return `<div class="capacity-item"><div class="capacity-title"><span>${duration} window</span><strong>${remaining == null ? 'Unknown' : `${num(remaining)}% left`}</strong></div>${remaining != null ? `<progress class="${remaining <= 30 ? 'warning' : ''}" value="${remaining}" max="100" aria-label="${duration} remaining capacity"></progress>` : ''}<p class="capacity-help">${remaining == null ? 'Remaining capacity unknown' : `${num(w.used_percent)}% used`} · ${countdown(w.resets_at)}<br>Reset ${fmtDate(w.resets_at)}</p></div>`;
    }).join('') : `<p class="capacity-help">${account.checking ? 'Reading authoritative account limits…' : 'No account-limit observation yet. Check limits to read current usage.'}</p>`}
    ${account.blockReason ? `<p class="capacity-help amber">${esc(account.blockReason)}</p>` : ''}
    ${account.error ? `<div class="attention-item"><strong>Account observation is stale</strong><p>${esc(account.error)} Previous usage is retained.</p></div>` : ''}
    ${quota?.status === 'WAITING' && view?.mission.managed ? '<button class="button" data-action="check-quota-now">Check recovery now</button>' : ''}
    ${quota?.status && quota.status !== 'OPEN' ? `<hr class="section-divider"><p class="capacity-help amber">${quota.status === 'PROBING' ? 'Testing recovery with one saved invocation' : 'Waiting for account limits'}<br>Next availability check ${fmtDate(quota.next_check_at)}${quota.resets_at ? `<br>Expected exhausted-window recovery ${fmtDate(quota.resets_at)}` : ''}</p>` : ''}
    <div class="account-footer"><span>${checkedAt ? `Checked ${age(checkedAt)} ago` : 'Not checked'} · auto-check every 60s</span><button class="text-button" data-action="limits" ${account.checking ? 'disabled' : ''}>${account.checking ? 'Checking…' : 'Check limits now'}</button></div></div></section>`;
}
function attentionCard(view, items) {
  return `<section class="panel attention-panel"><div class="panel-heading"><h2>Needs attention <span class="count-label">${items.length}</span></h2>${items.length ? '<span class="amber">△</span>' : ''}</div><div class="panel-inner">${items.length ? items.slice(0, 5).map(j => `<div class="attention-item"><strong>${j.waiting_reason ? 'Work blocked' : /UNKNOWN/.test(j.status ?? '') ? 'Remote status unknown' : pretty(j.status ?? j.job_status)}</strong><p>${esc(j.theorem_name)}${j.waiting_reason ? ` ? ${esc(j.waiting_reason)}` : ''}${j.remote_issued ? ' · The coordinator reconciles the existing operation before any replacement.' : ''}</p><button class="text-button" data-inspect="${esc(j.theorem_id)}">Inspect operation ${icon('arrow')}</button></div>`).join('') : `<div class="attention-empty"><span class="check-circle">✓</span><span>No operator action required.</span></div>`}</div></section>`;
}
function runnerCard(view) {
  const s = view.summary, m = view.mission;
  return `<section class="panel settings-preview"><div class="panel-heading"><h2>Runner details</h2></div><div class="panel-inner"><div class="detail-line"><span>Run ID</span><span class="mono" title="${esc(s?.run_id)}">${esc(s?.run_id?.slice(0, 12) ?? 'Not started')}</span></div><div class="detail-line"><span>Runner</span><span>${s?.runner_pid ? `PID ${s.runner_pid}` : 'Not connected'}</span></div><div class="detail-line"><span>Process</span><span>${esc(processLabel(m))}</span></div><div class="detail-line"><span>Root outcome</span><span>${esc(s?.root_status ?? 'Unobserved')}</span></div>${view.configSettings?.pending ? '<p class="capacity-help amber">Saved settings differ from the running settings. Inspect settings to compare.</p>' : ''}<details class="freshness-details"><summary>Observation freshness</summary><p>Browser: ${fmtDate(state.observedAt)}<br>Runner heartbeat: ${fmtDate(m.heartbeatAt)}<br>Checkpoint: ${fmtDate(s?.updated_at)}<br>Graph: ${fmtDate(view.graph?.observed_at)}<br>Account limits: ${fmtDate(state.account.checkedAt)}<br>Timezone: ${esc(timezone)}</p></details><button class="text-button" data-action="settings">${icon('settings')} Inspect saved settings</button></div></section>`;
}
function workTable(view) {
  let rows = ui.filter === 'ready' ? (view.summary?.ready_work ?? []).map(row => ({ ...row, ready: true, stage: '',
    total_attempts: row.totalAttempts, context_attempts: row.attemptsInCurrentContext })) : view.jobs.filter(j => ui.filter === 'all' || ui.filter === 'active' && j.job_status === 'ACTIVE'
    || ui.filter === 'waiting' && (j.job_status === 'ACTIVE' && !j.running || j.job_status === 'READY' && j.waiting_reason)
    || ui.filter === 'attention' && needsAttention(j));
  rows = rows.filter(j => (!ui.stage || j.stage === ui.stage) && (!ui.search || `${j.theorem_name} ${j.theorem_id}`.toLowerCase().includes(ui.search.toLowerCase()))
    && (!ui.model || (j.worker_model ?? j.model) === ui.model) && (!ui.taskKind || (j.task_kind ?? (j.operation === 'reconsider_reduction' ? 'parent' : 'leaf')) === ui.taskKind));
  rows.sort(ui.sort === 'elapsed' ? (a, b) => (Date.parse(a.updated_at) || 0) - (Date.parse(b.updated_at) || 0)
    : ui.sort === 'priority' ? (a, b) => (b.score ?? 0) - (a.score ?? 0) : (a, b) => (a.theorem_name ?? a.theorem_id).localeCompare(b.theorem_name ?? b.theorem_id));
  const models = [...new Set(view.jobs.map(j => j.worker_model ?? j.model).filter(Boolean))];
  return `<section class="panel"><div class="panel-heading"><h2>${({ active: 'Active work', ready: 'Ready next', waiting: 'Waiting work', attention: 'Needs attention', all: 'All saved work' }[ui.filter] ?? 'Work')} <span class="count-label">${rows.length} ${ui.filter === 'ready' ? 'tasks' : 'jobs'}</span></h2>${ui.stage ? `<button class="text-button" data-stage="">Clear ${pretty(ui.stage)} filter ×</button>` : ''}</div><div class="work-filters">${[['active', 'Active'], ['ready', 'Ready next'], ['waiting', 'Waiting'], ['attention', 'Needs attention'], ['all', 'All']].map(([value, label]) => `<button class="pill ${ui.filter === value ? 'selected' : ''}" data-filter="${value}">${label}</button>`).join('')}</div>
    <div class="table-tools"><input id="work-search" placeholder="Find theorem…" aria-label="Find theorem" value="${esc(ui.search)}"><select id="model-filter" aria-label="Filter by model"><option value="">All models</option>${models.map(m => `<option value="${esc(m)}" ${ui.model === m ? 'selected' : ''}>${esc(m)}</option>`).join('')}</select><select id="kind-filter" aria-label="Filter by task kind"><option value="">All task kinds</option><option value="leaf" ${ui.taskKind === 'leaf' ? 'selected' : ''}>Leaves</option><option value="parent" ${ui.taskKind === 'parent' ? 'selected' : ''}>Parent / cycle repair</option></select><select id="sort" aria-label="Sort work">${[['name', 'Theorem name'], ['elapsed', 'Longest waiting'], ['priority', 'Highest score']].map(([v, l]) => `<option value="${v}" ${ui.sort === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
    <div class="table-scroll"><table><thead><tr><th>Theorem</th><th>${ui.filter === 'ready' ? 'Task' : 'Stage / operation'}</th><th>${ui.filter === 'ready' ? 'Selection reason' : 'State / reason'}</th><th>Model</th><th>Attempts</th><th>${ui.filter === 'ready' ? 'Score' : 'Updated'}</th><th></th></tr></thead><tbody>${rows.slice(0, 150).map(j => `<tr class="work-row" data-inspect="${esc(j.theorem_id)}" tabindex="0" aria-label="Inspect ${esc(j.theorem_name ?? j.theorem_id)}"><td><span class="theorem-name">${esc(j.theorem_name ?? j.theorem_id)}</span><small class="row-subtitle mono">${esc(j.theorem_id.slice(0, 12))}</small></td><td>${j.ready ? badge(pretty(j.task_kind)) : `<span class="stage-tag ${esc(j.stage)}">${esc(pretty(j.stage))}</span><span class="row-subtitle">${esc(pretty(j.operation))}</span>`}</td><td>${j.ready ? esc(selectionReason(j)) : esc(j.waiting_reason ?? (j.running ? 'Running' : j.dispatch_state === 'HANDOFF_PENDING' ? 'Saved handoff' : j.dispatch_state === 'DELAYED' ? 'Delayed' : pretty(j.status ?? j.dispatch_state)))}${j.next_poll_at ? `<small class="row-subtitle">Next check ${fmtDate(j.next_poll_at)}</small>` : ''}</td><td>${esc((j.worker_model ?? j.model)?.replace('gpt-', '') ?? '—')}</td><td>${num(j.total_attempts)} <span class="muted">/ ${num(j.context_attempts)} ctx</span></td><td>${j.ready ? num(j.score) : age(j.updated_at)}</td><td class="muted">›</td></tr>`).join('')}</tbody></table></div>${!rows.length ? empty(ui.filter === 'ready' ? 'No selectable tasks in this observation' : 'No work matches this view', ui.filter === 'active' ? 'Active jobs appear here after the runner claims a theorem. Check Ready next or All for saved work.' : 'Try another filter. An empty queue does not establish that the root is proved.') : ''}<div class="table-bottom"><span>${rows.length > 150 ? `Showing 150 of ${rows.length}; narrow the filters.` : `${rows.length} ${ui.filter === 'ready' ? 'tasks' : 'jobs'} · one row per theorem job`}</span><span>${ui.filter === 'ready' ? 'Score-based selection, not FIFO' : 'Attempts: lifetime / current context'}</span></div>${view.summary?.mission_research?.model_running && view.mission.running ? `<div class="panel-note">Research is using one Codex worker. It is advisory work and is excluded from theorem-job counts.</div>` : ''}</section>`;
}
function openLeavesPanel(view) {
  const nodes = new Map([view.root, ...(view.graph?.nodes ?? [])].filter(Boolean).map(node => [node.theorem_id, node]));
  const jobs = new Map(view.jobs.map(job => [job.theorem_id, job]));
  const ids = view.frontier?.leafIds ?? [];
  return `<section class="panel"><div class="panel-heading"><h2>Open leaves <span class="count-label">${ids.length} theorems · Now</span></h2></div>
    ${ids.length ? `<div class="table-scroll"><table><thead><tr><th>Theorem</th><th>Work status</th><th>Queue</th><th>Model</th></tr></thead><tbody>${ids.map(id => {
      const node = nodes.get(id), job = jobs.get(id);
      return `<tr class="work-row" data-inspect="${esc(id)}" tabindex="0" aria-label="Inspect ${esc(node?.theorem_name ?? id)}"><td><span class="theorem-name">${esc(node?.theorem_name ?? job?.theorem_name ?? id)}</span><small class="row-subtitle mono">${esc(id)}</small></td><td>${esc(job?.waiting_reason ?? (job?.running ? 'Running' : job?.remote_issued ? 'Awaiting server result' : job?.job_status === 'ACTIVE' ? 'Queued' : 'Not currently admitted'))}</td><td>${esc(job?.stage ? pretty(job.stage) : '—')}</td><td>${esc(job?.worker_model ?? job?.model ?? '—')}</td></tr>`;
    }).join('')}</tbody></table></div>` : empty(view.frontier ? 'No open leaves in this observation' : 'Frontier not observed yet', view.frontier ? 'Check the root status and dependencies for remaining work.' : 'Open leaves appear when the runner saves its graph.')}
    <div class="panel-note">All open leaves in this mission’s current frontier, including work that has not been admitted. Independent of the results time range.</div></section>`;
}
function selectionReason(job) {
  return job.cycle_members ? 'Repair an ungrounded dependency cycle' : job.task_kind === 'parent' ? 'Repair an invalidated reduction'
    : job.closability > 0 ? `May close ${job.closability} ancestors (scheduler estimate)` : job.totalAttempts > 0 ? 'Selected after previous attempts' : 'Open leaf in the current frontier';
}
function recentResults(view) {
  return `<section class="panel"><div class="panel-heading"><h2>Recent accepted results</h2><button class="text-button" data-tab="results">All results ${icon('arrow')}</button></div>${view.results.length ? view.results.slice(0, 3).map(resultRow).join('') : empty('No accepted results in this period', 'Confirmed server verdicts appear here as they are observed.')}</section>`;
}
function resultRow(row) {
  return `<div class="activity-item"><span class="check-circle">${row.kind === 'reduction' ? '⋈' : '✓'}</span><div><strong>${esc(resultLabel(row))}</strong><p><button class="text-button" data-inspect="${esc(row.theorem_id)}">${esc(row.theorem_name)}</button></p></div><span class="activity-time" title="${fmtDate(row.observed_at)}">${new Date(row.observed_at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</span></div>`;
}
function resultsPanel(view) {
  return `<section class="panel"><div class="panel-heading"><h2>Accepted results <span class="count-label">${view.results.length}</span></h2><a class="text-button" href="/api/export?${queryForState()}">${icon('export')} Export</a></div>${view.results.length ? view.results.map(resultRow).join('') : empty('No accepted results in this period', 'Results require a confirmed server verdict and a distinct submission ID.')}<div class="panel-note">${esc(view.coverage)} A child disproof does not imply that the root is disproved. ${num(view.counts.proved_theorems)} unique theorems have accepted proofs and ${num(view.counts.sketched_theorems)} have accepted sketches in this period.</div></section><section class="panel"><div class="panel-heading"><h2>Pending remote work <span class="count-label">Now · ${view.pending.length}</span></h2></div>${view.pending.length ? `<ul class="plain-list">${view.pending.map(p => `<li><button class="text-button" data-inspect="${esc(p.theorem_id)}">${esc(p.theorem_id)}</button><br>${esc(pretty(p.status))} · ${p.unknown ? 'Outcome unknown' : `Submission ${esc(p.submission_id)}`}<br><span class="muted">${p.started_at ? `Started ${fmtDate(p.started_at)}` : 'Start time unavailable'}</span></li>`).join('')}</ul>` : empty('No pending remote operations', 'Current pending work is shown independently of the selected time range.')}</section>`;
}
function dependencyPanel(view) {
  const nodes = view.graph?.nodes ?? [];
  const root = view.root;
  return `<section class="panel"><div class="panel-heading"><h2>Path to the root</h2><span class="muted">${nodes.length} observed nodes</span></div>${root ? `<div class="dependency-root"><strong>${esc(root.theorem_name ?? root.theorem_id)}</strong><small>${esc(root.status)} · root outcome is independent of runner status</small></div><div class="panel-note">${esc(view.graph.coverage)} · Observed ${fmtDate(view.graph.observed_at)}. Each reduction is an alternative route (OR); all children within it are required (AND).</div>${nodes.slice(0, 100).map(node => `<details class="dependency-node" ${node.theorem_id === root.theorem_id ? 'open' : ''}><summary>${esc(node.theorem_name ?? node.theorem_id)} ${badge(node.status ?? 'Unobserved', node.status === 'Proved' ? 'live' : '')}</summary><button class="text-button" data-inspect="${esc(node.theorem_id)}">Inspect theorem ${icon('arrow')}</button>${node.reductions.length ? node.reductions.map((reduction, index) => `<div class="reduction"><p>Alternative ${index + 1} · ${esc(reduction.submission_id)} · ${reduction.usable === false ? 'Blocked route' : 'All children required'}</p>${reduction.children.map(child => `<div class="dependency-child"><span class="muted">↳</span><button class="text-button" data-inspect="${esc(child.theorem_id ?? child.definition_id)}">${esc(child.theorem_name ?? child.theorem_id ?? child.definition_id)}</button>${badge(child.status ?? (child.definition_id ? 'Definition' : 'Unobserved'))}</div>`).join('')}</div>`).join('') : '<p class="capacity-help">No reduction in this solver snapshot.</p>'}</details>`).join('')}${nodes.length > 100 ? '<div class="panel-note">Showing the first 100 nodes. The export contains the full observed list.</div>' : ''}` : empty('No graph observation yet', 'Start this mission to discover its root and open frontier.')}</section>`;
}
function researchPanel(view) {
  const r = view.summary?.mission_research;
  return `<section class="panel"><div class="panel-heading"><h2>Mission research</h2>${badge(r?.reviewing && view.mission.running ? 'Reviewing' : 'Advisory notes', r?.reviewing ? 'live' : '')}</div>${view.research?.notes ? `<p class="panel-note">Latest completed review · ${fmtDate(view.research.createdAt)} · ${num(r?.reviewed_nodes)} nodes reviewed. Suggestions are advisory and are not accepted dependencies.</p><div class="research-notes">${esc(view.research.notes)}</div>${view.research.sources.length ? `<div class="source-list"><h3>Sources</h3>${view.research.sources.map(source => /^https:\/\//.test(source.url) ? `<p><a href="${esc(source.url)}" target="_blank" rel="noreferrer">${esc(source.url)} ↗</a><br>${esc(source.purpose)}</p>` : '').join('')}</div>` : ''}` : empty('No completed advisory review yet', `Research shares the Codex worker cap and account quota. ${num(r?.observed_nodes ?? 0)} distinct nodes observed; ${num(r?.reviewed_nodes ?? 0)} reviewed.`)}${r?.last_error ? `<div class="panel-note amber">${esc(r.last_error)}</div>` : ''}</section>`;
}
function activityPanel(view) {
  return `<section class="panel"><div class="panel-heading"><h2>Attempt activity <span class="count-label">${esc(periodLabel())}</span></h2></div>${view.activity.length ? view.activity.slice(0, 200).map(row => `<div class="activity-item"><span class="dot ${row.kind ? 'live' : ''}"></span><div><strong>${esc(resultLabel(row))}</strong><p><button class="text-button" data-inspect="${esc(row.theorem_id)}">${esc(row.theorem_name)}</button> · attempt ${num(row.attempt)}${row.model ? ` · ${esc(row.model)}` : ''}</p></div><span class="activity-time">${fmtDate(row.observed_at)}</span></div>`).join('') : empty('No recorded activity in this period', 'Attempt events and accepted verdicts appear as the runner saves them.')}<div class="panel-note">Console logs continue in the terminal. Open a theorem inspector to load an individual redacted log on demand.</div></section>`;
}
async function renderInspector(force = false) {
  const panel = $('#inspector'), view = state?.selected;
  if (!ui.theorem || !view) { panel.hidden = true; inspectorKey = null; clearInterval(artifactTimer); return; }
  const job = view.jobs.find(j => j.theorem_id === ui.theorem), node = view.graph?.nodes.find(n => n.theorem_id === ui.theorem) ?? (view.root?.theorem_id === ui.theorem ? view.root : null);
  const ready = view.summary?.ready_work.find(j => j.theorem_id === ui.theorem);
  const key = JSON.stringify([ui.theorem, job?.revision, job?.running, job?.preparation?.updated_at, node?.status]);
  if (!force && key === inspectorKey) return;
  inspectorKey = key;
  const scroll = panel.scrollTop;
  const focus = saveFocus();
  const detail = (label, value) => `<div class="detail-line"><span>${label}</span><span class="mono">${esc(value ?? '—')}</span></div>`;
  panel.innerHTML = `<div class="inspector-heading"><span class="eyebrow">Theorem inspector</span><button class="icon-button" data-action="close-inspector" aria-label="Close inspector">×</button></div><h2>${esc(node?.theorem_name ?? job?.theorem_name ?? ready?.theorem_name ?? ui.theorem)}</h2><span class="muted mono">${esc(ui.theorem)}</span><div class="inspector-tools"><button class="button small" data-action="copy-link">Copy link</button>${job?.remote_issued ? badge('Remote effects issued', 'warn') : badge(node?.status ?? pretty(job?.status))}</div><p class="capacity-help">Mission: ${esc(view.mission.name)} · ${ui.theorem === view.mission.target?.root ? 'Exact mission root' : 'Observed in the selected root’s work or dependency graph'}</p>
    <section class="inspector-section"><h3>Exact statement</h3>${node?.formal_statement ? `<pre>${esc(node.formal_statement)}</pre>${node.preamble ? `<details><summary>Preamble</summary><pre>${esc(node.preamble)}</pre></details>` : ''}` : '<p class="capacity-help">No theorem statement in this observation.</p>'}</section>
    ${ready ? `<section class="inspector-section"><h3>Scheduler selection</h3><p class="capacity-help">${esc(selectionReason(ready))}</p>${detail('Score', ready.score)}${detail('Operation', ready.operation)}${ready.cycle_members ? `<p class="capacity-help">Cycle members: ${esc(ready.cycle_members.map(m => m.theorem_name ?? m.theorem_id).join(', '))}</p>` : ''}</section>` : ''}
    ${job ? `<section class="inspector-section"><h3>Current job & ownership</h3>${detail('Job ID', job.job_id)}${detail('Attempt ID', job.attempt_id)}${detail('Run ID', job.run_id)}${detail('Revision', job.revision)}${detail('Stage / operation', `${job.stage ?? '—'} / ${job.operation ?? '—'}`)}${detail('Dispatch / state', `${job.dispatch_state ?? '—'} / ${job.status ?? job.job_status}`)}${detail('Worker', job.running ? job.worker_model ?? job.stage : 'No active worker')}${detail('Attempts · lifetime / context', `${num(job.total_attempts)} / ${num(job.context_attempts)}`)}${detail('Next poll', job.next_poll_at ? fmtDate(job.next_poll_at) : 'No scheduled poll')}${Object.entries(job.stage_wait_ms ?? {}).map(([stage, ms]) => detail(`${pretty(stage)} wait`, `${Math.round(ms / 1000)}s`)).join('')}${job.remote_issued ? '<p class="capacity-help amber">The coordinator owns reconciliation. Restarting preserves the existing immutable operation identity.</p>' : ''}</section>
    ${job.preparation ? `<section class="inspector-section"><h3>Workspace preparation</h3>${preparationDetails(job.preparation)}</section>` : ''}
    ${job.waiting_reason ? `<section class="inspector-section"><h3>Current blocker</h3><pre>${esc(job.waiting_reason)}</pre><p class="capacity-help">${job.next_poll_at ? `Next retry ${fmtDate(job.next_poll_at)}.` : 'The coordinator will retry when eligible.'}</p></section>` : ''}
    ${job.remote_operations.length ? `<section class="inspector-section"><h3>Remote operations</h3>${job.remote_operations.map(op => `<div class="history-item"><span>${esc(pretty(op.status))}</span><div class="mono">${esc(op.operation_id)}<br>Submission: ${esc(op.submission_id ?? 'Unknown')}<br><small>Started ${fmtDate(op.started_at)} · checked ${fmtDate(op.checked_at)}</small></div></div>`).join('')}</section>` : ''}
    <section class="inspector-section"><h3>Attempt timeline</h3>${job.history.length ? job.history.slice().reverse().slice(0, 40).map(event => `<div class="history-item"><span>#${num(event.attempt)}</span><div><strong>${esc(pretty(event.result))}</strong><br><small>${fmtDate(event.observed_at)} · ${esc(event.model ?? 'Saved outcome')}</small></div></div>`).join('') : '<p class="capacity-help">No structured attempt history saved.</p>'}</section>
    <section class="inspector-section"><h3>Source, explanation & logs</h3><p class="capacity-help">Artifacts load only on request. Log reads show the last 256 KiB with secrets redacted.</p><div class="inspector-tools"><select id="artifact-select" aria-label="Choose artifact"><option value="">Choose a saved artifact…</option></select><button class="button small" data-action="load-artifact">Load</button></div><div id="artifact-view"></div></section>` : ''}
    ${!job && !node && !ready ? '<p class="capacity-help">This theorem is absent from the current observation. The saved link remains available for future refreshes.</p>' : ''}`;
  panel.hidden = false; panel.scrollTop = scroll;
  restoreFocus(focus);
  if (job) {
    try {
      const files = await api(`/api/artifacts?${new URLSearchParams({ missionId: view.mission.id, theorem: ui.theorem })}`);
      if ($('#artifact-select') && ui.theorem === job.theorem_id) {
        $('#artifact-select').innerHTML += files.map(file => `<option value="${esc(file.name)}" ${ui.artifact === file.name ? 'selected' : ''}>${esc(file.name)}${file.log ? ' · log' : ''}</option>`).join('');
        if (ui.artifactText) renderArtifact();
      }
    } catch (error) { toast(error.message); }
  }
}
function renderArtifact() {
  const target = $('#artifact-view'); if (!target) return;
  const search = ui.artifactSearch.toLowerCase();
  const lines = ui.artifactText.split('\n');
  const content = (search ? lines.filter(line => line.toLowerCase().includes(search)) : lines).join('\n');
  target.innerHTML = `<div class="artifact-tools"><input id="artifact-search" placeholder="Search loaded excerpt…" aria-label="Search loaded artifact" value="${esc(ui.artifactSearch)}"><button class="button small" data-action="copy-artifact">Copy</button><button class="button small" data-action="download-artifact">Download</button>${ui.artifact.endsWith('.log') ? `<button class="button small" data-action="follow-log">${ui.follow ? 'Pause following' : 'Follow log'}</button>` : ''}</div><p class="capacity-help">${ui.artifactTruncated ? 'Truncated to 256 KiB. ' : ''}${search ? `${content ? content.split('\n').length : 0} matching lines. ` : ''}Redacted excerpt.</p><pre id="artifact-content">${esc(content || (search ? 'No matching lines.' : 'Empty artifact.'))}</pre>`;
  if (ui.follow && !search) $('#artifact-content').scrollTop = $('#artifact-content').scrollHeight;
}
async function loadArtifact(following = false) {
  const name = following ? ui.artifact : $('#artifact-select')?.value;
  if (!name) return;
  const theorem = ui.theorem;
  const artifact = await api(`/api/artifacts?${new URLSearchParams({ missionId: ui.missionId, theorem, name })}`);
  if (ui.theorem !== theorem) return;
  ui.artifact = name; ui.artifactText = artifact.content; ui.artifactTruncated = artifact.truncated;
  const focus = saveFocus(); renderArtifact(); restoreFocus(focus);
}
function showSettings(view) {
  settingsScope = { missionId: view.mission.id, revision: state?.revision,
    runId: view.mission.managed ? view.mission.managedRunId : view.summary?.run_id,
    controlRevision: view.configSettings?.revision ?? 0, configRevision: view.configSettings?.configRevision };
  const settingsEditable = !!view.configSettings && (!view.mission.running || view.mission.managed && view.mission.processStatus === 'RUNNING') &&
    !state?.missions.some(row => row.mission.running && row.mission.id !== view.mission.id) && !(state?.lock && !state.lock.managed);
  $('#runtime-settings').innerHTML = renderMissionSettings(view.configSettings?.values ?? {});
  $('#runtime-settings').disabled = !settingsEditable;
  $('#settings-dialog [data-action="set-runtime-settings"]').disabled = !settingsEditable;
  $('#config-error').textContent = settingsEditable ? '' : 'Settings are available when this mission is stopped or connected to Mission Control.';
  const config = view.configSettings;
  const overrides = Object.entries(config?.overrides ?? {}).map(([flag, value]) => `${flag}=${value}`).join(', ');
  $('#settings-note').textContent = `Saved in ${config?.path ?? 'runner-config.json'}. Missions using this file share these settings. ` +
    (view.mission.running ? 'Saving also applies supported changes to new work. Existing attempts keep their assigned settings. ' : 'The next start reads this file. ') +
    (config?.pending ? `The running settings differ from the file (${config.changedKeys.join(', ')}). File edits take effect on restart. ` : '') +
    (overrides ? `Command-line overrides: ${overrides}. Saving replaces matching model and capacity overrides. ` : '');
  const describe = value => Array.isArray(value) ? value.join(', ') : value && typeof value === 'object'
    ? Object.entries(value).map(([key, entry]) => `${key}: ${describe(entry)}`).join('; ') : String(value ?? 'Unavailable');
  $('#settings-differences').innerHTML = config?.pending ? `<details class="freshness-details"><summary>Compare saved and running settings</summary><div class="table-scroll"><table><thead><tr><th>Setting</th><th>Saved in file</th><th>Running now</th></tr></thead><tbody>${config.changedKeys.map(key => `<tr><td>${esc(key)}</td><td>${esc(describe(config.values[key]))}</td><td>${esc(describe(config.runningValues?.[key]))}</td></tr>`).join('')}</tbody></table></div></details>` : '';
  const promptVariant = view.promptSettings?.promptVariant ?? view.configSettings?.values.promptVariant ?? 'balanced';
  $('#prompt-variant').value = promptVariant === 'original' ? 'balanced' : promptVariant;
  $('#prompt-variant').disabled = !settingsEditable;
  $('#settings-dialog').showModal();
}
function showConfirm(title, description, action) {
  $('#confirm-title').textContent = title; $('#confirm-description').textContent = description;
  confirmAction = action; $('#confirm-dialog').showModal();
}
async function command(action, extras = {}) {
  if (busy) { toast('A command is still being acknowledged.'); return; }
  if (!connected) throw new Error('The browser is disconnected. Refresh status before applying a command.');
  if (action !== 'add' && ui.missionId !== state.selected?.mission.id) throw new Error('Wait for the selected mission to finish loading.');
  busy = true;
  document.querySelectorAll(`[data-action="${action}"]`).forEach(el => { el.disabled = true; });
  try {
    const result = await api('/api/command', { method: 'POST', body: JSON.stringify({ id: crypto.randomUUID(), action,
      missionId: state.selected?.mission.id, revision: state.revision, runId: state.selected?.mission.managed ? state.selected.mission.managedRunId : state.selected?.summary?.run_id,
      controlRevision: state.selected?.summary?.operator?.revision, ...extras }) });
    if (result.status === 'REJECTED') throw new Error(result.error);
    if (result.status === 'PENDING') { toast('The command was received. Refresh to inspect the saved result before retrying.'); return result; }
    const credentialsRequired = result.result?.status === 'CREDENTIALS_REQUIRED';
    toast(credentialsRequired ? 'Add your Prove2.me API key to start this mission.' : action === 'set-runtime-settings' ? (state.selected?.mission.running ? 'Config file saved and settings applied to new work.' : 'Config file saved for the next start.') : action === 'set-config' ? 'Configuration saved for the next runner start.' : action === 'check-quota-now' ? 'Checking quota recovery now.' : action === 'set-prompt-variant' ? 'Prompt variant saved for new proof attempts.' : action === 'add' ? 'Mission is ready.' : action === 'stop-agents' ? 'Agents stopped. Validation and server work continue.' : action === 'resume-agents' ? 'Agents resumed. Other operator pauses remain in place.' : action === 'stop' ? 'Runner stopped and saved. Existing server submissions may continue.' : action === 'start' ? 'Runner starting. Account limits will be checked again.' : 'Operator pause saved by the coordinator.');
    if (action === 'add') {
      Object.assign(ui, { missionId: result.result.missionId, theorem: null, tab: 'work', range: 'run', filter: 'active', stage: '', search: '', model: '', taskKind: '', sort: 'name', since: '', until: '', follow: false });
      clearInterval(artifactTimer); updateUrl();
    }
    await refresh();
    if (credentialsRequired) {
      if ($('#add-dialog').open) $('#add-dialog').close();
      showCredentials(result.result.missionId);
    }
    return result;
  } finally { busy = false; document.querySelectorAll('[data-action]').forEach(el => { if (el.disabled && el.dataset.action === action) el.disabled = false; }); }
}
document.addEventListener('click', async event => {
  syncModelPicker(event);
  const close = event.target.closest('[data-close]');
  if (close) { document.getElementById(close.dataset.close).close(); return; }
  const mission = event.target.closest('[data-mission]');
  if (mission) { await selectMission(mission.dataset.mission); return; }
  const tab = event.target.closest('[data-tab]');
  if (tab) { ui.tab = tab.dataset.tab; updateUrl(); render(); return; }
  const filter = event.target.closest('[data-filter]');
  if (filter) { ui.filter = filter.dataset.filter; ui.stage = ''; updateUrl(); render(); return; }
  const stage = event.target.closest('[data-stage]');
  if (stage) { ui.stage = stage.dataset.stage; ui.tab = 'work'; ui.filter = ui.stage ? 'active' : 'all'; updateUrl(); render(); return; }
  const inspect = event.target.closest('[data-inspect]');
  if (inspect) {
    previousFocus = inspect; ui.theorem = inspect.dataset.inspect; ui.artifactText = ''; ui.artifact = ''; ui.follow = false; clearInterval(artifactTimer);
    updateUrl(); await renderInspector(true); $('#inspector .icon-button')?.focus(); return;
  }
  const action = event.target.closest('[data-action]')?.dataset.action;
  if (!action) { if (!event.target.closest('.menu-wrap')) $('#mission-menu')?.setAttribute('hidden', ''); return; }
  try {
    const view = state?.selected;
    const scope = { missionId: view?.mission.id, revision: state?.revision, runId: view?.mission.managed ? view.mission.managedRunId : view?.summary?.run_id,
      controlRevision: view?.summary?.operator?.revision };
    switch (action) {
      case 'add': {
        if ($('#history-dialog').open) $('#history-dialog').close();
        const locked = state?.missions.some(row => row.mission.running) || state?.lock;
        $('#start-immediately').checked = !locked; $('#start-immediately').disabled = !!locked;
        $('#add-note').textContent = locked ? 'A runner is already active. Stop it before starting this mission.' : 'The runner uses your current project settings and local credentials.';
        $('#add-error').textContent = ''; $('#add-dialog').showModal(); $('#mission-query').focus(); break;
      }
      case 'history': $('#mission-search').value = ''; renderMissionHistory(); $('#history-dialog').showModal(); $('#mission-search').focus(); break;
      case 'switch-run': {
        const active = state.missions.find(row => row.mission.running)?.mission;
        if (!active?.managed || active.id === view?.mission.id) break;
        const targetId = view.mission.id;
        const stopScope = { missionId: active.id, runId: active.managedRunId, revision: state.revision };
        showConfirm(`Switch to ${missionTitle(view.mission)}?`, `Stop and save ${missionTitle(active)}, then start ${missionTitle(view.mission)}. Saved work is retained. Existing server submissions may finish afterward.`, async () => {
          const stopped = await command('stop', stopScope);
          if (stopped?.status === 'APPLIED') await command('start', { missionId: targetId, revision: state.revision });
        });
        break;
      }
      case 'refresh': await refresh(); toast('Saved runner status refreshed.'); break;
      case 'menu': { const menu = $('#mission-menu'); menu.hidden = !menu.hidden; event.target.closest('button').setAttribute('aria-expanded', String(!menu.hidden)); break; }
      case 'settings': showSettings(view); break;
      case 'app-settings': renderAppSettings(); $('#app-settings-dialog').showModal(); break;
      case 'credentials': $('#app-settings-dialog').close(); showCredentials(); break;
      case 'check-quota-now': await command('check-quota-now'); break;
      case 'all-work': ui.tab = 'work'; ui.filter = 'all'; ui.stage = ''; updateUrl(); render(); break;
      case 'limits': event.target.closest('button').disabled = true; await api('/api/limits', { method: 'POST' }); await refresh(); toast(state.account.error ? 'Account read failed; previous usage was retained.' : 'Account limits checked. Coordinator recovery gates remain unchanged.'); break;
      case 'start': await command('start'); break;
      case 'stop-agents': await command(action, scope); break;
      case 'pause-admission': showConfirm(`Pause new work for ${view.mission.name}?`, 'The runner stops claiming new theorem jobs. Already admitted preparation, proof, repair, validation, and server work continues. Queued jobs can still invoke Codex.', () => command(action, scope)); break;
      case 'pause-dispatch': showConfirm(`Pause Codex dispatch for ${view.mission.name}?`, 'This affects the one active runner in this checkout. No new proof, repair, or research invocation starts. Active invocations finish; validation and server work continue. Account usage outside this checkout is unaffected.', () => command(action, scope)); break;
      case 'resume-agents': case 'resume-admission': case 'resume-dispatch': await command(action); break;
      case 'stop': showConfirm(`Stop and save ${view.mission.name}?`, `${num(view.summary?.pipeline?.localActive)} local jobs may be interrupted; ${num(view.summary?.pipeline?.remoteActive)} remote jobs are saved. Active local and model processes stop. Jobs and artifacts are retained. Existing server submissions may finish afterward.`, () => command('stop', scope)); break;
      case 'close-inspector': ui.theorem = null; ui.follow = false; clearInterval(artifactTimer); updateUrl(); await renderInspector(); if (previousFocus?.isConnected) previousFocus.focus(); break;
      case 'copy-link': await navigator.clipboard.writeText(location.href); toast('Inspector link copied.'); break;
      case 'load-artifact': await loadArtifact(); break;
      case 'copy-artifact': await navigator.clipboard.writeText(ui.artifactText); toast('Redacted excerpt copied.'); break;
      case 'download-artifact': { const link = document.createElement('a'); link.href = URL.createObjectURL(new Blob([ui.artifactText], { type: 'text/plain' })); link.download = `redacted-${ui.artifact}`; link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 1000); break; }
      case 'follow-log': ui.follow = !ui.follow; clearInterval(artifactTimer); if (ui.follow) artifactTimer = setInterval(() => void loadArtifact(true).catch(error => toast(error.message)), 4000); renderArtifact(); break;
    }
  } catch (error) { toast(error.message); await refresh(); }
});
document.addEventListener('keydown', event => {
  syncModelPicker(event);
  if (event.key === 'Escape' && ui.theorem && !document.querySelector('dialog[open]')) { ui.theorem = null; updateUrl(); void renderInspector(); }
  if ((event.key === 'Enter' || event.key === ' ') && event.target.matches('tr[data-inspect]')) { event.preventDefault(); event.target.click(); }
  if (event.target.matches('[role="tab"]') && ['ArrowLeft', 'ArrowRight'].includes(event.key)) {
    event.preventDefault(); const tabs = [...document.querySelectorAll('[role="tab"]')]; const index = tabs.indexOf(event.target);
    const next = tabs[(index + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length]; next.click(); document.getElementById(next.id)?.focus();
  }
});
document.addEventListener('input', event => {
  syncModelPicker(event);
  if (event.target.id === 'mission-search') { renderMissionHistory(); return; }
  const key = { 'work-search': 'search', 'artifact-search': 'artifactSearch' }[event.target.id];
  if (key) { ui[key] = event.target.value; const focus = saveFocus(); key === 'artifactSearch' ? renderArtifact() : render(); restoreFocus(focus); updateUrl(); }
});
document.addEventListener('change', async event => {
  syncModelPicker(event);
  if (event.target.id === 'mission-select') { await selectMission(event.target.value); return; }
  const key = { 'model-filter': 'model', 'kind-filter': 'taskKind', sort: 'sort' }[event.target.id];
  if (key) { ui[key] = event.target.value; updateUrl(); render(); }
  if (event.target.id === 'range') {
    ui.range = event.target.value;
    if (ui.range === 'custom' && !ui.since) { ui.since = new Date(Date.now() - 3600000).toISOString(); ui.until = new Date().toISOString(); }
    updateUrl(); await refresh();
  }
});
$('#credentials-dialog').addEventListener('close', () => {
  $('#prove2me-key').value = ''; pendingCredentialStart = null; credentialsScope = null;
});
$('#credentials-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = $('#credentials-submit'); button.disabled = true;
  const startMissionId = pendingCredentialStart;
  try {
    const saved = await api('/api/credentials', { method: 'POST', body: JSON.stringify({ ...credentialsScope, apiKey: $('#prove2me-key').value }) });
    $('#prove2me-key').value = '';
    if (saved.missionRefreshError) {
      await refresh();
      throw new Error(`API key saved, but mission lookup failed: ${saved.missionRefreshError}`);
    }
    $('#credentials-dialog').close();
    await refresh();
    if (startMissionId) await command('start', { missionId: startMissionId, revision: state.revision });
    else toast('Prove2.me API key saved on this computer.');
  } catch (error) {
    if ($('#credentials-dialog').open) $('#credentials-error').textContent = error.message;
    else toast(error.message);
  } finally { button.disabled = false; }
});
$('#add-form').addEventListener('submit', async event => {
  event.preventDefault(); const submit = event.target.querySelector('[type=submit]'); submit.disabled = true;
  try {
    await command('add', { query: $('#mission-query').value, milestone: $('#milestone').value,
      start: $('#start-immediately').checked && !$('#start-immediately').disabled });
    $('#add-dialog').close(); $('#add-form').reset();
  } catch (error) { $('#add-error').textContent = error.message; await refresh(); }
  finally { submit.disabled = false; }
});
$('#runtime-settings-form').addEventListener('submit', async event => {
  event.preventDefault();
  $('#config-error').textContent = '';
  try {
    const result = await command('set-runtime-settings', { ...settingsScope,
      promptVariant: $('#prompt-variant').value, settings: readMissionSettings($('#runtime-settings')) });
    if (result?.status === 'APPLIED') $('#settings-dialog').close();
  } catch (error) { $('#config-error').textContent = error.message; }
});
document.addEventListener('submit', async event => {
  if (event.target.id !== 'custom-form') return;
  event.preventDefault(); ui.since = new Date($('#since').value).toISOString(); ui.until = new Date($('#until').value).toISOString(); updateUrl(); await refresh();
});
$('#confirm-submit').addEventListener('click', async () => {
  const button = $('#confirm-submit'); button.disabled = true;
  try { await confirmAction?.(); $('#confirm-dialog').close(); } catch (error) { toast(error.message); await refresh(); }
  finally { button.disabled = false; }
});
async function boot() {
  try {
    const token = new URLSearchParams(location.hash.slice(1)).get('session');
    const session = token ? await api('/api/session', { method: 'POST', headers: { Authorization: `Bearer ${token}` } }) : await api('/api/session');
    csrf = session.csrf; history.replaceState(null, '', location.pathname + location.search);
    await refresh();
    if (state?.credentials?.configured === false) showCredentials();
    setInterval(() => { if (!document.hidden) void refresh(); }, 4000);
    setInterval(renderConnection, 1000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh(); });
    // Reopening the dashboard retries stale discovery/authentication using the
    // saved credentials. Polling stays local and never repeats this API lookup.
    void api('/api/refresh-missions', { method: 'POST' }).catch(error => toast(error.message));
  } catch (error) { $('#main').innerHTML = `<div class="loading-state"><span class="eyebrow">Local session required</span><h1>Open Mission Control from your terminal</h1><p>${esc(error.message)}</p><p class="subtitle">The full link includes your private local session. It stays on this computer.</p></div>`; renderConnection(); }
}
void boot();
