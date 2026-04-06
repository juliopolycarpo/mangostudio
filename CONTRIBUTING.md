# Contributing to MangoStudio

Thank you for your interest in contributing to MangoStudio!

## Prerequisites

- [Bun](https://bun.sh/) v1.3.11 or later
- Git with GPG signing configured (see [Commit Guidelines](#commit-guidelines))

## Environment Setup

```bash
# Clone the repository
git clone <repo-url>
cd mangostudio

# Install all workspace dependencies
bun install

# Copy and configure
cp .mango/config.toml.example .mango/config.toml
cp .mango/.env.example .mango/.env
# Edit .mango/.env and add your API keys
```

## Development Workflow

```bash
# Start all dev servers (API on :3001, frontend on :5173)
bun run dev

# Or start each workspace individually
bun run dev:api
bun run dev:frontend
```

## Code Standards

Refer to [`AGENTS.md`](./AGENTS.md) for the full coding style, naming conventions, i18n rules, and testing guidelines. Key points:

- TypeScript throughout — no plain JS files
- 2-space indentation, single quotes, semicolons
- All UI strings must come from `@mangostudio/shared/i18n` — never hardcode user-visible text
- Hooks that contain JSX must use `.tsx` extension
- `CLAUDE.md` and `GEMINI.md` files with `@imports`
- AI related Agents: Use [`AGENTS.md`](./AGENTS.md) as a source of agentic stuff

## Running Tests

```bash
# Code quality
bun run format:check
bun run lint
bun run typecheck

# All suites
bun run test

# Unit only
bun run test:unit

# Integration only
bun run test:integration

# Frontend coverage
bun run test:coverage

# Full validation pipeline
bun run verify
```

## Linting and Type Checking

```bash
bun run check
```

This runs formatting checks, ESLint, TypeScript type-checking, and tests across all workspaces.

## Building

```bash
bun run build
```

This builds the frontend with Vite. Verify there are no TypeScript errors before opening a PR.

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

## Pull Request Process

1. Create a branch from `main` using a descriptive name (e.g., `feat/add-gallery-empty-state`).
2. Run the full validation suite locally before pushing:
   ```bash
   bun run verify
   ```
3. Open a PR against `main` and fill out the PR template.
4. PRs require all CI checks to pass before merging.
5. Screenshots or GIFs are required for UI changes.

## Database Migrations

```bash
bun run migrate
```

If your change requires a schema migration, add the migration file under `apps/api/src/db/migrations/` and run the command above locally to verify it applies cleanly.

## Security

Never commit populated `.env` files or API keys. The `GEMINI_API_KEY` is only accessed server-side and must not be exposed to the frontend bundle.

If you discover a security vulnerability, please report it privately rather than opening a public issue.
