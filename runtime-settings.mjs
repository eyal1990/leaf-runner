import { pipelineLimits } from './pipeline-config.mjs';

// Only these settings can be changed without rebuilding clients or workspaces.
export function runtimeSettings(value, current) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Settings must be an object');
  const keys = ['attemptModels', 'incompleteEscalation', 'queues', 'maxActiveJobs', 'maxRemoteJobs'];
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new Error(`Setting cannot be changed live: ${key}`);
  const queues = structuredClone(current.queues);
  if (Object.hasOwn(value, 'queues')) {
    if (!value.queues || typeof value.queues !== 'object' || Array.isArray(value.queues)) throw new Error('Queues must be an object');
    const seen = new Set();
    for (const [key, queue] of Object.entries(value.queues)) {
      const stage = key.toUpperCase();
      if (!queues[stage] || seen.has(stage)) throw new Error(`Invalid or duplicate queue: ${key}`);
      if (!queue || typeof queue !== 'object' || Array.isArray(queue)) throw new Error(`Invalid queue: ${key}`);
      seen.add(stage);
      queues[stage] = { ...queues[stage], ...queue };
    }
  }
  const limits = pipelineLimits({ ...value, queues }, current);
  if (value.attemptModels && !value.attemptModels.length) throw new Error('Choose at least one proof model');
  return Object.fromEntries(Object.keys(value).map(key => [key, limits[key]]));
}

export function applyRuntimeSettings(pipeline, settings) {
  Object.assign(pipeline.limits, settings);
  Object.assign(pipeline.options.pipeline ??= {}, settings);
  // Workers copy options when they start. Keep this object shared so future
  // attempts in existing workers see acknowledged model and escalation changes too.
  for (const key of ['attemptModels', 'incompleteEscalation']) {
    if (Object.hasOwn(settings, key)) Object.assign(pipeline.options.runtimeSettings ??= {}, { [key]: settings[key] });
  }
}
