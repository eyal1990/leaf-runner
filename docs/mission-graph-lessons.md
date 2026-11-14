# Working with theorem dependency graphs

The runner selects work from theorem dependencies and accepted reductions. A
larger graph or an accepted sketch does not establish progress toward the root.
An independently grounded proof route is the useful objective.

## Source and definition compatibility

When an upstream proof is available, locate its actual solution entry point and
dependency closure. Preserve exact hypotheses and canonical definitions. Check
the platform's Lean and Mathlib pins before attempting a port. Finding source
code does not establish that it compiles or is accepted by the platform.

Definition bundles must also coexist: a matching theorem name or graph edge does
not prove that two bundles avoid conflicting declarations. Proposed intermediate
statements must preserve positivity assumptions, combinatorial factors, and
cancellation required by the original argument.

## Cycles and invalidated reductions

A visited set terminates traversal; it does not supply a proof foundation. A
cyclic component needs an independently proved member or an independent usable
alternative. An AND sibling outside the cycle does not ground the cycle; an OR
alternative can.

`graph-cycles.mjs` and `work-policy.mjs` identify components and schedule
`reconsider_reduction` tasks. Only one component repair is admitted while another
repair of that component is active or pending. Shared prompts require an
independent proof route and a stated difficulty reduction for proposed children.

A disproved child invalidates the reduction that needs it, rather than refuting
its parent. A certificate concerns its exact quantified statement and hypotheses;
do not transfer a counterexample to a different statement by name similarity.

## Read-only inspection

`scripts/inspect-mission-graph.mjs` expands completed and disproved nodes as well
as open nodes, counts blocked reductions, detects cycles, and reports inconsistent
status observations. It captures live API observations over a traversal interval;
the API does not supply an atomic graph snapshot.

```powershell
node scripts/inspect-mission-graph.mjs --root ROOT_THEOREM_ID
node scripts/inspect-mission-graph.mjs --snapshot PATH_TO_SNAPSHOT
```

Online mode uses existing credentials for API reads and saves a diagnostic
snapshot. It does not change claims, runner checkpoints, submissions, or
publication journals. Large graphs can require many requests. Offline mode
performs no network requests or writes.

Keep captures, downloaded certificates, and investigation notes in the ignored
`.runs/` or `.cache/` directories. They can contain private mission information.
Use [periodic mission research](mission-research.md) for root-specific advisory
notes rather than adding mission-specific instructions to shared prompts.
