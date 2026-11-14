# README screenshot

`mission-control.png` renders the production dashboard with synthetic mission,
theorem, and worker data. It reads no platform credentials, invokes no model,
and disables account sampling. It is an illustration of the UI, not evidence of
a completed proof run.

To refresh it after UI changes, install the locked dependencies and Playwright's
Chromium, then run from the repository root:

```sh
npm ci
npx playwright install chromium
node scripts/capture-readme-screenshot.mjs
```

The script starts an ephemeral loopback server with temporary state, renders
the real HTML/CSS/JavaScript, checks for browser errors, captures the dashboard,
and closes/removes its temporary resources. Inspect the PNG before committing.
