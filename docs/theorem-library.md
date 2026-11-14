# Live theorem-library discovery

Proof and mathematical repair invocations can search prove2.me while they work. The runner supplies three read-only MCP tools in the same Codex invocation: `search_declarations`, `read_declaration`, and `inspect_dependencies`. This applies to the original, proof-first, and proofOnly modes. Formatting repairs and mission reviews do not receive these tools.

The agent chooses queries and follows results interactively. A local stdio adapter forwards tool calls to an invocation-scoped loopback capability. The parent runner executes only the supported reads through its existing API client, sharing authentication refreshes, API permits, recovery, and cancellation. Platform credentials never enter the adapter, tool definitions, prompt, or child environment. No global Codex configuration or new package dependency is needed. The per-invocation MCP configuration is supported by the project's pinned Codex CLI 0.162.1.

`search_declarations` searches names/keywords within the target's pinned Mathlib revision. It defaults to `Proved`; agents can explicitly search `Open` or `Definition`. Queries accept up to 160 characters and eight words. Definition searches use the current dedicated `/definitions` endpoint, with an explicit `status=Definition` fallback for legacy deployments. Definition reads and ordinary import mirroring support both API shapes. Results are bounded to ten per call and support offsets up to 1,000; previews direct the agent to read the exact declaration. This is the platform's keyword search, not semantic or Lean type search, and an empty page does not establish that a useful result is absent.

`read_declaration` fetches fresh declaration details by ID. It returns the exact statement or definition, preamble, import identity, platform imports, status, source hash, observation time, and an exact saved snapshot. Incompatible environments, invalid identities, deprecated declarations, and importing the target itself are rejected. A platform statement is reference evidence, not an independent proof certificate. The existing validation and server verdicts remain authoritative.

`inspect_dependencies` returns up to eight immediate reductions and 64 children, with explicit truncation indicators. Children within a reduction are AND prerequisites; reductions are alternatives. Structural imports remain distinguished from proof reductions. Dependencies can be Open, and their presence does not establish a complete proof. The agent can inspect further IDs within its lookup budget.

Before the invocation, the runner supplies at most three compact advisory matches from a shared local hint index. It samples at most 2,048 previously retrieved records and 512 legacy mirrored dependency records, with a one-second cold-index budget, and includes proved declarations from the selected mission's saved graph. The index is shared per authenticated client/environment for sixty seconds. Ranking uses overlapping words in names, statements, and definitions; it does not claim mathematical compatibility. Each supplied candidate is fetched live. Preparation allows at most six candidate reads within ten seconds. Cached source is never substituted when access or live reads fail. The initial context is preserved across continuations as dated advisory evidence.

Each attempt has a persisted budget of 24 tool calls, including preparation and failed platform reads. Concurrent calls reserve their budget before making remote requests. Quota continuations and restarts retain consumed reservations. An individual lookup is bounded to 110 seconds. Optional lookup failures become tool errors so the proof agent can continue with its existing mathematics. Missing optional MCP startup does not block Codex. Closing an invocation cancels its reads without cancelling other jobs or a shared recovery probe.

Artifacts live under `.runs/<theorem-id>/retrieval-<attempt>/`:

- `identity.json` binds the evidence to the exact target and environment.
- `starting-context.json` contains the bounded initial matches and reference paths.
- `calls/<operation-id>.json` journals the request before its read, then its result, hash, and timestamps.
- `declarations/<id-hash>-<source-hash>.json` retains exact declaration snapshots.

`prompt-<attempt>.json` links to the retrieval context. Freshly read declarations also supply ID hints to ordinary validation, avoiding a second catalog search for a known result. Validation still reads live details and checks access, status, module identity, environment, deprecation, and circularity. Complete proofs require Proved theorem imports; Open results remain sketch obligations. Disproofs retain their prohibition on `Theorems.*` imports. Retrieved declarations do not create graph edges or change theorem statuses.

Newly read declarations are indexed under `.runs/theorem-library/<mathlib-revision>/`. These shared records are hints only and must be fetched live before they are supplied to a different attempt.

Restart the runner to enable this for subsequent invocations. The implementation does not restart an active mission automatically. Existing issued submissions retain their normal recovery behavior.

Validation covers the real stdio JSON-RPC handshake and calls, pinned CLI configuration parsing without a model request, an agent-process fixture that consumes a live lookup and produces a proof, ordinary validation and pre-submission dependency freshness, revision/status/access boundaries, definition filtering, persisted concurrent budgets, and cancellation. It does not establish a production proof-success improvement. Compare accepted complete proofs, redundant child creation, attempt time, and model usage, using the lookup journals and selected imports to interpret results.

Run the focused coverage with `node --test test/theorem-library.test.mjs`, or the full offline suite with `npm test`. Optional compiler integrations require their configured executables. Windows process-lifecycle tests need permission to terminate their own child processes; environment restrictions can prevent those checks from completing.
