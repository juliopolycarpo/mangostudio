# Repository Guidelines

`AGENTS.md` is the canonical root instruction file for this repository.
Workspace-level `AGENTS.md` files must stay short and contain only workspace-specific deltas.

## Command Guidelines

1 - **Always assume/use**: `bun` or `bunx`
2 - **Never use**: `npm`, `npx`, `pnpm` or `yarn`

## Repo Map

- `apps/frontend/` — React 19 + Vite 8 UI with TanStack Router, TanStack Query, Better Auth client integration, and the local UI system.
- `apps/api/` — Elysia API with Better Auth, Kysely + SQLite persistence, connector management, and provider integrations.
- `apps/api/src/modules/` — Domain modules organized as `application/domain/http/infrastructure` layers (DDD-inspired).
- `apps/shared/` — shared contracts, domain types, i18n dictionaries, and framework-agnostic helpers.
- `tests/browser-smoke/` — Playwright smoke coverage for the auth flow.
- `.mango/` — example config, env overrides, local runtime artifacts, and standalone build output.

## Working Loop

1. Read this file, then only the relevant workspace `AGENTS.md`.
2. Start from the closest entrypoint to the task: route, component, hook, service, contract, or test.
3. Trace one layer outward at a time instead of scanning the whole repository.
4. Run the smallest relevant validation first, then expand only if the change is broad.
5. `docs/reference/agent-playbooks.md` is the file map: open the one section matching the task when you need entry points instead of a starting guess.

Useful docs:

- `README.md` — product and runtime overview
- `package.json` — root scripts
- `docs/reference/testing.md` — test taxonomy and harness rules
- `docs/reference/agent-playbooks.md` — detailed file maps by feature area
- `docs/reference/releasing.md` — changelog (`bun run changelog`) and release pipeline
- `scripts/README.md` — the Bun-native automation toolkit

## Global Rules

- Use Bun commands from the monorepo root.
- Keep changes scoped. Do not rewrite or reformat unrelated files.
- Never commit secrets, populated config files, databases, uploads, or build artifacts.
- Any frontend file that contains JSX must use the `.tsx` extension.
- All user-visible frontend strings must come from `@mangostudio/shared/i18n`.
- Public API shape changes must update the API code, shared contract, frontend consumer, and relevant tests in the same task.
- Shared contracts are schema-first: the TypeBox schema in `apps/shared/src/<module>/schemas.ts` is the single source of truth, and public types are derived with `Static<>`. Never hand-write a duplicate interface for a shape that already has a schema. `apps/shared/src/contracts/index.ts` is a compatibility barrel only — import from the bounded-context entrypoint (e.g. `@mangostudio/shared/agents`) in new code.
- API error responses must use `ApiErrorResponse` from `@mangostudio/shared/errors` or `SSEErrorEvent` from `@mangostudio/shared/streaming`.
- Add new environment parsing only in `apps/api/src/lib/config.ts`.
- Shared code must remain framework-agnostic.
- Cross-workspace imports must use package names, never relative paths.
- Do not edit `apps/frontend/src/routeTree.gen.ts`; it is generated.

## Naming Shortcuts

- Migration files: `NNN_description.ts`
- i18n keys: dot-separated by feature scope
- DB tables: `snake_case`; DB columns: `camelCase`
- Kysely aliases: `<Entity>Select`, `<Entity>Insert`, `<Entity>Update`

## Classification Labels

Every PR needs at least one `area:` or `type:` label — the "Verify classification labels" gate enforces it. Every issue needs exactly one `type:` label and a `status:` label.

`docs/reference/labels.md` has the full taxonomy and the glob-to-label map; `.github/labeler.yml` is what the gate actually reads.

## Validation

After **every** change, run `bun run check`. If it fails, run `bun run fix` and re-check.
Before final handoff, run `bun run check && bun run test` to validate all workspaces.
