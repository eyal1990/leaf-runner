# Verification

CI keeps the Windows/Linux, Node 22/24 offline test matrix and adds separate Lean and Chromium jobs.

## Lean integration

CI installs Lean and Lake from the release pinned in [`.github/lean-toolchain`](../.github/lean-toolchain), currently
`leanprover/lean4:v4.33.1`, matching the compiler fixtures. It does not need Mathlib downloads or platform credentials.
Set `LEAN_TEST_BINARY` to the absolute **toolchain executable**, rather than an elan proxy, then run:

```powershell
$env:LEAN_TEST_BINARY = "$env:USERPROFILE/.elan/toolchains/leanprover--lean4---v4.33.1/bin/lean.exe"
npm run test:lean
```

```sh
LEAN_TEST_BINARY="$HOME/.elan/toolchains/leanprover--lean4---v4.33.1/bin/lean" npm run test:lean
```

This command requires six passing, unskipped checks: exact goal type; full-target negation and certificate safety;
reduction independence; sketch compilation before publication; reused-workspace package builds; and compiled-dependency
cache transfer/invalidation. Missing or invalid compiler paths fail the command. Update the CI pin and fixture
toolchain strings together when upgrading Lean. The offline `npm test` still skips these checks unless configured.

## Real browser smoke tests

```sh
npm ci
npx playwright install chromium
npm run test:browser
```

On Linux CI, use `npx playwright install --with-deps chromium` to install system dependencies too.
Playwright is pinned in `package-lock.json`, which also selects its Chromium build.
Tests start the real HTTP server on an ephemeral loopback port, serve the production HTML/CSS/JavaScript, and run
at desktop (1440 × 1000) and phone (390 × 844) sizes. They check unauthorized and invalid-session rejection,
session-cookie login/reload, mission setup, model-picker interaction, settings persistence, and stop/save with a real IPC child
that writes a checkpoint. Layout assertions check horizontal overflow and control visibility/actionability.
Each run uses a temporary registry and configuration; live platform APIs, models, and account sampling are excluded.
The runner child is a deterministic fixture, so this establishes browser behavior and supervisor communication,
not successful production proof execution or an end-to-end Codex sign-in.

Failure screenshots/traces and the HTML report are saved in ignored `test-results/` and `playwright-report/`
directories. CI uploads these diagnostics on failure for seven days. To inspect a local report, run
`npx playwright show-report`.

## Secrets and reporting

The [secret-scanning workflow](../.github/workflows/secrets.yml) installs checksum-verified Gitleaks 8.30.1 and scans
the entire fetched history with redacted output. Run the same check locally with `gitleaks git --redact --log-opts="--all" .`.
Run it before making the repository public; ignored files can still exist in historical commits.
`.env` and `.env.*` are ignored except for sanitized `.env.example` files. The runner does not automatically load
environment files; the example documents the supported shell variable.
See [the security policy](../SECURITY.md) for private reporting and the GitHub setting to enable at public launch.
