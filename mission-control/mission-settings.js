import { renderModelPicker, readModelPicker } from './model-picker.js';

const stages = ['PREPARE', 'CODEX', 'VALIDATE', 'SERVER'];
const names = { PREPARE: 'Prepare', CODEX: 'Codex', VALIDATE: 'Validate', SERVER: 'Server' };

export function renderMissionSettings(values) {
  const models = values.attemptModels?.length ? values.attemptModels : ['luna-6-high'];
  const escalation = values.incompleteEscalation ?? { after: 2, model: 'sol-6.1-high', maxAttempts: null };
  return `<section class="settings-section"><h3>Proof models</h3><p class="form-note">New attempts use these models in order; the last choice repeats for later attempts. Automatic escalation below can select a stronger model. Mission research uses its separate configured model.</p>
    <div id="proof-models">${models.map((profile, index) => renderModelPicker(`proof-model-${index}`, profile, `Attempt ${index + 1}${index === models.length - 1 ? ' onward' : ''}`)).join('')}</div>
    </section><section class="settings-section"><h3>Automatic escalation</h3><p class="form-note">Repeated incomplete results with no proof progress can switch to a stronger rescue model. Saved attempt history counts across restarts. Changes apply to upcoming work; a model call already running keeps its assigned model.</p>
    <label for="escalation-after">Incomplete-result threshold<input id="escalation-after" type="number" min="0" step="1" required aria-describedby="escalation-after-help" value="${Number(escalation.after)}"></label>
    <p id="escalation-after-help" class="form-note">Set to 0 to disable escalation and keep the configured proof models. Identical results use this threshold; reworded blockers require at least three results with unchanged code.</p>
    ${renderModelPicker('escalation-model', escalation.model, 'Rescue model')}
    <label for="escalation-max-attempts">Rescue attempt limit<input id="escalation-max-attempts" type="number" min="0" step="1" aria-describedby="escalation-limit-help" placeholder="Unlimited" value="${escalation.maxAttempts === null ? '' : Number(escalation.maxAttempts)}"></label>
    <p id="escalation-limit-help" class="form-note">Leave blank to keep rescuing until recorded proof progress. A positive limit caps automatic rescue attempts per stall; 0 disables escalation.</p>
    </section><section class="settings-section"><h3>Queue capacity</h3><p class="form-note">Waiting capacity limits queued and reserved jobs. Workers limits concurrent work. Lower limits take effect as existing work finishes.</p>
    <div class="queue-settings">${stages.map(stage => {
      const queue = values.queues?.[stage] ?? {};
      const fixed = stage === 'VALIDATE' || stage === 'PREPARE' && values.verificationMode !== 'server-only';
      const remote = stage === 'SERVER' && values.verificationMode === 'server-only';
      return `<fieldset><legend>${names[stage]}</legend><label for="queue-${stage}-size">Waiting capacity<input id="queue-${stage}-size" type="number" min="1" step="1" required ${remote ? 'disabled' : ''} value="${Number(queue.maxSize) || 1}"></label><label for="queue-${stage}-workers">Workers<input id="queue-${stage}-workers" type="number" min="1" step="1" required ${fixed ? 'disabled' : ''} ${stage === 'SERVER' ? `max="${values.apiConcurrency - 1}"` : ''} value="${fixed ? 1 : Number(queue.concurrency) || 1}"></label>${fixed ? '<p class="form-note">This queue requires one worker.</p>' : stage === 'SERVER' ? `<p class="form-note">Up to ${values.apiConcurrency - 1} action workers; one API slot stays available for graph reads.${remote ? ' In server-only mode, the remote job limit controls waiting capacity. Verdict polls run separately.' : ''}</p>` : ''}</fieldset>`;
    }).join('')}</div><div class="capacity-settings"><label for="max-active-jobs">Local job limit<input id="max-active-jobs" type="number" min="1" step="1" required value="${Number(values.maxActiveJobs) || 1}"></label><label for="max-remote-jobs">Remote job limit<input id="max-remote-jobs" type="number" min="1" step="1" required value="${Number(values.maxRemoteJobs) || 1}"></label></div></section>`;
}

export function readMissionSettings(root) {
  const integer = (id, min = 1) => {
    const input = root.querySelector(`#${id}`), value = Number(input.value);
    if (!String(input.value).trim() || !Number.isSafeInteger(value) || value < min || input.max && value > Number(input.max)) throw new Error(`Enter a valid whole number for ${input.labels?.[0]?.textContent ?? id}.`);
    return value;
  };
  return { attemptModels: [...root.querySelectorAll('#proof-models .model-picker')].map(readModelPicker),
    incompleteEscalation: { after: integer('escalation-after', 0), model: readModelPicker(root.querySelector('#escalation-model')),
      maxAttempts: root.querySelector('#escalation-max-attempts').value.trim() === '' ? null : integer('escalation-max-attempts', 0) },
    maxActiveJobs: integer('max-active-jobs'), maxRemoteJobs: integer('max-remote-jobs'),
    queues: Object.fromEntries(stages.map(stage => [stage, { maxSize: integer(`queue-${stage}-size`), concurrency: integer(`queue-${stage}-workers`) }])) };
}
