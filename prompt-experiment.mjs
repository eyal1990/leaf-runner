import defaults from './runner-config.json' with { type: 'json' };

export const PROMPT_EXPERIMENT = 'proof-first-v2';
// Retained for reports of historical randomized attempts.
export const AB_PROMPT_VARIANTS = ['original', 'proof_first'];
export const PROMPT_VARIANTS = ['balanced', 'proof_first', 'proofOnly'];

export function validatePromptVariant(value) {
  if (value === 'original') return 'balanced'; // Older configuration files remain valid.
  if (!PROMPT_VARIANTS.includes(value)) {
    throw new Error('promptVariant must be balanced, proof_first, or proofOnly');
  }
  return value;
}

export function selectPrompt(options = {}) {
  const variant = validatePromptVariant(options.promptVariant ?? options.pipeline?.promptVariant ?? defaults.promptVariant);
  return { experiment_id: null, variant, assignment_unit: 'mathematical_attempt', probability: 1 };
}
