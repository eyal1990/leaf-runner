import defaults from './runner-config.json' with { type: 'json' };

export const RECOVERY_DEFAULTS = Object.freeze({
  initialDelayMs: 30000, maxDelayMs: 900000,
  reconcileAfterMs: 600000, pendingTimeoutMs: 1800000,
});

export function recoveryPolicy(options = {}) {
  const policy = { ...RECOVERY_DEFAULTS, ...defaults.recovery, ...options.pipeline?.recovery, ...options.recovery };
  for (const [key, value] of Object.entries(policy)) {
    if (!Object.hasOwn(RECOVERY_DEFAULTS, key) || !Number.isSafeInteger(value) || value < 1) {
      throw new Error(`Invalid recovery setting: ${key}`);
    }
  }
  if (policy.maxDelayMs < policy.initialDelayMs) throw new Error('Recovery maxDelayMs must be at least initialDelayMs');
  return policy;
}

export const retryDelay = (count, policy) => Math.min(policy.maxDelayMs,
  policy.initialDelayMs * 2 ** Math.min(20, Math.max(0, count - 1)));

export function rememberFailure(state, message, now, policy) {
  const previous = state.recovery_failure;
  const count = previous?.message === message ? previous.count + 1 : 1;
  state.recovery_failure = { message, count, at: new Date(now).toISOString() };
  state.retry_after = new Date(now + retryDelay(count, policy)).toISOString();
  return state.retry_after;
}
