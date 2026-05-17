# OpenCode Instructions

This directory only defines OpenCode-specific behavior for this repository.
Keep rules here limited to local OpenCode configuration, LSP usage, formatter wiring, and instruction loading.

Project-wide engineering, testing, and feature rules live in the root `AGENTS.md` and must not be duplicated here.

Current local OpenCode setup from `opencode.json`:

- `tsgo` is the semantic LSP for TypeScript and JavaScript files.
- `biome` provides diagnostics and fixes for code, JSON, CSS, and HTML.
- `dprint` handles Markdown, TOML, and YAML formatting.

Load the files under `.opencode/rules/` for the repo-specific OpenCode workflow.
