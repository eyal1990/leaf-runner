# Verification modes

Both modes generate candidates with Codex and submit them to Prove2.me. The
server verdict remains authoritative. The difference is where Lean compilation
and exact-type checks run before submission.

| Requirement or behavior | Server-only (project default) | Local |
| --- | --- | --- |
| Node.js 22+, npm, Git, internet, Prove2.me key, Codex login | Required | Required |
| Browser | For Mission Control | For Mission Control |
| elan / Lean / Lake on PATH | Not required | Required; verify `lake --version` before starting |
| Pinned Mathlib sources | Downloaded through Git for research | Downloaded with dependencies and compiled cache |
| Client Lean/Lake commands | Zero, including setup and readiness | Runner owns setup, readiness, candidate builds, and exact-type checks |
| Compilation diagnostics | Server feedback | Local diagnostics before upload, then server feedback |
| Prepare workers | Configurable; project setting is four | Serialized to one |
| Local capacity | `maxActiveJobs` local jobs; separate remote commitment limit | `maxActiveJobs` overall active jobs |
| Workspaces during remote waits | Released before Server stage; reconstructed for repair | Retained with the active job |

## Choose a mode

Keep the default for a first run. To use local verification, install elan and
ensure Lake is available to the launcher's shell. The runner selects the Lean
toolchain and Mathlib revision from the target's platform environment; you do
not need to preselect one global compiler version. Initial toolchain/cache
downloads, builds, and private workspace copies can take substantial time and
disk space.

Stop/save the mission. Open the configuration file whose path appears in **Run
settings**, change `"verificationMode": "server-only"` to
`"verificationMode": "local"`, and start again. This setting is currently
file-only. Saved jobs retain their claimed mode across restart; the new setting
applies to newly admitted jobs. Advanced CLI use supports
`--verification-mode local` or `--verification-mode server-only`.

## Checks retained in server-only mode

The sandbox shell/read/write readiness probe still runs without a model request.
Answer format, source safety, imports, dependency status, live target freshness,
and immutable artifact checks remain. Proposed dependencies are published and
checked live before the saved reduction is submitted. Proofs, sketches, and
counterexamples receive server verdicts and feed diagnostics into later selected
attempts. Server-only mode does not establish local compiler/type verification.

## Local validation and isolation

The runner prepares pinned dependencies and mirrored platform imports, probes
the Codex sandbox, builds the target imports, then validates candidate source
and exact goal type. It checks sketch independence and compilation before
publication, and rebuilds against live dependencies afterward. A counterexample
must prove the negation of the entire target and use allowed axioms; it cannot
import platform theorem modules. A compiling example alone is insufficient.

Proof/repair agents write mathematics and read runner-supplied diagnostics;
they do not launch compiler checks. All runner-owned builds share one permit.
Readiness and build timeouts default to one hour, independently of the model's
30-minute timeout. Readiness retries do not spend mathematical attempts.

Environment seeds and private job slots live under `.workspaces/`. Seeds are
keyed by environment and instruction/documentation versions. Each job receives
private source/configuration/build files; returned slots are reset and package
bytes verified before reuse. Unchanged dependency caches and timestamps remain
usable. Linked/invalid package trees are discarded. Cached slots can remain
after a lower capacity is configured. Compiled platform dependencies have
separate source/environment/host identities and verified hashes.

For regression coverage, see [verification](verification.md), especially
`test/server-only.test.mjs`, `test/serial-jobs.test.mjs`, and the optional real
Lean checks. Offline tests establish client behavior, not production server
performance or successful authentication.
