# Third-party components and references

This inventory describes the runner's dependencies and external sources. Their
licenses and terms apply separately from the license of this repository.

## Installed dependency

- **OpenAI Codex CLI** (`@openai/codex`, pinned in `package-lock.json`):
  [source](https://github.com/openai/codex),
  [Apache License 2.0](https://github.com/openai/codex/blob/main/LICENSE).
  npm installs the CLI and its platform-specific executable under `node_modules/`,
  which is ignored by Git. This repository invokes the CLI rather than vendoring
  its source. If you redistribute the CLI or its executables with the runner,
  preserve the applicable upstream license, copyright, and third-party notices.

## External tools and downloaded material

- **prove2.me workspace and API documentation**:
  [upstream workspace](https://github.com/prove2me/prove2me_workspace).
  The runner clones the workspace during preparation; the README links to its
  API documentation. Consult the upstream repository for its terms. A reference
  or runtime download does not place that material under this project's license.
- **Lean, Lake, and elan**:
  [Lean](https://github.com/leanprover/lean4) and
  [elan](https://github.com/leanprover/elan) are separately installed tools for
  local verification. Their upstream licenses and notices apply to those tools.
- **Mathlib**:
  [source](https://github.com/leanprover-community/mathlib4),
  [license](https://github.com/leanprover-community/mathlib4/blob/master/LICENSE).
  The runner downloads the mission's pinned sources and, in local verification
  mode, dependencies and compiled caches. These are runtime workspace material,
  not source bundled in this repository.
- **Theorem statements, definitions, proofs, and research references** obtained
  from prove2.me or other sources remain subject to their own applicable terms.
  Saving, generating, or submitting an artifact does not by itself place it
  under the runner's license.

Runtime downloads and artifacts live in ignored directories such as
`.workspaces/`, `.cache/`, and `.runs/`. If you distribute those directories,
review their contents and preserve the corresponding upstream notices.

## Dashboard assets and names

The tracked dashboard contains HTML, CSS, JavaScript, inline SVG paths, and
Unicode symbols. It ships no separate image or font files and loads no external
icon library or web font. The CSS font stack uses locally available fonts.

The names prove2.me, OpenAI, and Codex identify the services and tools the runner
works with. This project's license does not grant rights to third-party names,
logos, or trademarks.

When adding third-party code, artwork, fonts, or documentation, retain the
required attribution and license notices and update this inventory.
