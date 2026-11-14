# Throughput tuning

Measure model-worker utilization, submission yield, and publication/verification turnaround together when tuning concurrency. Client turnaround includes server queues and polling delay; it does not isolate server compilation time. Keep run identifiers and account-specific measurements in ignored local diagnostics.

## Implemented settings

The values below distinguish the automatically loaded
[project configuration](../runner-config.json) from the optional
[example configuration](../runner-config.example.json). Saved changes and CLI
overrides determine actual limits; Mission Control shows effective settings.
See [configuration](configuration.md) for all defaults and file precedence.

| Limit (server-only mode) | Project default | Optional example |
| --- | ---: | ---: |
| Total admitted local and remote jobs | 8 | 48 |
| Local jobs / private workspace leases | 4 | 16 |
| Model workers | 2 | 8 |
| Server-only preparation workers | 2 | 4 |
| API requests | 8 | 8 |
| Upload / publication / recovery actions | 1 | 1 |
| Concurrent due verdict reads | 6 | 6 |

Six read-only polls plus one action worker leave one API permit available for graph/context reads. There is no batch verification endpoint in the client: one coordinator schedules bounded concurrent requests per submission. Missing/stale submission recovery leaves the read-only lane before a replacement POST. Local verification retains one preparation worker and the shared Lean build permit.

## Changes

- The runner loads the job index once and updates it after durable writes. Scheduler views contain frozen records; ordinary callers receive independent copies. Mutation paths retain canonical reads and revision checks. Startup loading uses bounded parallel reads.
- Private workspace allocation reserves a lease under the shared setup permit; copying and full byte verification/reset proceed outside that permit. File metadata reads are bounded and parallel, and unchanged package directories avoid redundant creation calls. Seed initialization remains serialized. Unsafe slots are discarded; isolation, hashes, and cancellation checks remain enforced.
- Independent proposed declarations are issued in the same publication action, overlapping server compilation. Imports of proposed definitions retain their publication barriers. Issued siblings drain before repair after a publication failure; unknown POSTs preserve reconciliation backoff and journals.
- Prompts request names scoped to the theorem and mathematical attempt. Validation reserves names before freezing artifacts and renames conflicting proposals and their source/module references together. Identical reserved declarations can still share their existing publication identity.
- Dashboard server capacity includes the separate verdict lane. Checkpoints expose action and verdict worker counts independently.

## Validation and limits

Run `node --test test/throughput.test.mjs` for focused coverage, or `npm test` for the full offline suite. Tests cover immutable index snapshots and durable updates, conflict rewriting, independent publication/resumption, definition barriers, sibling failure draining, read-only recovery, and concurrent polling while submissions progress. Optional integrations require their configured environment. Windows process-lifecycle tests need permission to terminate their own child processes.

Scheduler microbenchmarks measure local bookkeeping overhead only. They do not establish production submission throughput or workspace reset time. Estimate model-side submission capacity from worker count, mean invocation duration, and measured submission yield, then compare it with observed server turnaround and platform/account limits. Available independent theorem work also limits utilization. These settings do not change server compilation or queue settings.

Direct file edits and code changes are read on the next runner start. Supported
Mission Control settings can also apply to new work after coordinator
acknowledgement; running attempts retain their assignments and reduced limits
drain existing owners.
