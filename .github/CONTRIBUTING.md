# Contributing to MangoStudio

Thank you for your interest in contributing to MangoStudio!

## Code of Conduct

This project follows the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md). By participating, you are expected to uphold this code. Please report unacceptable behavior to `julio@polycarpo.dev`.

## Prerequisites

- [Bun](https://bun.sh/) at the exact version in [`.bun-version`](../.bun-version) —
  select the matching [official release](https://github.com/oven-sh/bun/releases)
- Rust 1.99.0 or newer via [rustup](https://rustup.rs/) — `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`. The hub launches
  Local as the cargo-built `mangostudio-runtime`; `bun run dev` builds it first, and
  `rust-toolchain.toml` pins the version
- Git with commit signing configured (see [Commit Guidelines](#commit-guidelines))

The repo pins Bun 1.4.4. The pin moved to the 1.4.x line at 1.4.0, the release that made the post-rewrite runtime generally available; it tracked the `canary` channel until then. `.bun-version` is what CI installs, and `packageManager` must name the same version — see [`docs/reference/tooling.md`](../docs/reference/tooling.md#bun).

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
# Start the dev server (API and frontend together on :3001)
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

This includes Biome, dprint, circular dependency checks, and TypeScript type-checking across all workspaces. See `bun run check --help` and [`scripts/check.ts`](../scripts/check.ts) for the complete command contract, including code-health, generated-contract, lockfile and protocol checks.

## Building

```bash
bun run build
```

This builds the frontend with `Bun.build()` (`apps/frontend/build.ts`) by default. Use `bun run build --binary` for standalone binaries.

## Commit Guidelines

This project uses [Conventional Commits](https://www.conventionalcommits.org/). Every commit must be signed through Git's configured signing backend (including SSH or GPG) and include a sign-off:

```bash
git commit -S -s -m "feat(scope): short imperative summary"
```

Configure the signing key and backend in Git before committing. `-S` uses that configuration; `-s` adds the DCO sign-off from your Git identity. Let Git generate the trailer.

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
it by hand. The PR QA workflow posts two bot comments on every PR — a QA
metrics report, and a commit summary with a **Changelog Preview** showing the
entries the PR would add (each list folds once it has more than five items).
Preview the changelog locally with `bun run changelog --preview`. See
[`docs/reference/releasing.md`](../docs/reference/releasing.md) for the release flow.

## Pull Request Process

1. Create a branch from `main` using a descriptive name (e.g., `feat/add-gallery-empty-state`).
2. Run the full validation suite locally before pushing:
   ```bash
   bun run check && bun run test
   # Local check, coverage and build sequence:
   bun run verify
   ```
   `verify` runs `check → test --coverage → build --all` and stops on the first failure. Its coverage phase omits protocol TypeScript tests; add `bun run protocol:test --ts-only`. Rust, full protocol validation and hosted smoke remain separate; follow the [validation checklist](../docs/reference/testing.md#verification-checklist) for the affected area.
3. Open a PR against `main` and fill out the PR template.
4. PRs require all CI checks to pass before merging.
5. Screenshots or GIFs are required for UI changes.

### Security Automation

Every PR also runs the repository security gates:

- **CodeQL** (`.github/workflows/codeql.yml`) uses GitHub code scanning advanced setup for JavaScript/TypeScript and Rust, no-build extraction, and the `security-extended` query suite. Review the `CodeQL / Analyze (javascript-typescript)`, `CodeQL / Analyze (rust)`, and `CodeQL / Analyze (rust, windows)` workflow checks and the follow-up `Code scanning results / CodeQL` check. New high, critical, or error-level alerts must be fixed or intentionally triaged before merge.
- **Dependency Review** (`.github/workflows/dependency-review.yml`) runs when manifests or lockfiles change and fails on new moderate-or-worse vulnerable dependencies. It does not enforce license policy.
- **Dependency Audit** (`.github/workflows/dependency-audit.yml`) runs `bun audit --audit-level=moderate` over the whole `bun.lock` daily and once through CI on every PR, including documentation-only changes. Both CI aggregates (`Gate` and `CI Gate`) require the audit to succeed; failure, cancellation or a skipped audit fails the aggregate. New advisories against unchanged dependencies can therefore block unrelated PRs. Fix findings in a dependency PR with `bun audit fix`. The scan reads the lockfile without installing dependencies, uses read-only permissions and receives no secrets, including for forks. Cargo advisory auditing reuses the existing RustSec policy in `deny.toml` through `cargo deny check advisories`; Protocol CI retains bans, licenses and sources checks without repeating advisories.
- `bun run check` includes `bun dedupe --check`: a lockfile that holds two versions of a package one version satisfies fails. Run `bun dedupe` and commit the lockfile.
- The first PR that adds or changes code scanning may get a generic `github-advanced-security[bot]` setup comment. Treat that as an enablement notice; the actionable status is in the checks above and the repository Security tab.

## Database Migrations

```bash
bun run --filter @mangostudio/api migrate
```

If your change requires a schema migration, add the migration file under `apps/api/src/db/migrations/` and run the command above locally to verify it applies cleanly.

## Security

Never commit populated `.env` files or API keys. The `GEMINI_API_KEY` is only accessed server-side and must not be exposed to the frontend bundle.

If you discover a security vulnerability, please report it privately rather than opening a public issue.
