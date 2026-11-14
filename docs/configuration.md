# Configuration reference

Most daily changes belong in **Run settings**; see the
[UI guide](mission-control.md#run-settings) for every field. The runner loads
[runner-config.json](../runner-config.json) from the project automatically, even
when launched from another directory. The optional
[runner-config.example.json](../runner-config.example.json) is a different
profile, not the default. This table describes the checked-in files; after a UI
save, the selected file and effective settings shown in Mission Control apply.

| Setting | Project default | Optional example |
| --- | --- | --- |
| Proof model (`attemptModels`) | `luna-6-high` — Luna High | `terra-6.1-medium` — Terra Medium |
| Prompt (`promptVariant`) | `balanced` | `balanced` |
| Automatic escalation (`incompleteEscalation.after`) | `2` | `2` |
| Rescue profile / attempt limit | `sol-6.1-high` / `1` per stall | `sol-6.1-high` / `null` (uncapped) |
| Research model (`missionReviewModel`) | `terra-6.1-medium` | `luna-6-high` |
| Research interval (`missionReviewEvery`) | `100` | `100` |
| Verification (`verificationMode`) | `server-only` | `server-only` |
| Windows recovery (`windowsSandboxRecovery`) | `protected` | `protected` |
| Local jobs (`maxActiveJobs`) | `4` | `16` |
| Remote commitment (`maxRemoteJobs`) | `8` | `48` |
| Prepare waiting / workers | `2` / `2` | `4` / `4` |
| Codex waiting / workers | `2` / `2` | `8` / `8` |
| Validate waiting / workers | `1` / `1` | `1` / `1` |
| Server waiting / action workers | `4` / `1` | `4` / `1` |
| API requests (`apiConcurrency`) | `8` | `8` |

In server-only mode, `maxRemoteJobs` controls remote capacity instead of Server
waiting capacity. Each local job reserves one remote slot, so local jobs plus
remote jobs cannot exceed that limit. Local mode uses `maxActiveJobs` for all
admitted jobs and serializes preparation. Validation stays serialized in both
modes. With eight API permits and one server action worker, up to six due
verdict reads run separately, retaining one permit for graph/context reads.

Capacity limits bound parallel work, not total attempts, time, or spending.
The rescue limit applies per stall; base-model attempts continue afterward.

## File settings outside the UI

Stop/save before changing these, edit the file shown by **Run settings**, then
start again. The UI does not expose every file setting.

| Key | Meaning |
| --- | --- |
| `verificationMode` | `server-only` or `local`; see [verification modes](verification-modes.md) for prerequisites and guarantees. |
| `apiConcurrency` | Shared maximum simultaneous API requests. Server action workers must be fewer than this limit. |
| `missionReviewEvery` | `0` disables research. A positive interval triggers an initial review after 10 distinct theorem IDs (or the interval if smaller), then each interval of additional IDs. |
| `missionReviewModel` | Separate research profile, sharing Codex capacity and quota. |
| `windowsSandboxRecovery` | `protected` prevents the optional unelevated fallback; `allow-unelevated` permits it after repeated protected readiness failures. Unelevated has weaker network isolation. See [operations](operations.md#windows-sandbox-readiness). |
| `recovery.initialDelayMs` | Initial retry delay, `30000` (30 seconds) in both files. |
| `recovery.maxDelayMs` | Maximum backoff, `900000` (15 minutes). |
| `recovery.reconcileAfterMs` | Unknown-operation reconciliation deadline, `600000` (10 minutes). |
| `recovery.pendingTimeoutMs` | Pending-operation watchdog, `1800000` (30 minutes). |
| `_comment` | Explanatory JSON data, ignored for execution. |

Queue keys in JSON are `prepare`, `codex`, `validate`, and `server`, each with
`maxSize` and `concurrency`. Waiting capacity includes delayed jobs and incoming
reservations, not running workers. It may be smaller than the worker count.
Capacities must be positive integers; research frequency may be zero. Unknown
keys, invalid shapes, and invalid profiles fail before credential/API work.

## Model schedules and escalation

The project proof profile `luna-6-high` selects `gpt-6-luna` with High reasoning.
A one-entry `attemptModels` array repeats indefinitely. For example,
`["luna-6-high", "luna-6-high", "sol-6.1-medium"]` uses Luna for lifetime attempts
1 and 2, then Sol Medium thereafter. Numbering survives context changes and
restarts. An explicitly empty array uses Luna High. Omitted fields inherit the
project configuration. Arrays replace rather than merge. Raw model IDs default
to High reasoning unless an effort suffix is supplied.

The project enables escalation with
`{ "after": 2, "model": "sol-6.1-high", "maxAttempts": 1 }`; after that rescue,
unchanged stalled work returns to its base model. The optional example uses
`maxAttempts: null` to continue rescues until progress. Eligible rescues
require concrete unresolved mathematical obligations and unchanged proof
progress. Reworded blockers require at least three outcomes and matching
evidence; generic refusals do not authorize a rescue. Changed code/declarations,
an accepted outcome, or a changed relevant context returns subsequent work to
its base schedule. Rewording, formatting, or different diagnostics alone do not.
Changed code is a progress heuristic, not a verified mathematical improvement.

Only one automatic rescue is reserved across preparing, running, and remote
jobs. All Sol proof invocations and explicitly configured Sol research share a
single invocation permit. `maxAttempts: null` continues rescue until progress;
a positive value caps rescues per stall; zero in `after` or `maxAttempts`
disables escalation. Explicit proof overrides and higher profiles remain
authoritative. Formatting-only repairs use Luna Low; research is separate.

## Advanced launch overrides

Normal use needs only the launcher and UI. For scripting, `--config PATH`
overlays a partial JSON file on the project configuration. Relative paths use
the current working directory. CLI overrides apply last; `--model` overrides
proof profiles and `--codex-concurrency` overrides the model-worker count.
For example, to select the optional example profile:

```sh
node prove2me.mjs --config runner-config.example.json
```

This still opens Mission Control without starting a mission. The settings dialog
shows the selected path and explicit overrides. UI saves preserve unrelated
settings/comments and reject conflicting edits. Supported changes apply to new
work after managed-runner acknowledgement; reduced capacities drain existing
owners. Direct file edits take effect at the next start. Running attempts retain
their assigned settings. Use `node prove2me.mjs --help` for the CLI reference;
the obsolete `--attempts` flag no longer caps attempts, and `--max-leaves` is
unsupported.
