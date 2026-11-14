import { solveLeaf as runOneAttempt } from '../prove2me.mjs';
import { JobStore } from '../job-store.mjs';
import { join } from 'node:path';

// A finite test coordinator for the existing artifact/remote regression tests.
// Production solveLeaf deliberately yields READY; each next round must claim
// through the same policy, with a fresh revision, rather than retry locally.
export async function solveLeaf(client, target, context, environment, options, hooks) {
  // These historical scenarios cover proofs, sketches, and disproofs. Keep
  // them independent of the operator's current production prompt/cache.
  options = { cacheDir: join(options.runs, 'test-library-cache'), ...options,
    promptVariant: options.promptVariant ?? options.pipeline?.promptVariant ?? 'original',
    recovery: options.recovery ?? { initialDelayMs: 1, maxDelayMs: 1 } };
  const store = new JobStore(options.runs);
  const graph = { root: target, leaves: [target] };
  const rounds = options.testRounds ?? options.attempts ?? 3;
  let recoveries = 0;
  for (let round = 0; round < rounds; round++) {
    const state = await store.ensure(target.theorem_id, options);
    if (['READY', 'UNRESOLVED', 'RETIRED'].includes(state.job_status)) {
      const wait = Date.parse(state.retry_after ?? '') - Date.now();
      if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
      if (!await store.claim(graph, options)) return state.status;
    }
    const result = await runOneAttempt(client, target, context, environment, options, hooks);
    if (result === 'PUBLISH_PENDING' && (await store.read(target.theorem_id)).infrastructure_wait) {
      if (++recoveries > 10) throw new Error('Test fixture must finish infrastructure recovery or explicitly abort');
      round--; continue;
    }
    if (result !== 'READY') return result;
  }
  return 'READY';
}
