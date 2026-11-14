# Security policy

Security fixes target the current `main` branch. Older revisions are not maintained separately.

## Report a vulnerability privately

Use [GitHub private vulnerability reporting](https://github.com/eyal1990/leaf-runner/security/advisories/new).
Please do not disclose vulnerabilities, credentials, or private mission data in public issues or pull requests.

Include the affected commit, reproduction steps, expected and observed behavior, impact, and a minimal sanitized example.
Remove API keys, session URLs, account identifiers, and private theorem or mission data from logs and screenshots.
Coordinate disclosure with the maintainer through the private report.

## Maintainer launch setup

GitHub private vulnerability reporting is a repository setting, not something this file enables.
When changing this repository to public, enable **Settings → Advanced Security → Private vulnerability reporting**,
then verify that **Security → Advisories → Report a vulnerability** opens the private report form.
Do this as part of the public launch before inviting users to report issues.
See [GitHub's setup instructions](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/configure-for-a-repository).

The secret-scanning workflow runs Gitleaks against the fetched Git history on pushes, pull requests, weekly, and manually.
Require a clean full-history scan before publication. If a real credential is found, revoke or rotate it first and
remove it from published history; adding it to `.gitignore` does not remove earlier commits.
Enable GitHub secret scanning and push protection in repository settings when available.
