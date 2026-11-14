import { readFileSync } from 'node:fs';
import { validatePromptVariant } from './prompt-experiment.mjs';
import { modelProfile, validateAttemptModels, validateIncompleteEscalation } from './model-policy.mjs';
import { verificationMode } from './verification-mode.mjs';
import { recoveryPolicy } from './recovery-policy.mjs';
const stages = ['PREPARE', 'CODEX', 'VALIDATE', 'SERVER'];

export function pipelineLimits(settings = {}, defaults = JSON.parse(readFileSync(new URL('./runner-config.json', import.meta.url), 'utf8'))) {
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const limits = { queues: {} };
  // Both the project defaults and optional overrides use the same validation.
  // Clone queue values into the result so callers cannot mutate the defaults.
  for (const layer of [defaults, settings]) {
    if (!object(layer)) throw new Error('Pipeline configuration must be a JSON object');
    for (const key of Object.keys(layer)) if (!['_comment', 'maxActiveJobs', 'maxRemoteJobs', 'verificationMode', 'windowsSandboxRecovery', 'queues', 'apiConcurrency', 'missionReviewEvery', 'missionReviewModel', 'attemptModels', 'promptVariant', 'incompleteEscalation', 'recovery'].includes(key)) throw new Error(`Unknown pipeline setting: ${key}`);
    if (Object.hasOwn(layer, 'incompleteEscalation')) {
      validateIncompleteEscalation(layer.incompleteEscalation);
      limits.incompleteEscalation = validateIncompleteEscalation({ ...limits.incompleteEscalation, ...layer.incompleteEscalation });
    }
    if (Object.hasOwn(layer, 'recovery')) {
      if (!object(layer.recovery)) throw new Error('Recovery settings must be a JSON object');
      limits.recovery = { ...limits.recovery, ...layer.recovery };
    }
    if (Object.hasOwn(layer, 'attemptModels')) limits.attemptModels = validateAttemptModels(layer.attemptModels);
    if (Object.hasOwn(layer, 'promptVariant')) limits.promptVariant = validatePromptVariant(layer.promptVariant);
    for (const key of ['maxActiveJobs', 'maxRemoteJobs', 'verificationMode', 'windowsSandboxRecovery', 'apiConcurrency', 'missionReviewEvery', 'missionReviewModel']) if (Object.hasOwn(layer, key)) limits[key] = layer[key];
    if (Object.hasOwn(layer, 'queues') && !object(layer.queues)) throw new Error('Pipeline queues must be a JSON object');
    const seen = new Set();
    for (const [key, value] of Object.entries(layer.queues ?? {})) {
      const stage = key.toUpperCase();
      if (!stages.includes(stage)) throw new Error(`Unknown pipeline queue: ${key}`);
      if (seen.has(stage)) throw new Error(`Duplicate pipeline queue: ${key}`);
      seen.add(stage);
      if (!object(value)) throw new Error(`Queue ${key} must be a JSON object`);
      for (const field of Object.keys(value)) if (!['maxSize', 'concurrency'].includes(field)) throw new Error(`Unknown queue setting: ${field}`);
      Object.assign(limits.queues[stage] ??= {}, value);
    }
  }
  verificationMode(limits);
  if (!['protected', 'allow-unelevated'].includes(limits.windowsSandboxRecovery ?? 'protected')) throw new Error('Invalid windowsSandboxRecovery; use protected or allow-unelevated');
  modelProfile(limits.missionReviewModel);
  limits.recovery = recoveryPolicy({ recovery: limits.recovery });
  if (!Number.isSafeInteger(limits.missionReviewEvery) || limits.missionReviewEvery < 0) throw new Error('missionReviewEvery must be a nonnegative integer');
  for (const stage of stages) if (!limits.queues[stage]) throw new Error(`Missing pipeline queue: ${stage}`);
  for (const value of [limits.maxActiveJobs, limits.maxRemoteJobs, limits.apiConcurrency, ...Object.values(limits.queues).flatMap(q => [q.maxSize, q.concurrency])]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error('Pipeline capacities must be positive integers');
  }
  if (limits.queues.VALIDATE.concurrency !== 1) throw new Error('VALIDATE concurrency must remain one');
  if (limits.verificationMode !== 'server-only' && limits.queues.PREPARE.concurrency !== 1) limits.queues.PREPARE.concurrency = 1;
  if (limits.queues.SERVER.concurrency >= limits.apiConcurrency) throw new Error('Server concurrency must be less than apiConcurrency to leave capacity for graph/context reads');
  return limits;
}
