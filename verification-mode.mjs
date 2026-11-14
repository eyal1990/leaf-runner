// Local mode retains the existing compiler checks. Server-only mode needs no
// client Lean installation and uses remote verdicts for mathematical validity.
import defaults from './runner-config.json' with { type: 'json' };

export function verificationMode(options = {}) {
  const mode = options.verificationMode !== undefined ? options.verificationMode
    : options.pipeline?.verificationMode !== undefined ? options.pipeline.verificationMode : defaults.verificationMode;
  if (!['local', 'server-only'].includes(mode)) throw new Error('verificationMode must be local or server-only');
  return mode;
}

export const serverOnly = options => verificationMode(options) === 'server-only';
