# Repository Guidelines

`AGENTS.md` is the canonical root instruction file for this repository.
Workspace-level `AGENTS.md` files must stay short and contain only workspace-specific deltas.

## Command Guidelines

1 - **Always assume/use**: `bun` or `bunx`
2 - **Never use**: `npm`, `npx`, `pnpm` or `yarn`

## Working Loop

1. Read this file, then only the relevant workspace `AGENTS.md`.
2. Start from the closest entrypoint to the task: route, component, hook, service, contract, or test.
3. Trace one layer outward at a time instead of scanning the whole repository.
4. Run the smallest relevant validation first, then expand only if the change is broad.
5. `docs/reference/agent-playbooks.md` is the file map: open the one section matching the task when you need entry points instead of a starting guess.

Useful docs:

- `docs/architecture/overview.md` — workspace map and API module layering
- `docs/architecture/hub-runtime.md` — hub/runtime ownership and protocol boundary
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
- Add hub environment parsing only in `apps/api/src/lib/config.ts`, and runtime-host
  environment parsing only in `apps/runtime/src/config.ts`.
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

## Cursor Cloud specific instructions

Environment facts and non-obvious gotchas for agents running in the Cursor Cloud VM
(dependencies are already installed by the startup update script; standard commands
live in `README.md` and root `package.json`).

- **Runtime:** `bun` is the package manager/runtime (see the "Command Guidelines" above).
  Node is also present on `PATH` at `/exec-daemon/node`, which matters for the dev gotcha below.
- **Required secret:** the API refuses to boot without `BETTER_AUTH_SECRET` (min 32 chars).
  In this VM it lives in `~/.mango/.env`; regenerate with
  `printf 'BETTER_AUTH_SECRET=%s\n' "$(openssl rand -hex 32)" > ~/.mango/.env` if missing.
- **Running dev servers — important gotcha:** the plain `bun run dev` from `README.md`
  fails here. Vite's `bin` has a Node shebang, so with `/exec-daemon/node` on `PATH` it runs
  under Node, which cannot load `@mangostudio/shared`'s raw `.ts` config exports
  (`ERR_UNKNOWN_FILE_EXTENSION`). Do NOT "fix" this by forcing Bun (`bun --bun`): Bun's HTTP
  proxy lacks `socket.destroySoon`, which crashes Vite's `/api` dev proxy on the first request.
  The working command keeps Vite on Node but enables TS stripping:
  `CI=1 NODE_OPTIONS="--experimental-strip-types" bun run dev`
  (`CI=1` switches Turbo to stream UI, which logs cleanly for non-interactive runs). To run a
  single service: API `cd apps/api && bun run dev` (Bun, port 3001);
  frontend `cd apps/frontend && NODE_OPTIONS="--experimental-strip-types" bun run dev` (port 5173,
  proxies `/api`, `/uploads`, `/images`, `/api/ws` to the API).
- **Database:** SQLite at `~/.mango/database.sqlite`; migrations run automatically on API boot.
- **No AI providers by default:** without a connector the UI shows "No models available" and
  chat/image generation produces no reply — this is expected, not a bug. Signup/login, chat
  creation, and settings all work without keys. Add a provider key in Settings → Connectors
  (or `~/.mango/.env`, e.g. `GEMINI_API_KEY=...`) to exercise real generation.
- **`bun install` and git hooks:** the root `prepare` step (`lefthook install`) fails in the VM
  because Cursor sets a custom `core.hooksPath`; dependencies still install correctly. Use
  `bun install --ignore-scripts` (what the startup update script runs) to skip the failing hook.
