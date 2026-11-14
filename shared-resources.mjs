import { progress } from './runner-state.mjs';

// Process-local limits. The exclusive runner lock remains the cross-process guard.
export function serialResource(name = 'resource') {
  let tail = Promise.resolve();
  let pending = 0;
  return async (action, label) => {
    const queuedAt = Date.now(), waiting = pending++ > 0;
    if (waiting && label) progress(`${label}: waiting for the shared ${name} slot`);
    const result = tail.then(async () => {
      if (waiting && label) progress(`${label}: acquired the shared ${name} slot after ${Math.round((Date.now() - queuedAt) / 1000)}s`);
      try { return await action(); }
      finally { pending--; }
    });
    tail = result.catch(() => {});
    return result;
  };
}

export const withSetupSlot = serialResource('setup');
export const withBuildSlot = serialResource('build');

export function boundedResource(capacity) {
  let running = 0;
  const waiting = [];
  return async action => {
    if (running >= capacity) await new Promise(resolve => waiting.push(resolve));
    else running++;
    try { return await action(); }
    finally {
      const next = waiting.shift();
      if (next) next(); else running--;
    }
  };
}
