# Repository Guidelines

`AGENTS.md` is the single source of truth for repository-level agent instructions. Any agent-specific instruction file must reference this file instead of duplicating guidance.

## Project Structure & Module Organization

This is a Bun monorepo with `apps/*` workspaces:

- `apps/frontend/` — React + Vite UI. Components in `src/components/` (design system in `src/components/ui/`), features in `src/features/`, hooks in `src/hooks/`, routes in `src/routes/`, and tests in `tests/unit/`, `tests/integration/`, `tests/support/`.
- `apps/api/` — Elysia server with Kysely/SQLite persistence. Routes in `src/routes/`, services in `src/services/`, plugins in `src/plugins/`, database layer in `src/db/`, and tests in `tests/unit/`, `tests/integration/`, `tests/support/`.
- `apps/shared/` — Framework-agnostic shared types in `src/types/`, API contracts in `src/contracts/`, i18n dictionaries in `src/i18n/`, shared test helpers in `src/test-utils/`, and workspace tests in `tests/unit/`.

Runtime artifacts (`dist/`, `uploads/`, `*.sqlite`, `bun.lock`) are gitignored and should not be committed.

## Build, Test, and Development Commands

- `bun install`: install all workspace dependencies.
- `bun run dev`: start all dev servers concurrently.
- `bun run dev:api`: start API server on `http://localhost:3001`.
- `bun run dev:frontend`: start frontend dev server on `http://localhost:5173`.
- `bun run build`: build the frontend with Vite.
- `bun run lint`: run TypeScript type-checking + ESLint across all workspaces.
- `bun run test`: run all unit and integration suites from the monorepo root.
- `bun run test:unit`: run API, shared, and frontend unit suites.
- `bun run test:integration`: run API and frontend integration suites.
- `bun run test:coverage`: run frontend coverage with Vitest.
- `bun run migrate`: run database migrations in the API workspace.
- `bun run clean`: remove all `dist/` directories.

## Coding Style & Naming Conventions

Use TypeScript throughout and follow the existing style: 2-space indentation, single quotes, and semicolons. Use `PascalCase` for React components and exported types, `camelCase` for variables and functions, and `UPPER_SNAKE_CASE` for constants. Prefer descriptive names over abbreviations, keep functions focused, and add JSDoc to exported utilities or other public APIs. Use the `@/` alias for root-relative imports in the frontend workspace.

Any hook file that contains JSX (e.g., a Provider component) must use the `.tsx` extension. The OXC parser in Vite 8 rejects JSX in `.ts` files.

## i18n Conventions

All UI strings must come from `@mangostudio/shared/i18n`. Never hardcode user-visible strings in components.

- Source of truth: `apps/shared/src/i18n/pt-BR.ts` (uses `as const`)
- English fallback: `apps/shared/src/i18n/en.ts` (annotated `: Messages` — compile error if a key is missing)
- Frontend access: `const { t } = useI18n()` from `@/hooks/use-i18n`
- API error messages: import `ptBR` from `@mangostudio/shared/i18n`

## Testing Guidelines

The repository uses an automated workspace-first test suite under `apps/*/tests`. Before opening a PR, run `bun run lint`, `bun run test`, `bun run test:coverage`, `bun run build`, and smoke-test the main flows locally: login, chat creation, image generation.

**API integration tests** — always use `createApiTestApp(routePlugin)` from `tests/support/harness/create-api-test-app.ts`. Route plugins use `.group('/path', ...)` without the `/api` prefix (that prefix lives in `app.ts`). Test URLs must match the route's group path directly (e.g., `/settings/models/gemini`, not `/api/settings/models/gemini`). Validate response shapes with `Value.Check(Schema, payload)` from `@sinclair/typebox/value`.

**Frontend fetch mocks** — `create-fetch-scenario.ts` is for React hook tests in jsdom only (hooks that call `fetch` via Eden Treaty). For API contract tests, use `createApiTestApp` + `app.handle()` in the API workspace.

Place new tests in the appropriate workspace under `tests/unit/` or `tests/integration/`, and keep reusable support code in `tests/support/` only when it removes real duplication.

## Commit & Pull Request Guidelines

Use short imperative commit subjects such as `Add gallery empty state`. Keep each commit scoped to one concern. PRs should summarize the user-visible change, list verification steps, mention any new environment variables or schema changes, and include screenshots or GIFs for UI updates.

## Security & Configuration Tips

Copy `.env.example` to `.env.local` and set `GEMINI_API_KEY`; never commit populated env files. The API key is only accessed server-side. Validate uploaded files and request payloads, and log errors with enough context for debugging instead of swallowing them silently.
