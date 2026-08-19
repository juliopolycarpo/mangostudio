# Contributing to MangoStudio

Thank you for your interest in contributing to MangoStudio!

## Code of Conduct

This project follows the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md). By participating, you are expected to uphold this code. Please report unacceptable behavior to `julio@polycarpo.dev`.

## Prerequisites

- [Bun](https://bun.sh/) canary — `bun upgrade --canary`, or
  `curl -fsSL https://bun.sh/install | bash -s -- canary` for a first install
- Git with GPG signing configured (see [Commit Guidelines](#commit-guidelines))

Bun 1.4.0 is unreleased, and canary is the only channel carrying the post-rewrite runtime this repo builds and tests against. `.bun-version` is what CI installs; [`docs/reference/tooling.md`](../docs/reference/tooling.md#bun) explains why `packageManager` names a different string.

## Environment Setup

```bash
# Clone the repository
git clone <repo-url>
cd mangostudio

# Install all workspace dependencies
bun install

# Copy and configure
mkdir -p ~/.mango
cp .mango/config.toml.example ~/.mango/config.toml
cp .mango/.env.example ~/.mango/.env
# Edit ~/.mango/.env and add your API keys
```

## Development Workflow

```bash
# Start all dev servers (API on :3001, frontend on :5173)
bun run dev

# Or start each workspace individually
bun run dev --api
bun run dev --frontend
```

## Documentation Map

- [`docs/README.md`](../docs/README.md) — entry point to the documentation tree
- [`docs/guides/contributor-quickstart.md`](../docs/guides/contributor-quickstart.md) — shortest contributor onboarding path
- [`docs/reference/testing.md`](../docs/reference/testing.md) — testing taxonomy, runners, and support rules
- [`docs/reference/agent-playbooks.md`](../docs/reference/agent-playbooks.md) — feature-by-feature file map for targeted work

## Code Standards

Refer to [`AGENTS.md`](../AGENTS.md) for the full coding style, naming conventions, i18n rules, and testing guidelines. Key points:

- TypeScript throughout — no plain JS files
- 2-space indentation, single quotes, semicolons
- All UI strings must come from `@mangostudio/shared/i18n` — never hardcode user-visible text
- Hooks that contain JSX must use `.tsx` extension
- `CLAUDE.md` files with `@imports`
- AI related Agents: Use [`AGENTS.md`](../AGENTS.md) as a source of agentic stuff
- Cursor-only extras (including Cursor Cloud VM notes) live in
  [`.cursor/rules/`](../.cursor/rules/). Do not duplicate `AGENTS.md` there; Cursor loads it
  automatically.

### Module Architecture

The API follows a modular DDD-inspired pattern where each domain concern
(chats, messages, generation, connectors, settings, etc.) is organized as:

```
application/   → Use-case services (orchestration logic)
domain/        → Domain rules and entities (may be omitted for simple modules)
http/          → Elysia route definitions
infrastructure/ → Repository/persistence implementations
```

When adding a new feature, prefer creating a new module under
`apps/api/src/modules/` rather than expanding files in a flat structure.

## Running Tests

```bash
# Code quality
bun run check

# All suites
bun run test

# Unit only
bun run test --unit

# Integration only
bun run test --integration

# End-to-end setup, then test
bun run test:e2e:setup
bun run test --e2e
```

## Checking and Type Checking

```bash
bun run check
```

This runs Biome, dprint, circular dependency checks, and TypeScript type-checking across all workspaces.

## Building

```bash
bun run build
```

This builds the frontend with Vite by default. Use `bun run build --binary` for standalone binaries.

## Commit Guidelines

This project uses [Conventional Commits](https://www.conventionalcommits.org/). Every commit must be GPG-signed and include a sign-off:

```bash
git commit -S -s -m "feat(scope): short imperative summary"
```

Common types: `feat`, `fix`, `chore`, `test`, `docs`, `refactor`, `ci`.

Keep each commit scoped to one concern. Prefer multiple small commits over one large commit.

**All commit messages must be written in English.**

## Commit Message Template

Configure Git to pre-fill the commit editor with the project template:

```bash
git config commit.template .gitmessage
```

This is a one-time local setup. The template is at `.gitmessage` in the repo root.

## Changelog

`CHANGELOG.md` is generated from Conventional Commits with git-cliff — never edit
it by hand. The PR QA workflow posts bot comments on every PR — a commit
summary, a **Changelog Preview** showing the entries the PR would add, and a QA
metrics report. Preview the changelog locally with `bun run changelog --preview`. See
[`docs/reference/releasing.md`](../docs/reference/releasing.md) for the release flow.

## Pull Request Process

1. Create a branch from `main` using a descriptive name (e.g., `feat/add-gallery-empty-state`).
2. Run the full validation suite locally before pushing:
   ```bash
   bun run check && bun run test
   # or use the full CI gate shortcut:
   bun run verify
   ```
3. Open a PR against `main` and fill out the PR template.
4. PRs require all CI checks to pass before merging.
5. Screenshots or GIFs are required for UI changes.

### Security Automation

Every PR also runs the repository security gates:

- **CodeQL** (`.github/workflows/codeql.yml`) uses GitHub code scanning advanced setup for JavaScript/TypeScript, no-build extraction, and the `security-extended` query suite. Review both the `CodeQL / Analyze (javascript-typescript)` workflow check and the follow-up `Code scanning results / CodeQL` check. New high, critical, or error-level alerts must be fixed or intentionally triaged before merge.
- **Dependency Review** (`.github/workflows/dependency-review.yml`) runs when manifests or lockfiles change and fails on new moderate-or-worse vulnerable dependencies. It does not enforce license policy.
- The first PR that adds or changes code scanning may get a generic `github-advanced-security[bot]` setup comment. Treat that as an enablement notice; the actionable status is in the checks above and the repository Security tab.

## Database Migrations

```bash
bun run --filter @mangostudio/api migrate
```

If your change requires a schema migration, add the migration file under `apps/api/src/db/migrations/` and run the command above locally to verify it applies cleanly.

## Security

Never commit populated `.env` files or API keys. The `GEMINI_API_KEY` is only accessed server-side and must not be exposed to the frontend bundle.

If you discover a security vulnerability, please report it privately rather than opening a public issue.
