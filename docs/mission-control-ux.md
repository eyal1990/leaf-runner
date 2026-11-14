# Mission Control design

Mission Control is a local dashboard for monitoring and operating the runner.
See the [project README](../README.md) for launch commands and current settings.
This document records interface contracts and implementation boundaries for
contributors.

## Current scope

The dashboard registers missions and manages one running mission per checkout.
It shows result activity, the solver frontier, pipeline capacity, account-limit
observations, theorem and attempt details, research, and effective settings.
Controls support starting a saved mission, pausing admission or model dispatch,
stopping and saving, and editing supported run settings.

The mission navigation remains visible above every dashboard: **Current mission**
selects a saved mission, **New mission** opens setup, and **Previous missions**
opens a searchable list. Viewing a different mission changes no runner state.
When another managed mission is running, show its name and **View running mission**
alongside **Stop and switch**, which confirms, stops and saves the active runner,
waits for acknowledgement, then starts the selected mission. External runners
must still be stopped in their own console. Mission changes reset theorem,
artifact, and activity filters so details cannot leak into another mission's view.

Credentials stay on the local server, which listens on `127.0.0.1`. The browser
uses an authenticated local session. The runner lock remains authoritative for
execution; the supervisor has a separate registry lock. An external console
runner can be monitored, but must be stopped before managed execution or settings
changes that require supervisor ownership.

## Status and progress

The first screen should identify the selected mission and root, show useful work
and accepted results, and expose the leading blocker with an applicable action.
Keep runner lifecycle, operator pauses, resource waits, and root outcome distinct.
A running process or an empty frontier does not establish that the root is proved.

| Measurement | Meaning |
| --- | --- |
| Root outcome | Server-confirmed status with its observation time |
| Accepted proofs, reductions, and disproofs | Separate categories of distinct confirmed submissions |
| Pending remote work | Operations without a terminal verdict, including an explicit unknown-status subset |
| Open leaves | Unique unresolved leaves in the current saved solver frontier |
| Selectable work | Tasks eligible for admission, including parent and cycle repairs |
| Account limits | Provider-reported usage for the shared account, including other activity |

Period filters apply to result activity. Queue, capacity, root, and frontier
observations describe current state and need their own freshness labels. A solver
snapshot prunes completed paths; a full graph audit has separate coverage and can
require many API requests.

Do not derive a mission completion percentage, completion ETA, or remaining
attempt count from graph size or quota percentages. An accepted reduction can
grow the frontier; a child disproof can invalidate a route without disproving its
parent. Scheduling closability is an estimate, not a proof of root completion.

## Capacity and work inspection

Show `PREPARE`, `CODEX`, `VALIDATE`, and `SERVER` with effective worker limits,
waiting entries, reservations, and the reason for a wait. Validation means local
compilation only in local verification mode.

- Waiting counts include delayed entries and incoming reservations, and exclude
  running workers. Show reservations explicitly without counting them as jobs.
- Each theorem job appears once, including during a saved handoff.
- Research shares model capacity but does not increase theorem-job counts.
- In server-only mode, local jobs reserve remote capacity. Show remote jobs and
  local reservations against `maxRemoteJobs`; the ordinary server queue size
  does not apply. Show verdict polling separately from server actions.
- Read limits from effective runtime settings. A saved configuration may differ
  from settings already assigned to active work.

The theorem inspector links exact statements, attempt history, model assignments,
stage timing, immutable candidates, verdicts, dependency alternatives, and
relevant diagnostics. Fetch artifact excerpts on demand through the redacting
gateway. Preserve filters and selection during refreshes.

Account observations need timestamps and a stale state on read failure. Unknown
values must not appear as zero. A quota reset does not undo an operator pause;
recovery remains the coordinator's responsibility.

## Commands and ownership

Commands carry explicit scope and identity. Display requested, applied, or
rejected state from acknowledgements. Repeated delivery must not duplicate
effects, and stale revisions must refresh the view before another change.

The main **Stop agents** button cancels active proof, repair, formatting, and
research invocations, including their child processes, and prevents new agent
invocations until **Resume agents**. Preparation, validation, submissions, verdict
polling, and Mission Control continue. Interrupted attempts keep their identity,
partial proof snapshots, and formatting inputs across restart. The stop persists
independently of admission, dispatch, and quota pauses; resuming agents clears
only the agent stop. The button applies immediately without a confirmation dialog.

Pausing admission, available in Mission actions, lets admitted jobs continue. Pausing model dispatch prevents
new proof, repair, and research invocations while active invocations finish.
Stopping saves local work; already-issued server submissions can continue.
Settings changes preserve active assignments and drain existing owners when
capacity is reduced. See the README for which changes apply immediately.

An uncertain POST requires reconciliation through its immutable operation journal.
A browser action must not bypass that policy or directly edit job state.

## Implementation boundaries

| Module | Responsibility |
| --- | --- |
| [`mission-control-server.mjs`](../mission-control-server.mjs) | Local sessions, routes, account sampler, and supervisor |
| [`mission-control-data.mjs`](../mission-control-data.mjs) | Dashboard read model and artifact access |
| [`mission-control-commands.mjs`](../mission-control-commands.mjs) | Scoped commands, persistence, and acknowledgements |
| [`runner-config-store.mjs`](../runner-config-store.mjs) | Configuration reads and revision-checked updates |
| [`pipeline.mjs`](../pipeline.mjs) | Admission, capacities, stage ownership, and checkpoints |
| [`job-store.mjs`](../job-store.mjs) | Canonical job revisions, attempt history, and operation identities |
| [`work-selection.mjs`](../work-selection.mjs) | Frontier, scoring, durable claims, and graph observations |
| [`codex-quota.mjs`](../codex-quota.mjs) | Shared account-limit recovery |

Tests in `test/mission-control*.test.mjs` and `test/mission-settings.test.mjs`
cover the dashboard, command boundaries, supervisor behavior, settings, and UI
contracts. Run them with Node's test runner; see the README for the full suite.

## Deferred capabilities

Concurrent missions, scheduler priority and exclusion overrides, manual research
requests, operator-supplied context, and notifications need additional ownership
and coordination support. Expose controls only when their handlers, persistence,
and recovery behavior exist. Concurrent missions also require shared account,
API, theorem-claim, publication-name, and workspace limits.

Future interfaces should preserve keyboard access, visible focus, text labels
alongside status colors, observation times, and a useful narrow-screen layout.
Reports should make scope, pending outcomes, and coverage clear and exclude
credentials and raw transcripts.
