# CLAUDE.md

Claude Code-specific guidance for this repository.
`AGENTS.md` (at the repo root) is the canonical source of truth for structure,
task routing, and global rules. This file only documents what is specific to
Claude Code.

Detailed rules live in `.claude/rules/`:

- `01-commands-and-validation.md` — bun-only commands, validation loop
- `02-local-plugins.md` — LSP plugin table, hooks, troubleshooting
- `03-code-navigation.md` — tool priority, decision table, required workflows

## Trust AGENTS.md

`AGENTS.md` is the source of truth for the repo map, task routing, naming
shortcuts, and global rules. Read it before anything else.

@../AGENTS.md
