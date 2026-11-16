# Plan: add Claude alongside Codex

Status: proposed implementation plan; no runtime changes made.
Review date: 2026-11-15.

## Recommendation and scope

Add a provider boundary around agent execution, keeping Codex as the default and
adding a Claude adapter backed by the official Claude Agent SDK. Run the SDK in
a supervised Node helper so the existing timeout, cancellation, process-tree
cleanup, and artifact lifecycle remain under Leaf Runner's control.

This is an agent integration, not just a model-name change. Proof workers read
Mathlib and context, write Lean files, call the theorem-library tools, and return
structured answers. A direct Claude Messages API integration would also require
implementing that tool loop. The Agent SDK already supplies one. A subprocess
using `claude -p` is a viable alternative transport, but the SDK offers explicit
permission/tool hooks and typed events that help with this application's
workspace restrictions. [Anthropic's integration overview](https://code.claude.com/docs/en/agent-sdk/overview)
describes these choices.

Target behavior:

- Existing configurations and saved Codex runs keep working.
- A Claude-only configuration can prove, repair, research, stop, and resume
  without requiring a Codex installation or login at runtime.
- Proof schedules, configured rescues, and research can explicitly use different
  providers; configured mixed-provider work shares the global worker limit.
- Claude produces the same proof, sketch, counterexample, and incomplete-result
  contracts and goes through the existing validation/submission gates.
- Account failures pause the affected provider's work while other eligible work
  and issued server operations continue. No automatic provider switch on quota.

Use Anthropic API-key authentication for the first supported integration. Do not
assume a Claude Pro/Max login is interchangeable with the current Codex login:
Anthropic's SDK documentation requires API-key authentication for third-party
products unless approved otherwise. Subscription-based integration would require
a separate supported-access decision. [Authentication guidance](https://code.claude.com/docs/en/agent-sdk/overview#get-started)

The largest platform decision is Windows. Claude's shell sandbox runs on Linux,
macOS, and WSL2; native Windows commands run unsandboxed. Its file tools, hooks,
and MCP servers also sit outside that shell sandbox. Do not map Codex's
`workspace-write` setting to a permissive Claude permission mode and claim
equivalent isolation. [Sandbox boundaries](https://code.claude.com/docs/en/sandboxing)

Recommended first native-Windows mode: expose bounded runner-owned workspace
read/list/search/write tools and disable Claude's general shell, unrestricted
file tools, web tools, and subagent spawning. Proof prompts already prohibit
worker compilation and API access, so the runner can retain all Lean builds and
platform operations. If a shell is required, support it inside an explicitly
isolated WSL2/container environment; run the whole runner there initially to
avoid cross-OS path, process, Lean-cache, and loopback-bridge problems. Validate
this execution policy in the initial spike before committing to full parity.

## Current coupling and affected files

Locations below refer to the reviewed source, not proposed modules.

| Area | Relevant files / entry points | Required change |
| --- | --- | --- |
| Installation and executable discovery | `package.json`, `package-lock.json`; `prove2me.mjs:executable`, `main` | Pin the selected Claude runtime dependency and resolve only providers needed by enabled roles. The current `.cmd` handling knows only the Codex npm launcher. An SDK helper avoids treating a Claude shim as a Codex launcher. |
| Process lifecycle | `prove2me.mjs:command`, `stopChildren`, `childEnv`; `agent-control.mjs` | Reuse supervision for the SDK helper and all descendants. Separate provider environments; currently only `PROVE2ME_*` variables are removed. |
| Proof calls | `prove2me.mjs:agent`, `invokeProofAgent` | Extract Codex flags and result parsing into an adapter; keep shared prompt creation, source snapshots, filename recovery, and candidate checks outside it. |
| Formatting repair | `prove2me.mjs:repairAnswer`; `job-stages.mjs:invokeModelAction`; `pipeline.mjs:dispatchModel` | Remove the hardcoded Luna/low model from all three routing/permit paths. Use a configured repair profile or a documented same-provider default. |
| Mission research | `prove2me.mjs:reviewMission`; `mission-research.mjs`; `pipeline.mjs:maybeReview`, `assertReviewSlot` | Route research through the selected adapter, use `REVIEW_SCHEMA`, retain advisory-only results and runner-owned resource downloads, and persist provider identity. |
| Readiness and recovery | `prove2me.mjs:prepareAgentEnvironment`, `checkAgentEnvironment`, `agentEnvironmentConfig`; `codex-sandbox-recovery.mjs` | Split generic workspace/Lean readiness from provider readiness. Codex currently runs the probe through `codex sandbox` even in server-only mode. Claude readiness must not invoke Codex or consume a proof attempt. |
| Workspace instructions | `prove2me.mjs:initializeEnvironment`; `agent-prompts.mjs`; `workspace-updates.mjs`; `worker-context.mjs` | The runner writes `AGENTS.md`. Supply the same trusted instructions explicitly to Claude; do not rely on it loading that file. Remove provider names from generic readiness/resume text and provide precise allowed paths/tools. |
| Model identity and escalation | `model-policy.mjs`; `work-policy.mjs` | Add provider-aware profiles and capabilities. Existing parsing supplies OpenAI reasoning defaults; escalation evidence accepts only Luna/Terra, ranking is an OpenAI model list, and Sol detection controls permits. |
| Configuration and live updates | `pipeline-config.mjs`, `runtime-settings.mjs`, `runner-config-store.mjs`, `runner-config.json`, `runner-config.example.json`; CLI in `prove2me.mjs` | Extend strict validation, layering, persistence, overrides, and acknowledged live updates for provider profiles, repair selection, provider limits, and supported runtime policy. |
| Scheduling | `pipeline.mjs`; `serial-jobs.mjs` | Replace the single global Codex quota gate with provider-specific gates. Keep one global agent-worker cap plus provider/model limits. Proof, format repair, and research must reserve the actual adapter/model before dispatch. |
| Quota and errors | `codex-quota.mjs`; quota handling in `serial-jobs.mjs`, `pipeline.mjs` | Preserve Codex's account RPC/parser in its adapter. Add Claude-specific error normalization, retry deadlines, and durable recovery; do not send Codex `app-server` RPCs to Claude. |
| Durable state and histories | `job-store.mjs`, `attempt-history.mjs`, `serial-jobs.mjs`, `runner-state.mjs`; mission research manifests | Add provider/invocation metadata and backward-compatible state readers, including `codex_quota_wait` and `codex_partial` recovery. Preserve lifetime counts, candidate hashes, claim ownership, and operation IDs. |
| Theorem-library configuration | `theorem-library.mjs:openTheoremLibrary`; `theorem-library-mcp.mjs` | Return a transport-neutral MCP descriptor; currently the library returns Codex TOML arguments. Translate it to each adapter's config without changing authenticated retrieval. |
| Dashboard backend and IPC | `mission-control-server.mjs`, `mission-control-data.mjs`, `mission-control-commands.mjs` | Replace unconditional Codex account sampling with provider-aware capabilities, extend safe read models/exports, target quota commands by provider, and preserve configuration revision checks. |
| Dashboard settings | `mission-control/model-picker.js`, `mission-control/mission-settings.js` | Add provider/model choices and model-specific effort controls. The current catalog/parser/serializer only understands OpenAI families. Render repair/research selection or clearly expose their effective file settings. |
| Dashboard status and artifacts | `mission-control/app.js`, `mission-control/index.html`, `mission-control/styles.css`; artifact allowlist in `mission-control-data.mjs` | Show Agents as the worker stage, provider labels and recovery state, accurate usage availability, and permitted Claude/normalized log artifacts. Update Codex-specific banners, confirmations, research copy, and metadata. |
| Operator diagnostics | `scripts/analyze-agent-usage.mjs`, `scripts/summarize-usage-windows.mjs`, `scripts/audit-model-escalation.mjs`, `scripts/repair-quota-attempts.mjs`, `scripts/analyze-prompt-experiment.mjs`, `scripts/capture-readme-screenshot.mjs` | Add normalized invocation records; keep legacy Codex readers explicitly scoped. Do not parse Claude as a Codex rollout or fabricate account-window statistics. Extend evidence-backed quota correction separately if needed. |
| Tests and distribution | `test/`, `e2e/mission-control.spec.mjs`, `e2e/fixtures/runner.mjs`, `.github/workflows/ci.yml`; `Start Leaf Runner.cmd` | Add provider fixtures and compatibility coverage across supported platforms. Confirm the existing launcher propagates provider environment/configuration without changing its ordinary startup behavior. |
| Setup and published guidance | `.env.example`, `.gitignore`, `credentials.example.json`, `README.md`, `THIRD_PARTY_NOTICES.md`, relevant `docs/` guides | Document API-key setup/billing, install/runtime policy, configuration, usage limitations, and recovery. Keep `credentials.json` for Prove2.me and all provider secrets out of tracked files. Review dependency notices. |

The following systems can largely stay provider-independent: Prove2.me's Client,
frontier discovery/scoring, graph updates, Lean source/type/dependency gates,
publication journals, and remote verdict reconciliation. Review their model
metadata interfaces, but keep mathematical acceptance controlled by existing
gates. In particular, inspect `lean-artifacts.mjs`, `remote-actions.mjs`,
`publication-store.mjs`, `proof-storage-recovery.mjs`, `isolated-workspaces.mjs`,
`compiled-dependencies.mjs`, and `verification-mode.mjs` for integration regressions.

## Proposed execution and configuration contracts

Introduce `agent-provider.mjs` with adapters under `providers/`, initially
`codex.mjs` and `claude.mjs`, plus a supervised `claude-worker.mjs`. Names are
proposals, not existing files.

An invocation request should include:

- Role: proof/mathematical repair, format repair, or mission research.
- Provider, model ID, supported effort/options, invocation ID, and attempt ID.
- Prompt, schema, working directory, exact readable/writable resources, MCP
  descriptors, output paths, timeout, and cancellation signal.

Adapters produce a normalized result: structured answer, actual provider/model,
optional provider session ID, terminal status, usage/cost when reported, and
raw-log references. Normalize errors into authentication/configuration,
rate-limit, exhausted balance/quota, transient transport/overload, invalid
structured output, timeout, and cancellation. Treat model prose and tool output
as data, not quota evidence. Nonzero exits and unsuccessful terminal result
events both matter.

Keep existing string profiles as Codex-compatible input. Add an explicit object
form such as `{ "provider": "claude", "model": "<pinned-model-id>" }` to
`attemptModels`, `missionReviewModel`, the rescue profile, and a new
`formatRepairModel` setting. The angle-bracket value is a documentation placeholder.
Omitted repair selection should resolve to a documented profile from the active
proof provider, rather than silently invoking OpenAI. Validate the resolved
profile at dispatch and persist it for formatting continuations.

Use one shared provider/model capability catalog for backend validation and UI
serialization. Store provider-specific effort support; do not blindly send
`xhigh`, `max`, or `ultra` from OpenAI profiles to Claude. Verify and pin concrete
model IDs and available efforts during implementation; aliases may move.
[Claude's model and effort flags](https://code.claude.com/docs/en/cli-reference)
are provider-specific.

Preserve the persisted `CODEX` stage and `queues.codex` initially as compatibility
identifiers, presenting them as Agents in the UI. Add `--agent-concurrency` as a
documented alias for `--codex-concurrency`, rejecting conflicting values. A stage
rename is a separate migration, not a prerequisite for Claude support.

Provider installation/authentication should be required only for enabled roles:
proof schedule entries, enabled rescue, effective format repair, and research
when `missionReviewEvery > 0`. List/preview and dashboard-only startup must not
require either provider. Existing Codex-only configs retain their defaults.

## Implementation sequence

### 1. Prove the Claude runtime and execution policy

Build a small disposable spike against a pinned Agent SDK/runtime. Verify it can
read a target and Mathlib source, write the exact assigned solution file, call
the stdio theorem bridge, return both existing schemas, and stop its complete
process tree. Check cancellation during tool use and an unsuccessful terminal
result even if the process exits normally. No mission publication is needed.

For native Windows, prototype scoped workspace tools with no general shell or
other escape-capable tools. Reads cover assigned workspace/context/reference
resources; writes cover only the assigned solution and permitted new dependency
modules. Canonicalize paths and reject traversal, symlink/junction escapes, and
changes to mirrored modules, environment files, credentials, or other jobs.
Research gets bounded reads and no writes; format repair gets only its supplied
answer data. Enforce limits on search scope, returned bytes, and tool duration.
Reuse explicit SDK configuration rather than inheriting arbitrary user/project
hooks, plugins, MCP servers, or instructions.

Exit criterion: a documented supported platform/tool matrix and passing
boundary/cancellation fixtures. If bounded tools cannot supply the required
workflow, make WSL2/container execution the first supported Claude mode and
state native Windows support as unfinished. Do not weaken execution policy
silently. Permission callbacks alone are not OS process isolation.

### 2. Extract Codex without changing behavior

Move Codex executable/config/schema-output/quota translation behind the adapter
contract. Keep shared solution preservation and validation in the runner. Split
workspace/source/Lean preparation from provider-specific probes and recovery.
Return an MCP server descriptor instead of Codex-specific arguments from the
library; serialize it inside the Codex adapter.

Exit criterion: existing offline, Lean integration, and browser checks pass with
the same Codex defaults and saved-state fixtures. No paid model call is needed.

### 3. Add provider-aware profiles and every invocation role

Implement the shared catalog and legacy normalization, then wire proof,
mathematical repair, format repair, and mission research through the adapters.
Support `ANSWER_SCHEMA` and `REVIEW_SCHEMA` using SDK structured output. Extract
the successful result's `structured_output`; do not parse free-form text or
accept a missing answer. Preserve partial Lean work on every exit, and retain
the existing source/answer consistency checks. The SDK can fail after its
structured-output retry limit; model that as a failed invocation, not an empty
candidate. [Structured-output behavior](https://code.claude.com/docs/en/agent-sdk/structured-outputs)

Update strict file/CLI/live-setting validation and merge semantics together.
Record the effective provider/profile for each invocation. Ensure a Claude-only
profile does not invoke Codex indirectly through readiness, formatting, research,
rescue defaults, or account sampling. Configuration must explicitly expose any
remaining mixed-provider role.

Replace OpenAI-only stall eligibility with evidence attached to the configured
base role/profile. Keep the same progress fingerprints and conservative blocker
checks. Honor the explicitly configured rescue target without inventing a
universal ranking between Claude and OpenAI models. Preserve the existing Sol
limit as a Codex capability/permit rule.

### 4. Make scheduling and recovery provider-aware

Introduce durable availability state keyed by provider and a nonsecret
credential/account scope, with optional model buckets. Keep a global worker cap,
provider caps, existing special-model permits, and a single automatic rescue
reservation. Research and formatting use the permit for their actual profile.

A waiting provider must release execution permits and not block other eligible
queued providers. Review admission, preparation reservations, graph refresh
conditions, and research dispatch too: all currently consult one quota object.
Avoid filling all local capacity with jobs waiting on one unavailable provider.
Operator stop/pause and proof-storage recovery still apply to all model work.

Use Claude's structured error/reset/retry data when available. Do not invent an
equivalent of Codex's account-rate-limits RPC. Unknown availability is displayed
as unknown; use bounded backoff and one eligible recovery invocation when no
read-only status mechanism exists. Missing credentials or exhausted billing
need a clear actionable state rather than an endless rapid retry loop.

Migrate legacy `codex_quota_wait`, `codex_partial`, quota checkpoints, and history
as Codex records. Add provider/session/invocation identifiers to new records;
retain attempt IDs, immutable candidates, and remote operation IDs. A quota or
operator continuation keeps its original attempt and saved partial work. Define
provider changes to take effect on the next mathematical attempt rather than
silently moving a partially executed invocation to another provider. Preserve
existing documented live-model reselection where compatible and test the
chosen continuation behavior explicitly.

Exit criterion: one provider can be unavailable while another produces work;
restart, stop, formatting interruption, and pending submission recovery neither
duplicate submissions nor increment mathematical attempts incorrectly.

### 5. Connect the theorem library and protect credentials

Feed the existing stdio bridge descriptor into Claude's per-invocation MCP
configuration. Keep the parent-owned Client, scoped loopback capability,
24-call journal/budget, cancellation, revision checks, and final dependency
freshness gates. Provider adapters must not expose platform mutation tools.

Use explicit SDK permission/tool controls and test their evaluation order; a
callback is not necessarily consulted for every already-allowed tool.
[SDK permission evaluation](https://code.claude.com/docs/en/agent-sdk/permissions)
defines the relevant boundaries. The scoped workspace-tool backend should
enforce paths independently of model prompts and general permission defaults.

Separate the Claude API key from Prove2.me credentials. Pass only the necessary
provider credentials to its runtime; remove unrelated secrets, and avoid putting
keys in CLI arguments, prompts, journal events, or the browser read model.
Review raw-output/artifact redaction and `.gitignore` for Claude-local auth and
settings files. Do not run interactive login from a proof worker.

### 6. Update Mission Control and operational reports

Show provider/model selection for proof and rescue, and the effective formatting
and research profiles. Preserve unfamiliar configured IDs instead of replacing
them on save. Only render effort controls the selected model supports.

Change user-facing worker/dispatch language to Agents. Display provider-specific
authentication/availability state, retry deadlines, and invocation usage/cost
when reported. Account-wide quota, run-local token totals, and cost are distinct
metrics; show unavailable account percentages explicitly. Sample only configured
providers with supported read-only capabilities, and make recovery commands
identify the intended provider. Keep server draining visible during a pause.

Extend backend read models, exports, artifact filename allowlists, settings
acknowledgements, and sanitization. Write provider-neutral invocation metadata
so future reports do not depend on reading a user's global `.codex/sessions` or
Claude session directory. Keep old Codex reports readable and accurately scoped.

### 7. Validate, document, and release incrementally

Extend offline fixtures before any live model validation:

| Test group | Required scenarios |
| --- | --- |
| Adapter contracts | Valid answers for both schemas; missing/malformed structured output; unsuccessful terminal events; timeout; cancellation; stderr/log handling; oversized output; partial-file preservation. |
| Profiles/settings | Legacy strings; explicit Claude objects; unsupported effort; unknown provider; raw/custom model preservation; CLI precedence; conflicting concurrency aliases; concurrent settings revisions; running calls retain assigned settings. |
| Full job flow | Both providers produce proof, incomplete, sketch, and exact-negation certificate candidates; mathematical repairs and formatting repairs route correctly; invalid sources cannot reach submission. |
| No hidden Codex dependency | Claude-only proof, repair, enabled research, and configured rescue work with no Codex binary/login; dashboard-only and list paths require no provider. |
| Recovery/fairness | Provider-specific limits, credential errors, resets without a status RPC, mixed-provider progress, research contention, Sol permit, automatic rescue permit, partial quota resume, restart, stop/save, operator pauses, storage recovery, and pending remote journals. |
| MCP and workspace boundaries | Real stdio handshake and lookup under Claude config; persisted budget across resume; optional startup failure; one session closing independently; path/junction escapes denied; credentials and other jobs unreadable; unapproved tools unavailable; fresh dependency checks retained. |
| Historical data | Existing schema-v2 jobs, legacy quota fields/logs, history exclusions, attempt counters, saved mission config, and manifests survive read/migration/restart. |
| Browser | Claude picker and effort behavior; settings round-trip; mixed-provider rows; unknown quota state; provider-targeted recovery; artifact access; desktop/mobile layout; stop/save IPC. |

Extend the existing Windows/Linux, Node 22/24 CI matrix using deterministic
provider fixtures. Keep live providers out of default CI. Run `npm test`,
`npm run test:lean`, and `npm run test:browser` for the implementation; add a
supported-platform SDK/configuration smoke check without a model request.

After fixtures pass, run a separately budgeted live Claude smoke test against a
synthetic/local target: source inspection, exact solution write, one library
lookup, structured answer, research, and format repair. A real platform
submission is a separate explicit integration test. Evaluate quality on a small
fixed theorem set using accepted complete proofs/disproofs, invalid candidate
rate, runtime, cost, and recovery behavior. Successful JSON alone is not proof
quality evidence.

Update README and `docs/configuration.md`, `docs/mission-control.md`,
`docs/operations.md`, `docs/verification.md`, `docs/verification-modes.md`,
`docs/scheduler.md`, `docs/mission-research.md`, `docs/theorem-library.md`,
`docs/throughput-tuning.md`, and dashboard design guidance. Include a sanitized
Claude-only example and an explicit mixed-provider example. Leave checked-in
Codex defaults intact for the initial release. Document the supported Windows
mode and any remaining shell restrictions before advertising full parity.

## Suggested delivery slices

1. Claude runtime/tool-policy spike and recorded compatibility decisions.
2. Provider contract plus unchanged Codex adapter and regression checks.
3. Claude proof/repair/research, profiles, scoped workspace tools, and MCP.
4. Provider-aware permits, errors, durable recovery, and legacy migration.
5. Mission Control, normalized usage, setup docs, and full validation.

Full Claude support is complete when a Claude-only mission can run through all
enabled roles, stop and resume, survive provider limits, and submit only through
the existing validated runner path, while existing Codex missions still work.
The runtime/tool-policy spike and recovery migration are the main uncertainty;
a reliable effort estimate should follow the first slice.
