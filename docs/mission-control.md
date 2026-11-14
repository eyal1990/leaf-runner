# Mission Control user guide

Start with the [README](../README.md) for installation and authentication. Open
Mission Control with **Start Leaf Runner.cmd** on Windows or `npm start`. Keep
the terminal open. The full session URL printed there opens your authenticated
local dashboard; the bare address may ask you to open it from the terminal.
The server listens on `127.0.0.1` (port 4317 by default). It starts no proof work
until you start a mission, and does not automatically resume old runs.

## Choose a mission

| Control | What it does |
| --- | --- |
| **New mission** / welcome-screen **Set up mission** | Opens the setup dialog. |
| **Mission name, URL, or ID** | Accepts a mission title, its Prove2.me mission-page URL, or its ID. Unicode and percent-encoded URLs work. |
| **Milestone** | Optional milestone name or ID within that mission. Leave blank for the mission's root. An unknown or unlinked milestone produces an error. |
| **Start working immediately** | Starts after setup when checked. Uncheck to register the mission, inspect settings, and start later. Disabled while another runner owns the checkout. |
| **Set up mission** in the dialog | Saves the mission and, if requested, starts it. Registration alone does not discover the frontier or invoke a model. |
| **Cancel**, **Close**, or the dialog's × | Closes without submitting the form. |
| **Current mission** | Changes which saved mission you inspect. The running mission keeps running. |
| **Previous missions** | Opens saved missions with process state, last save/start time, and proof/sketch counts. **Search missions** filters by mission or milestone name; **Open mission** changes the view. **New mission** opens setup. |
| **View running mission** | Returns to the mission currently running when you are viewing another. |
| **Stop and switch** | Asks for confirmation, saves/stops the active managed mission, then starts the selected one. Server submissions can finish afterward. |

Only one mission runs per checkout. Start controls are disabled while another
mission owns it. Registrations resolving to the same root share a navigation
entry; previous links remain usable. A runner launched outside Mission Control
can be monitored here, but must be stopped in its own terminal before starting a
managed run or editing its settings.

## Start, stop, and pause

Starting invokes models and can publish declarations and submit proofs. These
controls apply to the selected mission. **Confirm** applies the action described
in a confirmation dialog; **Cancel** or × leaves it unchanged.

| Control | What it does |
| --- | --- |
| **Start mission** | Starts a registered mission with its saved configuration. |
| **Start saved run** | Resumes saved jobs, candidates, and remote operations. It does not discard previous attempts. |
| **Stop agents** | Cancels active proof, repair, formatting, and research agents and their child processes. Prevents new agents from starting. Preparation, validation, submissions, polling, and the dashboard continue. Partial work is saved. |
| **Resume agents** | Clears the agent stop. Other operator pauses and recovery gates still apply. |
| **Mission actions → Pause new work** | Stops admission of new theorem jobs. Already admitted jobs continue, including queued model invocations. |
| **Mission actions → Resume new work** | Clears the admission pause. |
| **Mission actions → Pause Codex dispatch** | Prevents new proof, repair, formatting, and research invocations. Active invocations finish; validation and server work continue. |
| **Mission actions → Resume Codex dispatch** | Clears only the dispatch pause. |
| **Mission actions → Stop and save** | Stops the managed runner and local/model processes, saves work, and leaves Mission Control open. Existing server requests may finish. |
| **Refresh status** (circular arrow) | Rereads saved runner observations. It does not force a new API graph scan. |
| **Mission actions → Export report** | Downloads a JSON observation report for this mission and selected activity period. Review its contents before sharing. |
| **Exact root ↗** | Opens the selected root theorem on Prove2.me. |

Agent stops, admission pauses, and dispatch pauses persist across restart and
are independent of automatic quota recovery. Resuming one does not clear the
others. Ctrl+C in the launcher stops/saves its managed runner and closes the
local server. Closing the browser alone leaves the launcher running.

## Read the dashboard

The heading distinguishes **runner process state** from **root outcome**. A
running process, an accepted child proof, or an empty work table does not mean
the root is proved. Only a server-confirmed root result establishes completion.

| Area or control | Meaning |
| --- | --- |
| **Results** cards | Confirmed proof, sketch, and disproof submissions in the selected period, with unique theorem counts. Multiple accepted submissions can concern one theorem. |
| **Activity time range** | **Since run start**, **Last hour**, **Last 24 hours**, or **Custom period**. Custom **From**, **To**, and **Apply period** use the displayed local timezone. Filters historical results/activity, while queues, frontier, and pending work remain current. |
| **Theorem queues** | One card per stage: **Prepare** (workspace/context/readiness), **Codex** (proof/repair), **Validate** (candidate checks), **Server** (publication/submission/reconciliation). Each job appears in its current stage. |
| Queue counts | Running workers, waiting jobs, delayed jobs, and saved handoffs. Delayed jobs are included in waiting; handoffs retain their source stage until transferred. Worker capacity is a limit, not the number of jobs. |
| Click a queue card | Opens **Work → Active** filtered to that stage. **Clear … filter** removes the stage filter and shows all saved work. |
| **View all work** | Opens **Work → All** without a stage filter. |
| **Open leaves** count / **View open leaves** | Opens all observed frontier leaves, including unclaimed and already claimed tasks. |
| **Selectable tasks** / **repairs** | The saved selection view's available tasks and parents needing a new reduction. Counts can differ from the number of unclaimed leaves. |
| **Dependencies** shortcut | Opens the dependency view. |
| **Capacity → Local jobs** | Admitted local jobs against their limit. In local verification, the overall active-job cap also applies. |
| **Remote commitment** | In server-only mode, remote jobs plus remote slots reserved for local jobs, against the remote job limit. |
| **Codex account limits** | Remaining capacity and reset times for observed usage windows. This is shared account usage, including work outside this checkout. Unknown or stale observations are labelled. |
| **Check limits now** | Makes a read-only account-limit request; updates the observation without clearing coordinator recovery gates. Automatic sampling is every 60 seconds. |
| **Check recovery now** | Appears during a managed quota pause. Asks the coordinator to recheck recovery immediately; this is separate from refreshing the account display. |
| **Needs attention → Inspect operation** | Opens a blocked/unknown job's inspector. Unknown remote effects are reconciled by the coordinator before replacement. |
| **Runner details** | Saved run ID, PID (if known), process state, and root outcome. |
| **Observation freshness** | Expands browser, runner heartbeat, checkpoint, graph, and account observation times plus timezone. Browser refreshes every four seconds; saved data may be older. |
| **Inspect saved settings** | Opens the same dialog as **Run settings**. |

Research shares Codex worker capacity but is not a theorem job, so it can occupy
a worker without appearing in queue job totals. Recovery banners explain quota,
API, environment, or proof-storage waits. See [operations](operations.md) when
investigating a wait. Completed or stopped missions show saved observations.

## Tabs and filters

### Work

| Control | Meaning |
| --- | --- |
| **Active** | Admitted theorem jobs, including running, queued, delayed, and handing-off work. |
| **Ready next** | Scored selectable tasks, rather than a FIFO queue or guaranteed next invocation. Shows the selection reason and score. |
| **Waiting** | Active jobs without a running worker. |
| **Needs attention** | Jobs with blockers, unknown remote state, or saved attention status. |
| **All** | All saved jobs visible in the selected mission observation. |
| **Find theorem** | Filters names and IDs, ignoring case. |
| **Filter by model** / **All models** | Narrows saved jobs to a model. |
| **Filter by task kind** | **All task kinds**, **Leaves**, or **Parent / cycle repair**. |
| **Sort work** | **Theorem name** alphabetically; **Longest waiting** by oldest saved update; **Highest score** by descending score (most useful in Ready next). |
| Theorem row | Click, Enter, or Space opens its inspector. Columns show stage/operation, state or selection reason, model, lifetime/current-context attempts, and update age or score. |

The table displays up to 150 matching rows; narrow filters to find more. The
**Recent accepted results → All results** shortcut opens Results. Filters and
inspector links are saved in the browser URL. Changing missions resets the view.

### Open leaves

Lists all leaves in the saved frontier, independently of the results time range:
theorem, work status, queue, and model. Click a row to inspect it. An empty view
may mean no graph has been observed yet or that the root/dependencies need
inspection; it is not proof of completion.

### Results

Lists distinct accepted submissions in the chosen period; click their theorem
names to inspect. **Export** downloads the same scoped report as the mission
menu. **Pending remote work** shows current unfinished operations independently
of the time range. Accepted sketches create obligations; a child disproof does
not by itself disprove the mission root. Counts use local verdict observation
times and confirmed submission IDs; older records can have partial attribution.

### Dependencies

**Path to the root** shows the solver's observed graph. Expand a theorem row to
see reduction alternatives and choose **Inspect theorem** or a child name.
Alternatives are OR routes; every child within one route is required (AND).
Blocked routes cannot establish the parent. This is a frontier snapshot and may
prune completed paths. The first 100 nodes are displayed; export includes the
full observed list. For a complete server graph audit, see [operations](operations.md).

### Research

Shows the latest completed advisory review, its observation time and node count,
and clickable HTTPS **Sources** with their purposes. **Reviewing** means a review
is in progress. Suggestions are advisory, not accepted dependencies or proofs.
Errors and observed/reviewed counts explain an empty view. Research model and
frequency are configured in the file, outside the settings form; see
[mission research](mission-research.md).

### Activity

Shows the latest 200 attempt events in the selected period, including starts and
outcomes, model, theorem, attempt, and time. Click a theorem to inspect it. The
launcher's terminal retains general runner logs; individual saved logs load in
the inspector.

## Theorem inspector and artifacts

Open an inspector from a theorem row, result, dependency, activity event, or
attention card. It shows the exact saved statement and expandable **Preamble**,
selection score/operation/cycle members when available, job/attempt ownership,
stage and dispatch state, attempts, next poll, stage waits, blockers, remote
operation identities, and the last 40 structured attempt events.

| Control | Meaning |
| --- | --- |
| **Copy link** | Copies the current local inspector URL. Another browser needs its own authenticated local session. |
| **Close inspector** / Escape | Closes the panel. Escape first closes an open dialog when applicable. |
| **Choose artifact** | Selects a saved source, explanation, prompt, manifest, or log. Selection alone does not load its content. |
| **Load** | Fetches the selected redacted artifact excerpt on demand. Log reads show the last 256 KiB; truncation is indicated. |
| **Search loaded artifact** | Shows matching lines in the loaded excerpt; does not search the full file. |
| **Copy** | Copies the entire loaded redacted excerpt, even if the search is filtering visible lines. |
| **Download** | Downloads the loaded redacted excerpt as text, not the original full file. |
| **Follow log** | For `.log` artifacts, refreshes the excerpt every four seconds and scrolls to the bottom when no search is active. |
| **Pause following** | Stops the log refresh timer; does not pause the runner. |

Artifacts and logs are local observations and can include private mathematical
material. Redaction does not make every report safe to publish.

## Run settings

**Run settings** and **Inspect saved settings** open the same form. Its note
shows the exact configuration path, shared scope, and command-line overrides.
**Compare saved and running settings** appears when they differ; expand it to
see each value side by side. Settings are editable for a stopped mission or its
connected managed runner, provided no other mission/external runner owns the
checkout.

### Prompt and models

| Setting | Meaning |
| --- | --- |
| **Prompt variant → Balanced** | Allows complete proofs and decomposition into child theorems. |
| **Proof first** | Prioritizes a complete proof with helpers in the solution; child theorems are a justified last resort. |
| **Proof only** | Allows complete proofs or certificates of the full target negation, with all helpers proved in the solution. No sketches or unproved children. |
| **Proof models → Attempt N / Attempt N onward** | Profiles used in order of lifetime attempt number; the final profile repeats. The form edits existing schedule entries; it has no add/remove-entry control. Use the configuration file to change schedule length. |
| Model summary button | Opens model and reasoning selection for that attempt or the rescue profile. Click the model name to choose a listed family/version. |
| **Reasoning effort** slider | Selects the chosen model's supported effort; its current label is displayed. Changing models keeps the effort if supported, otherwise selects High. Escape dismisses the popover. |
| **Automatic escalation → Incomplete-result threshold** | `0` disables escalation (the project default). A positive value permits a stronger rescue model after evidenced repeated incompleteness with unchanged proof progress; identical results use the threshold, while reworded blockers need at least three results and matching evidence. |
| **Rescue model** | Model and effort for an eligible automatic rescue. Explicit proof model overrides and higher configured profiles remain authoritative. |
| **Rescue attempt limit** | Blank means unlimited until recorded progress, a positive integer caps automatic rescues per stall episode, and `0` disables escalation. |

The model menu lists **GPT-6.1 Sol**, **GPT-6 Astra**, **GPT-6.1 Terra**,
**GPT-6 Sol**, and **GPT-6 Luna**. The effort slider offers **Low**, **Medium**,
**High**, **Extra high**, and **Max**; all listed families except Luna also offer
**Ultra**. These are the choices implemented by this version's picker; account
access is still required. A recognized configured version beyond that menu is
retained so it can be edited without silently changing its version.

Rescue uses saved attempt history across restarts. All Sol proof calls and
explicitly configured Sol research share one invocation permit, even if Codex
has multiple workers. Formatting repairs use their own Luna Low profile; mission
research has its own file-configured profile. See [configuration](configuration.md).

### Queues and job limits

Every queue has **Waiting capacity** (queued jobs plus incoming reservations,
excluding running workers) and **Workers** (concurrent stage work).

| Queue / field | Meaning and restrictions |
| --- | --- |
| **Prepare** | Workspace/context/readiness preparation. Server-only mode permits parallel workers. Local verification fixes workers at one. |
| **Codex** | Shared concurrency for proof, repair, formatting, and research invocations. A value of `1` serializes model calls, not total attempts. |
| **Validate** | Candidate validation; workers is fixed at one. |
| **Server** | Publication, upload, and recovery action workers. Must stay below configured API concurrency, leaving capacity for graph/context reads. Verdict reads have a separate bounded lane. |
| **Server → Waiting capacity** | Disabled in server-only mode because Remote job limit controls remote capacity there. Applies in local mode. |
| **Local job limit** | Maximum admitted local jobs/private workspace leases in server-only mode; overall active-job cap in local mode. Affects workspace/disk use as well as utilization. |
| **Remote job limit** | In server-only mode, bounds remote work plus slots reserved by local jobs. Does not replace the local-mode overall cap. |

Use positive whole numbers for queue and job capacities. Reduced limits let
existing work drain rather than discarding it. More workers cannot create more
independent tasks or bypass account/server limits.

**Save settings** writes the selected file, checks for conflicting file edits,
and waits for the managed runner's acknowledgement when running. Supported
changes apply to upcoming work; existing attempts, continuations, and formatting
repairs keep their assigned settings. Matching saved model/capacity values replace
command-line overrides for future starts. **Cancel** or × discards unsaved form
edits. Direct file edits require a runner restart to change the running settings.

Verification mode, API concurrency, research frequency/model, recovery timings,
and Windows sandbox policy are file settings, not controls in this dialog.
[Configuration](configuration.md) covers these without requiring a long command
line. Missions sharing a file share its saved settings.

## Connection and keyboard navigation

The top connection indicator reports whether the browser can read the local
server and the age of its last refresh. Reopen the full terminal URL after a
server restart if the session expires. Refreshing a page does not restart work.
The footer shows the browser's timezone.

**Skip to dashboard** moves keyboard focus to the main content. Left/Right
arrows move between detail tabs; Enter/Space opens a focused theorem row. Model
menus support Up/Down/Home/End and the effort slider supports keyboard changes.
Dialogs provide Close/Cancel controls, and Escape dismisses dialogs/popovers.
