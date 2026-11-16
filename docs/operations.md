# Recovery and diagnostics

Use **Mission actions → Stop and save**, then **Start saved run** for ordinary
interruption/restart. Ctrl+C in the launcher also saves before closing the
server. See the [UI guide](mission-control.md) for pauses and inspection controls.

## Saved work and locks

| Location | Contents |
| --- | --- |
| `.runs/<theorem_id>/state.json` | Canonical versioned job, revision, claims, stages, attempt history, candidates, and remote operation identities |
| `.runs/<theorem_id>/` | Context, prompts, candidate snapshots, explanations, compiler/model logs, submission/publication journals |
| `.runs/graphs/<root_id>.json` | Saved solver graph and ranking/history |
| `.runs/last-run.json` | Coordinator checkpoint, root/run state, effective limits, workers/queues/reservations, waits, results |
| `.runs/mission-control/` | Mission registry, controls, receipts, execution history, and supervisor lock |
| `.workspaces/` | Cached pinned environment seeds, private job slots, compiled dependency caches |
| `.cache/` | Downloaded/mirrored dependency source and other local cache data |

These directories are ignored by Git and can contain private mission material.
Do not delete them as a routine recovery step. Migration backs up old state
before rewriting it; append-only attempt history retains lifetime consumption.
Immutable snapshots commit before state references and are hash-checked when
restored. Corrupt state, changed immutable artifacts, or persistence failures
stop the runner rather than silently losing a theorem.

Only one runner owns these workspaces. `.runs/runner.lock` protects jobs and
shared files; `.runs/mission-control/server.lock` protects the registry. Graceful
shutdown stops child process trees, drains writers, saves, and releases locks.
After a forced kill/crash, verify the lock's recorded PID is no longer running
before manually removing a stale lock. A lease marker alone does not prove
that its process stopped.

## Automatic recovery

| Situation | Behavior |
| --- | --- |
| Interrupted model work | Retains attempt identity, partial proofs, inputs and diagnostics. A new mathematical attempt follows lifetime numbering; quota continuations retain the interrupted attempt. |
| Readiness failure | Retries setup-lock failures/timeouts twice in the same workspace, then waits and retries without spending a proof attempt. Previous proof feedback remains. |
| Codex usage quota exhausted | Pauses new model dispatch, retains partial artifacts and same-attempt continuations; validation/server work drains. Prepared work stops at waiting capacity. The pause survives restarts. |
| API authentication, rate limit, timeout or transient error | Shared cancellable recovery with exponential backoff and `Retry-After`. Credential-file reload/token refresh can recover without restarting. A resource-specific permission error becomes job diagnostics. |
| Proof-storage/enqueue failure | Pauses theorem admission and new proof/repair/formatting/research calls. Active calls finish. Retries saved immutable proofs with backoff and no additional proof attempt. Remains paused until every affected job receives a completed result other than that storage error. |
| Unknown upload or stale pending request | Reconciles full account history against theorem and exact source hash. At the configured deadline, rechecks target/dependencies before a journaled replacement. Failed/incomplete history reads never authorize replacement. |
| Ordinary rejection or incomplete proof | Records an outcome, releases resources, and returns to scored selection without mathematical cooldown. Infrastructure errors retain their retry backoff. |
| Workspace documentation version mismatch | Updates shared seed documentation through Git. Patch-only differences can proceed; incompatible/missing versions or failed updates wait/retry without spending attempts. Issued server work can drain. |

Reconciliation preserves every pre-POST intent, recovered ID, error and verdict.
The server has no established idempotency guarantee: a replacement can duplicate
a request that arrived but stayed invisible. A successful history GET does not
mean a proof was uploaded. An accepted proof, sketch, or disproof is not uploaded
again while waiting for propagation. Journals preserve disproof mode even when
history endpoints omit it.

Quota recovery reads limits without a model request, immediately on pause and
restart, then at least hourly or 30 seconds after the latest exhausted-window
reset if sooner. Both exhausted windows must recover. Failed reads retain the
pause. Recovery permits one saved invocation before reopening dispatch; renewed
quota rejection parks it again without spending another attempt. The runner
must remain running for automatic recovery. Operator pauses remain independent.
**Check limits now** refreshes the dashboard observation; **Check recovery now**
asks the coordinator to recheck its gate.

Recovery timings are in [configuration](configuration.md). Workspace upgrade
status/logs live in `.runs/workspace-upgrade.json` and `.log`. This updates
platform documentation, not the runner's API implementation.

## Workspace copy progress

`Workspace preparation: copying the pinned environment` starts a private copy
from the prepared seed. Older versions call this `copying the full Lean/Mathlib
environment`. This is a local disk operation, not a Lean compilation or model
request. Server-only mode copies Mathlib sources; local mode also copies the
downloaded build cache. Dependency Git data is retained for Lake revision checks.
Mathlib's internal file symlinks, such as benchmark script aliases on Linux,
are materialized as independent regular files in each private workspace. Links
outside the seed, directory links, and linked Git metadata remain rejected.

A full copy is needed when no reusable slot exists for that environment, for
example on the first run, while filling the pool, after a pin/instruction/API
version change, or after discarding an unsafe slot. Later jobs reset and verify
released slots instead. Many small files, slow disks, and filesystem scanning
can make initial copies take minutes.

Copies use bounded parallel file operations and report completed file/byte
counts every 30 seconds in the terminal. Mission Control shows a **Preparing
workspaces** panel with the current step, elapsed time, file/byte counts, and a
heartbeat about every five seconds, also available in the theorem inspector.
Increasing counts show progress; unchanged counts
can also mean one large file is still copying. Stop/save cancels before further
files are started, drains active filesystem operations, and removes incomplete
staging without publishing a ready workspace. A subsequent start can retry.

When reporting a suspected stall, include the following heartbeat lines, elapsed
time, verification mode, disk free space, and any filesystem error. The initial
copy message alone does not establish a failure. Keep cached workspaces when
investigating; deleting them forces full copies again.

If a job fails, its terminal line includes the stage, operation, error code and
message, and the next retry eligibility time. A preparation failure can release
the local slot, leaving zero active jobs while the theorem waits for its retry.
The runner summary identifies that retry wait, and Mission Control shows it in
**Needs attention**, **Work → Waiting**, and the theorem inspector. The saved
`.runs/<theorem_id>/state.json` contains `recovery_failure` and `retry_after`,
including errors from older versions that did not print the failure. Repeated
job errors use exponential backoff, initially 30 seconds and capped at 15 minutes
with the default recovery settings; graph discovery continues during that wait.

## Linux and macOS sandbox readiness

The pinned Codex CLI launches readiness as `codex sandbox -- <command>` and
selects the host sandbox automatically. Older runner versions inserted a
`linux` or `macos` argument, which this CLI tries to execute as a program. A panic
such as `Failed to execvp linux: No such file or directory` therefore indicates
the obsolete invocation. Update the runner and restart the saved mission. No
proof attempt was started; workspace rebuilding or installing a program named
`linux` is unnecessary. Other sandbox errors retain their original diagnostics.

## Windows sandbox readiness

Automatic selection starts with MXC. A readiness failure with
`CreateProcessSecurityEnvironment failed (HRESULT = 0x800705AA)` checks the
protected elevated sandbox. After three protected failures reporting
`setup refresh had errors`, `windowsSandboxRecovery: "allow-unelevated"` permits
a complete unelevated readiness check. Only a successful probe changes later
commands in that process. Unelevated retains a filesystem sandbox but has weaker
network isolation. The project and optional example both use `"protected"` to
disable this recovery by default.

Explicit sandbox selections are respected. Recovery does not kill other
sessions or modify saved Codex settings, spends no proof attempt, and retries at
most once a minute across workers. A restart tries protected modes again. Logs
and `.runs/codex-sandbox-recovery.json` preserve the outcome; Mission Control
shows the readiness error. Install/login help is in the [README](../README.md).

## Inspect a wait or result

Begin with **Needs attention → Inspect operation**, then inspect the current
blocker, next poll, attempt timeline, immutable artifacts, and remote operation
IDs. **Runner details → Observation freshness** distinguishes old checkpoints
from a disconnected browser. A graph refresh and a browser refresh are separate.

The terminal prints queue moves, API completion/verdict lines, failures/retries,
and periodic wait summaries. Long commands print their log path and heartbeats;
command logs have adjacent `.timing.json` files. Follow a printed log in another
PowerShell terminal with:

```powershell
Get-Content -LiteralPath "<printed log path>" -Tail 20 -Wait
```

Pending verdict checks save due times (normally at least 20 seconds apart);
publication checks use five-second delays and release workers between checks.
Unknown operations retain saved retry deadlines across restart. The checkpoint
exposes local/remote activity, stage waits, handoffs, graph reconciliation and
pending updates, worker permits, and recovery reasons.

## Read-only diagnostic scripts

These are optional operator tools, not part of the first-run workflow.

```sh
# Verify immutable uploads, publication identities, verdicts, and reduction links.
node scripts/verify-mission-run.mjs --root ROOT_THEOREM_ID --since ISO_TIMESTAMP

# Capture the complete graph, including completed/dead prerequisite paths.
node scripts/inspect-mission-graph.mjs --root ROOT_THEOREM_ID

# Summarize a previous graph capture offline, without writes.
node scripts/inspect-mission-graph.mjs --snapshot PATH

# Compare saved prompt outcomes; dates need a timezone.
node scripts/analyze-prompt-experiment.mjs --last-minutes 60

# Audit local saved logs and Codex rollouts without invoking a model.
node scripts/analyze-agent-usage.mjs
```

Live verification requires a root and saves
`.runs/diagnostics/live-server-validation.json`. Reused confirmed declarations
can predate `--since`; their creation times are included. Root status is reported
separately because accepted children do not prove the root. Graph capture saves
under `.runs/diagnostics/`; `--out PATH` selects the destination.

The usage audit takes optional positional **Codex home** and **output JSON**
paths. Home resolution is explicit argument, then `CODEX_HOME`, then
`path.join(os.homedir(), '.codex')`; there is no personal machine path. It expects
saved `.runs` artifacts and produces local account-sensitive diagnostics. The
prompt report can save rows with `--output PATH`, or use `--since ISO_TIMESTAMP`
to hold a cohort fixed while pending verdicts arrive. Counts use saved outcomes,
not a fresh server verdict read; keep pending work separate when comparing.

For historical quota failures incorrectly counted as attempts,
`node scripts/repair-quota-attempts.mjs` previews an evidence report. With the
runner stopped, `--apply` acquires the lock, backs up state, and appends
deduplicated exclusions for confirmed quota logs. It does not renumber artifacts
or exclude completed mathematical work.

## Exit behavior and validation

A proof run exits `0` only for a server-confirmed proved root. A disproved root
uses `DISPROVED`, `completed: false`, and exit `1`. Fatal/invalid configuration
or state errors also use `1`; Ctrl+C uses `130`, SIGTERM `143`. Recoverable
readiness/API problems, unsuccessful mathematics, and pending targets normally
keep the runner active. Read-only preview/help commands do not use root-completion
exit semantics.

The maintained [verification guide](verification.md) replaces historical slice
validation notes. Use the offline suite for workflow regressions and the
optional real Lean/browser checks for their documented boundaries. Offline tests
do not demonstrate production throughput; see [throughput tuning](throughput-tuning.md).
