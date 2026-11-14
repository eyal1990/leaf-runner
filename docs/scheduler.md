# Scheduling and architecture

For everyday controls, see the [Mission Control guide](mission-control.md).
[Configuration](configuration.md) defines capacities;
[operations](operations.md) covers persistence and recovery.

## Discovery and selection

The runner resolves a mission's root (or a selected linked milestone), reads its
exact statement/environment and history, and walks immediate theorem
decompositions. It expands open, non-deprecated children, not proved/dead nodes
or structural imports with no submission. Shared paths are deduplicated; at most
four decomposition reads run concurrently, with a 10,000-node traversal cap.
Malformed/inconsistent snapshots do not become partial successful frontiers.
The website display graph can omit reductions, so it is not used as the complete
discovery source.

A reduction requires all theorem children (AND); any usable complete alternative
can close its parent (OR). `closability` estimates how many ancestors a direct
proof of a task would close. Ranking uses:

```text
score = 10 * closability - 10 * attemptsInCurrentContext - totalAttempts
```

Negative scores remain eligible. Ties prefer never-attempted, then least recently
attempted work, then name/ID. Relevant target/dependency changes renew context
priority while preserving lifetime attempt counts and model-schedule positions.
Invalidated parents can become repair tasks. Ungrounded dependency cycles
schedule one member for `reconsider_reduction`, with one repair per component;
AND siblings do not ground cycles, while an independently grounded OR route can.

The read-only `--list` preview uses the same pure policy without migration,
claims, canonical job writes, model invocations, or API mutations.

## Four stages

1. **Prepare:** reserve downstream capacity, read target/context, and lease a
   private workspace. Pin sources/environment and pass readiness checks for
   the selected verification mode.
2. **Codex:** invoke the assigned proof model with a compact worker packet and
   references to complete audit evidence. Generate a direct proof, reduction
   sketch, counterexample certificate, or incomplete result. Formatting repairs
   share the same invocation cap.
3. **Validate:** enforce answer/source/dependency/target gates and freeze
   immutable source/explanation snapshots. Local mode also compiles and checks
   exact types. Server-only mode invokes no client Lean/Lake commands.
4. **Server:** publish dependencies, submit immutable artifacts, poll and
   reconcile operation identities. Independent declarations may compile
   concurrently; proposed definitions impose import barriers. Known-ID polls
   avoid repeated name searches. Verdict reads use a separate bounded lane from
   upload/publication/recovery actions.

Full downstream queues leave durable handoffs and release source workers.
Waiting capacity includes delayed entries and reservations, excluding workers.
Proof, repair, formatting, and research invocations share Codex capacity and
quota gates. In server-only mode, local jobs reserve future remote slots before
admission and release their workspace at the Server boundary. Slow verdicts
consume remote capacity without retaining local workspaces. Lowered limits
drain saved backlog before admitting more work.

Each mathematical invocation records an attempt before starting, including
failed/interrupted invocations. Readiness, deterministic checks, formatting
repairs, quota continuations, and polling do not create new mathematical
attempts. Ordinary incomplete/rejected outcomes yield to scored selection after
one attempt; there is no total attempt cutoff. Saved validation/remote work
recovers before another attempt.

## Graph updates and completion

Confirmed proofs/disproofs update the committed graph immediately. Accepted
sketches trigger targeted decomposition reads and expansion of unknown
prerequisites. Failed attempts and completed publications do not force full
discovery. Background reconciliation defaults to 600 seconds after the last
scan finishes, or can happen at the 30-second recovery interval when no
actionable tasks, active jobs, or targeted updates remain.

Background scans preserve concurrent outcomes; claims can use the committed
graph during reconciliation while retaining durable ownership/capacity checks.
Startup and required invalidations still wait for a usable graph. Live target
and dependency checks remain at invocation/submission. See
[incremental graph updates](incremental-graph-updates.md) for journals and races.

Accepted leaves/sketches and simulated ancestor closure do not establish root
completion. A server-confirmed `Proved` root finishes successfully. A disproved
root stops with `DISPROVED` and preserves request journals. A disproved child
can block one route without disproving its parent.

## Code map

| Module | Responsibility |
| --- | --- |
| `prove2me.mjs` | CLI, API client, discovery/lookup exports, process supervision |
| `mission-control-server.mjs`, `mission-control-data.mjs`, `mission-control/` | Local supervisor, observation views, browser interface |
| `work-selection.mjs`, `work-policy.mjs`, `attempt-history.mjs` | Target resolution, traversal/ranking, graph snapshots, history, claims |
| `pipeline.mjs`, `pipeline-config.mjs` | Admission, four queues, capacity, retirement, checkpoints |
| `serial-jobs.mjs`, `job-stages.mjs` | Resumable stage driver, preparation/model/local-validation work |
| `remote-actions.mjs`, `publication-store.mjs` | Publication, submission, reconciliation and declaration reservations |
| `lean-artifacts.mjs`, `agent-prompts.mjs` | Mathematical artifact gates and prompts |
| `runner-state.mjs`, `job-store.mjs` | Atomic persistence, versioned claims, migration and history |

The implementation follows the platform workspace's
[mission API](https://github.com/prove2me/prove2me_workspace/blob/main/references/missions.md),
[submission API](https://github.com/prove2me/prove2me_workspace/blob/main/references/prove.md),
[authentication](https://github.com/prove2me/prove2me_workspace/blob/main/references/setup.md),
and [Lean setup](https://github.com/prove2me/prove2me_workspace/blob/main/references/lean-setup.md).
