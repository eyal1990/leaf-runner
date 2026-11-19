// Codex model profiles. Keep versions and supported efforts together so every
// consumer uses the same controls and serialization.
// https://learn.chatgpt.com/docs/models (verified 2026-11-19)
export const MODEL_CATALOG = {
  luna: { label: 'Luna', versions: ['6'], efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  terra: { label: 'Terra', versions: ['6.1'], efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
  sol: { label: 'Sol', versions: ['6.2', '6.1', '6'], efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
  astra: { label: 'Astra', versions: ['6.2', '6'], efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
};
const labels = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max', ultra: 'Ultra' };
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const modelName = (family, version) => `GPT-${version} ${MODEL_CATALOG[family].label}`;
const modelChoices = [['astra', '6.2'], ['sol', '6.2'], ['sol', '6.1'], ['astra', '6'], ['terra', '6.1'], ['sol', '6'], ['luna', '6']];
const chevron = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m5 6 3 3 3-3" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function effortControl(id, model, effort) {
  const index = Math.max(0, model?.efforts.indexOf(effort) ?? 0), efforts = model?.efforts ?? ['high'];
  return `<div class="effort-range effort-steps-${efforts.length} effort-level-${index}">
    <input id="${escape(id)}-effort" data-effort-slider type="range" min="0" max="${efforts.length - 1}" step="1" value="${index}" aria-label="Reasoning effort" aria-valuetext="${escape(labels[effort] ?? 'Choose a model')}" ${model ? '' : 'disabled'}>
    <div class="effort-ticks" aria-hidden="true">${efforts.map(() => '<span></span>').join('')}</div>
  </div>`;
}

export function parseModelProfile(profile) {
  const alias = profile?.match(/^(luna|terra|sol|astra)-(\d+(?:\.\d+)*)-(\w+)$/);
  const raw = profile?.match(/^gpt-(\d+(?:\.\d+)*)-(luna|terra|sol|astra)(?:-(\w+))?$/);
  return alias ? { family: alias[1], version: alias[2], effort: alias[3] }
    : raw ? { family: raw[2], version: raw[1], effort: raw[3] ?? 'high' } : null;
}

export function renderModelPicker(id, profile, legend = 'Proof model') {
  const value = parseModelProfile(profile), model = MODEL_CATALOG[value?.family];
  // A configured version may be newer than the menu catalog. Keep it selected
  // and editable instead of clearing the model and disabling its effort.
  const supported = !!model && model.efforts.includes(value.effort);
  const choices = supported && !model.versions.includes(value.version)
    ? [[value.family, value.version], ...modelChoices] : modelChoices;
  const name = supported ? modelName(value.family, value.version) : 'Choose model';
  const effort = supported ? labels[value.effort] : 'Reasoning effort';
  return `<fieldset class="model-picker" id="${escape(id)}" data-configured-model="${supported ? `${value.family}-${value.version}` : ''}"><legend>${escape(legend)}</legend>
    ${!supported ? `<p class="form-note">Current profile: ${escape(profile || 'Unspecified')}. Choose a model and reasoning effort to replace it.</p>` : ''}
    <input type="hidden" data-model-family value="${supported ? value.family : ''}">
    <input type="hidden" data-model-version value="${supported ? value.version : ''}">
    <input type="hidden" data-model-effort value="${supported ? value.effort : ''}">
    <button type="button" class="model-picker-trigger" data-picker-open popovertarget="${escape(id)}-options" aria-label="${escape(legend)}: ${escape(name)}, ${escape(effort)}"><span data-model-summary>${escape(name)} <span class="model-summary-effort">${escape(effort)}</span></span>${chevron}</button>
    <div id="${escape(id)}-options" class="model-options" popover="auto" aria-label="Model and reasoning effort">
      <div class="model-effort-heading" data-effort-label>${escape(effort)}</div>
      <button type="button" class="model-name-button" data-picker-open popovertarget="${escape(id)}-models"><span data-model-name>${escape(name)}</span>${chevron}</button>
      <div data-effort-control>${effortControl(id, supported ? model : null, value?.effort)}</div>
      <div id="${escape(id)}-models" class="model-menu" popover="auto" role="menu" aria-label="Select model">
        <p class="model-menu-title">Select model</p>
        ${choices.map(([family, version]) => `<button type="button" role="menuitemradio" aria-checked="${supported && family === value.family && version === value.version}" data-model-choice="${family}" data-version="${version}"><span>${modelName(family, version)}</span><span class="model-check" aria-hidden="true">✓</span></button>`).join('')}
      </div>
    </div></fieldset>`;
}

export function syncModelPicker(event) {
  const picker = event.target.closest('.model-picker');
  if (!picker) return;
  const opener = event.target.closest('[data-picker-open]');
  if (event.type === 'click' && opener) {
    const popup = picker.querySelector(`#${opener.getAttribute('popovertarget')}`), rect = opener.getBoundingClientRect();
    popup.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 262))}px`;
    popup.style.top = `${Math.max(8, Math.min(rect.bottom + 6, window.innerHeight - (popup.classList.contains('model-menu') ? 220 : 110)))}px`;
    return;
  }
  const choice = event.target.closest('[data-model-choice]');
  const slider = event.target.matches('[data-effort-slider]') ? event.target : null;
  if (event.type === 'keydown' && event.target.closest('[role="menu"]') && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
    event.preventDefault();
    const items = [...picker.querySelectorAll('[data-model-choice]')], index = items.indexOf(choice);
    items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus();
    return;
  }
  if (!(event.type === 'click' && choice) && !(['input', 'change'].includes(event.type) && slider)) return;
  const family = picker.querySelector('[data-model-family]'), version = picker.querySelector('[data-model-version]'), effort = picker.querySelector('[data-model-effort]');
  if (choice) {
    family.value = choice.dataset.modelChoice;
    version.value = choice.dataset.version;
    const model = MODEL_CATALOG[family.value];
    if (!model.efforts.includes(effort.value)) effort.value = 'high';
    picker.querySelector('[data-effort-control]').innerHTML = effortControl(picker.id, model, effort.value);
    for (const item of picker.querySelectorAll('[data-model-choice]')) item.setAttribute('aria-checked', String(item === choice));
  } else {
    effort.value = MODEL_CATALOG[family.value].efforts[Number(slider.value)];
    slider.setAttribute('aria-valuetext', labels[effort.value]);
    slider.parentElement.className = `effort-range effort-steps-${Number(slider.max) + 1} effort-level-${slider.value}`;
  }
  const name = modelName(family.value, version.value), label = labels[effort.value];
  picker.querySelector('[data-model-name]').textContent = name;
  picker.querySelector('[data-effort-label]').textContent = label;
  picker.querySelector('[data-model-summary]').innerHTML = `${name} <span class="model-summary-effort">${label}</span>`;
  picker.querySelector('.model-picker-trigger').setAttribute('aria-label', `${picker.querySelector('legend').textContent}: ${name}, ${label}`);
  if (choice) {
    const menu = picker.querySelector('.model-menu');
    if (menu.matches(':popover-open')) menu.hidePopover();
    picker.querySelector('.model-name-button').focus();
  }
}

export function readModelPicker(picker) {
  const family = picker.querySelector('[data-model-family]').value;
  const version = picker.querySelector('[data-model-version]').value;
  const effort = picker.querySelector('[data-model-effort]').value;
  const model = MODEL_CATALOG[family];
  const configured = picker.dataset?.configuredModel === `${family}-${version}`;
  if (!model || (!model.versions.includes(version) && !configured) || !model.efforts.includes(effort)) throw new Error('Choose a model, version, and supported reasoning effort.');
  return `${family}-${version}-${effort}`;
}
