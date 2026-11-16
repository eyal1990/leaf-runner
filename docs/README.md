# Documentation

Start with the [project README](../README.md) for installation, authentication,
and a first run in Mission Control. The guides below explain behavior and design
that are useful when operating or contributing to the runner.

| Guide | Purpose |
| --- | --- |
| [Mission Control user guide](mission-control.md) | Every UI action, screen, filter, setting, and inspector control |
| [Configuration](configuration.md) | Project defaults versus the optional example, file settings, and overrides |
| [Verification modes](verification-modes.md) | Separate server-only/local prerequisites and validation behavior |
| [Scheduling and architecture](scheduler.md) | Frontier selection, four stages, graph updates, and code map |
| [Recovery and diagnostics](operations.md) | Stop/resume, locks, automatic recovery, artifacts, and operator scripts |
| [Verification](verification.md) | Offline, real Lean, and browser checks, CI coverage, and limits |
| [Throughput tuning](throughput-tuning.md) | Capacity settings, bottlenecks, and measurement limits |
| [Incremental graph updates](incremental-graph-updates.md) | Confirmed outcomes, reconciliation, persistence, and races |
| [Theorem dependency graphs](mission-graph-lessons.md) | Source compatibility, cycles, invalidated reductions, and read-only inspection |
| [Periodic mission research](mission-research.md) | Advisory reviews, resource downloads, isolation, and recovery |
| [Theorem-library discovery](theorem-library.md) | Read-only search tools, evidence, budgets, and validation boundaries |
| [Mission Control design](mission-control-ux.md) | Dashboard semantics, implementation boundaries, and deferred capabilities |
| [Claude support plan](claude-support-plan.md) | Proposed provider integration, affected files, migration, and validation |

## Contributing documentation

Document reproducible behavior, configuration, architecture, and known
limitations. Use generic mission names and placeholder IDs in examples.
Describe test coverage and how to run it rather than copying dated test logs.

Keep credentials, account-specific usage reports, raw transcripts, correspondence,
mission captures, and investigation notes out of tracked documentation. Use the
ignored `.cache/` or `.runs/` directories for local material. Review screenshots
and other binary assets as well as text before adding them.

Ignoring a file does not remove a tracked copy or earlier commits. Before making
a repository public, review its history and release artifacts as well as the
current files.
