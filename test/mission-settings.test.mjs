import test from 'node:test';
import assert from 'node:assert/strict';
import { renderModelPicker, readModelPicker, syncModelPicker } from '../mission-control/model-picker.js';
import { renderMissionSettings, readMissionSettings } from '../mission-control/mission-settings.js';
import { runtimeSettings } from '../runtime-settings.mjs';
import { pipelineLimits } from '../pipeline-config.mjs';

const picker = (family, version, effort) => ({ querySelector: key => ({ value: {
  '[data-model-family]': family, '[data-model-version]': version, '[data-model-effort]': effort,
}[key] }) });

test('model picker serializes supported choices, preserves versions, and excludes Luna Ultra', () => {
  for (const [family, version] of [['luna', '6'], ['terra', '6.1'], ['sol', '6.1'], ['astra', '6']]) {
    assert.equal(readModelPicker(picker(family, version, 'high')), `${family}-${version}-high`);
    const html = renderModelPicker('test', `${family}-${version}-high`);
    assert.match(html, new RegExp(`data-model-version value="${version}"`));
    assert.match(html, new RegExp(`aria-checked="true" data-model-choice="${family}" data-version="${version}"`));
    assert.match(html, /type="range".*aria-valuetext="High"/);
    assert.doesNotMatch(html, /<select|>Default<|[Ss]peed|[Rr]eset/);
  }
  assert.throws(() => readModelPicker(picker('luna', '6', 'ultra')), /supported/);
  assert.throws(() => readModelPicker(picker('terra', '6', 'high')), /supported/);
  assert.match(renderModelPicker('test', 'custom-unknown'), /Current profile: custom-unknown/);
  assert.doesNotMatch(renderModelPicker('test', 'luna-6-high'), /value="ultra"/);
});

test('the configured model and effort stay selected when its version is absent from the menu catalog', () => {
  for (const profile of ['luna-6.1-high', 'gpt-6.1-luna-high']) {
    const html = renderModelPicker('current', profile);
    assert.match(html, /aria-label="Proof model: GPT-6.1 Luna, High"/);
    assert.match(html, /data-configured-model="luna-6.1"/);
    assert.match(html, /aria-checked="true" data-model-choice="luna" data-version="6.1"/);
    assert.match(html, /effort-steps-5 effort-level-2/);
    assert.match(html, /type="range"[^>]*value="2"[^>]*aria-valuetext="High"/);
    assert.doesNotMatch(html, /Choose model|Current profile:|style=/);
    const current = picker('luna', '6.1', 'high');
    current.dataset = { configuredModel: 'luna-6.1' };
    assert.equal(readModelPicker(current), 'luna-6.1-high');
  }
  const html = renderModelPicker('current', 'sol-6.1-ultra');
  assert.match(html, /effort-steps-6 effort-level-5/);
  assert.match(html, /aria-valuetext="Ultra"/);
});

test('model changes retain supported effort, fall back from Ultra for Luna, and serialize slider changes', () => {
  const fields = {
    '[data-model-family]': { value: 'sol' }, '[data-model-version]': { value: '6.1' }, '[data-model-effort]': { value: 'ultra' },
    '[data-effort-control]': {}, '[data-model-name]': {}, '[data-effort-label]': {}, '[data-model-summary]': {},
    legend: { textContent: 'Attempt 1' }, '.model-picker-trigger': { setAttribute() {} },
    '.model-menu': { matches: () => true, hidePopover() {} }, '.model-name-button': { focus() {} },
  };
  const root = { id: 'test', querySelector: key => fields[key], querySelectorAll: () => choices };
  const target = (attributes = {}) => ({ matches: () => false, ...attributes, setAttribute(key, value) { this[key] = value; },
    closest(key) { return key === '.model-picker' ? root : key === '[data-model-choice]' && this.dataset ? this : null; } });
  const choices = [target({ dataset: { modelChoice: 'luna', version: '6' } }), target({ dataset: { modelChoice: 'terra', version: '6.1' } })];
  syncModelPicker({ type: 'click', target: choices[0] });
  assert.equal(readModelPicker(root), 'luna-6-high');
  assert.equal(choices[0]['aria-checked'], 'true');
  assert.match(fields['[data-effort-control]'].innerHTML, /max="4"/);
  const slider = target({ value: '1', max: '4', matches: key => key === '[data-effort-slider]',
    parentElement: {} });
  syncModelPicker({ type: 'input', target: slider });
  assert.equal(readModelPicker(root), 'luna-6-medium');
  assert.equal(slider['aria-valuetext'], 'Medium');
  assert.equal(slider.parentElement.className, 'effort-range effort-steps-5 effort-level-1');
  assert.equal(fields['[data-effort-label]'].textContent, 'Medium');
  syncModelPicker({ type: 'click', target: choices[1] });
  assert.equal(readModelPicker(root), 'terra-6.1-medium');
  assert.match(fields['[data-model-summary]'].innerHTML, /GPT-6.1 Terra/);
});

test('queue controls round-trip capacities and validation protects fixed workers and API headroom', () => {
  const limits = pipelineLimits();
  const html = renderMissionSettings(limits);
  assert.doesNotMatch(html, /textarea|JSON/);
  assert.match(html, /queue-VALIDATE-workers[^>]*disabled/);
  const values = { 'max-active-jobs': 12, 'max-remote-jobs': 20,
    'escalation-after': 2, 'escalation-max-attempts': '' };
  for (const stage of ['PREPARE', 'CODEX', 'VALIDATE', 'SERVER']) {
    values[`queue-${stage}-size`] = 6;
    values[`queue-${stage}-workers`] = 1;
  }
  const root = { querySelectorAll: key => key === '#proof-models .model-picker' ? [picker('terra', '6.1', 'medium')] : [],
    querySelector: key => key === '#escalation-model' ? picker('sol', '6.1', 'high') : { value: String(values[key.slice(1)] ?? '') } };
  const settings = readMissionSettings(root);
  assert.equal(settings.attemptModels[0], 'terra-6.1-medium');
  assert.deepEqual(settings.incompleteEscalation, { after: 2, model: 'sol-6.1-high', maxAttempts: null });
  assert.equal(settings.queues.CODEX.maxSize, 6);
  assert.equal(settings.maxActiveJobs, 12);
  assert.equal(runtimeSettings({ queues: { codex: { concurrency: 2 } } }, limits).queues.CODEX.maxSize, limits.queues.CODEX.maxSize);
  for (const bad of [null, { attemptModels: [] }, { queues: null }, { queues: { UNKNOWN: {} } },
    { queues: { VALIDATE: { concurrency: 2 } } }, { queues: { SERVER: { concurrency: limits.apiConcurrency } } },
    { maxActiveJobs: 0 }, { verificationMode: 'local' }]) assert.throws(() => runtimeSettings(bad, limits));
  values['queue-CODEX-size'] = 1.5;
  assert.throws(() => readMissionSettings(root), /whole number/);
});

test('escalation controls preserve disabled and unlimited policies, validate limits, and isolate rescue models', () => {
  const limits = pipelineLimits({ incompleteEscalation: { after: 0, model: 'astra-6-max', maxAttempts: null } });
  const html = renderMissionSettings(limits);
  assert.match(html, /id="escalation-after"[^>]*value="0"/);
  assert.match(html, /id="escalation-max-attempts"[^>]*value=""/);
  assert.match(html, /Rescue model: GPT-6 Astra, Max/);
  assert.match(renderMissionSettings({ ...limits, incompleteEscalation: { ...limits.incompleteEscalation, maxAttempts: 0 } }),
    /id="escalation-max-attempts"[^>]*value="0"/);
  const values = { 'max-active-jobs': '12', 'max-remote-jobs': '20', 'escalation-after': '0', 'escalation-max-attempts': '' };
  for (const stage of ['PREPARE', 'CODEX', 'VALIDATE', 'SERVER']) {
    values[`queue-${stage}-size`] = '4'; values[`queue-${stage}-workers`] = '1';
  }
  const root = { querySelectorAll: key => {
    assert.equal(key, '#proof-models .model-picker');
    return [picker('luna', '6', 'high')];
  }, querySelector: key => key === '#escalation-model' ? picker('astra', '6', 'max') : { value: values[key.slice(1)] } };
  assert.deepEqual(readMissionSettings(root).attemptModels, ['luna-6-high']);
  assert.deepEqual(readMissionSettings(root).incompleteEscalation, limits.incompleteEscalation);
  values['escalation-after'] = '4'; values['escalation-max-attempts'] = '3';
  assert.deepEqual(readMissionSettings(root).incompleteEscalation, { after: 4, model: 'astra-6-max', maxAttempts: 3 });
  values['escalation-max-attempts'] = '0';
  assert.equal(readMissionSettings(root).incompleteEscalation.maxAttempts, 0);
  for (const id of ['escalation-after', 'escalation-max-attempts']) {
    for (const bad of ['-1', '1.5', 'NaN', '9007199254740992', ...(id === 'escalation-after' ? [''] : [])]) {
      const previous = values[id]; values[id] = bad;
      assert.throws(() => readMissionSettings(root), /whole number/);
      values[id] = previous;
    }
  }
  const current = pipelineLimits({ incompleteEscalation: { after: 4, model: 'astra-6-max', maxAttempts: 3 } });
  assert.deepEqual(runtimeSettings({ incompleteEscalation: { after: 0 } }, current).incompleteEscalation,
    { after: 0, model: 'astra-6-max', maxAttempts: 3 });
  for (const bad of [null, { after: -1 }, { after: 1.5 }, { maxAttempts: -1 }, { maxAttempts: 1.5 }, { model: '' }, { typo: 2 }]) {
    assert.throws(() => runtimeSettings({ incompleteEscalation: bad }, current));
  }
});
