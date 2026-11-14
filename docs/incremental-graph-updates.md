# Incremental graph updates

The scheduling graph combines a full server snapshot with durable, confirmed outcomes. Full discovery remains necessary at startup and for periodic reconciliation with changes made outside this runner. The default interval is 600 seconds after a completed scan; `--graph-refresh-interval SECONDS` overrides it. A scan runs in the background once startup recovery has finished. Existing committed work remains selectable, subject to durable claims, queue capacities, and the existing live target checks before model invocation and remote submission. Explicit required invalidations retain the blocking selection interface.

## Outcome handling

- A completed accepted proof marks its theorem `Proved`; an accepted counterexample marks it `Disproved`. These operations require no additional graph API request.
- An accepted sketch journals a pending update. A targeted read fetches the parent and its decompositions, waits until that submission is visible, and expands unfamiliar prerequisites in batches of at most four requests. Existing graph regions are reused. The server's dependency edges are authoritative; the proposed children and publication list are not treated as a complete decomposition.
- Confirmed publications remain in their publication journals until an accepted parent reduction makes them reachable. Ordinary failed and incomplete attempts rerank through canonical job history without requesting discovery.
- A skipped or changed target is inspected through the same targeted update path.

Reachability, usable alternatives, cycle repair, and closability are recomputed from the updated graph. All children of a reduction must be satisfied; one satisfied alternative is enough to close an ancestor for scheduling. This never changes the ancestor's recorded server status. Root completion or disproof must be confirmed by a direct root read or full server discovery.

## Persistence and races

`.runs/graph-updates/<root>.json` records outcomes before installing their graph projection. Graph installation is serialized separately from canonical job transactions. A full scan removes an event only when its snapshot observes the result or the theorem is no longer reachable. Otherwise the event is replayed over the snapshot. Conflicting declaration identities trigger a targeted read before the old outcome can affect that declaration. Accepted edges and direct proof outcomes are merged without allowing a sketch's dependency metadata to overwrite a later proof. Claims recheck the graph inside their state-store transaction and retry if installation overtook selection.

Pending targeted reads retain their retry deadline and diagnostic across restarts. Temporary 404s, service failures, and accepted reductions awaiting visibility retry at the recovery interval without blocking unrelated work or spending another proof attempt. Permission failures and malformed responses still fail the run. Startup always performs full discovery and reconciles the journal before admitting work.

The coordinator drains pending graph writers on interruption and waits for graph/root writers before reporting completion. Checkpoints expose `graph_reconciling` and `graph_updates_pending`; a background reconciliation no longer reports that all admission is waiting for a fresh graph. A handoff blocks admission only through the relevant queue and job capacities, rather than through a global handoff veto.

## Verification

`test/incremental-graph.test.mjs` covers journal replay, concurrent verdicts during discovery, declaration changes, accepted sketch expansion, nested prerequisites and definitions, visibility delays, transient/permission failures, disproof invalidation, and authoritative root confirmation. Pipeline regressions cover production admission during discovery outages, quota and server draining, formatting/repair retries without scans, periodic deadlines, and shutdown.

These offline tests establish scheduling and recovery behavior. They do not measure live server throughput or establish a production performance improvement.
