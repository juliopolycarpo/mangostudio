# API Workspace Guidance

Read `../../AGENTS.md` first. This file adds API-specific guidance only.

## Fast Context

- App composition lives in `src/app.ts`. The API namespace prefix is `/api`.
- Server startup and standalone runtime wiring live in `src/index.ts`.
- Better Auth setup lives in `src/auth.ts` and is mounted at `/api/auth`.
- Route plugins live in `src/routes/`. Settings sub-routes live in `src/routes/settings/` (connectors, models, gemini-aliases).
- Configuration and runtime-path resolution live in `src/lib/config.ts`.
- Persistence lives in `src/db/`:
  - `database.ts` — Kysely instance and dialect setup.
  - `types.ts` — Kysely `Database` interface, table types, and `Select`/`Insert`/`Update` aliases.
  - `row-types.ts` — raw row shapes before domain mapping.
  - `serializers.ts` — row-to-domain serialization helpers.
  - `migrate.ts` — migration runner invoked at startup.
  - `migrations/` — sequential migration files (see root `AGENTS.md` → Migration Authoring).
- Provider integrations and connector services live in `src/services/providers/`.
- Secret storage lives in `src/services/secret-store/`.
- Gemini-specific services live in `src/services/gemini/`.
- Tool calling and function-calling logic lives in `src/services/tools/`.
- Chat and message persistence services live in `src/services/chat-service.ts` and `src/services/message-service.ts`.
- Shared API utilities (ID generation, query helpers) live in `src/utils/`.
- Elysia plugins (auth middleware, rate limiting) live in `src/plugins/`.

## API Invariants

- Route plugins use their own `.group('/path', ...)` paths without the `/api` prefix. The prefix is added centrally in `src/app.ts`.
- Keep request and response schemas explicit with Elysia route definitions and shared contracts where applicable.
- Prefer Kysely builder in application code. Use `kysely/sql` in migrations only when SQLite behavior requires it.
- Reuse config, secret-store, and provider abstractions before adding new environment parsing or ad hoc credential logic.
- Keep auth, connector, and provider errors explicit and logged with enough context.

## Change Impact Map

### Route Or Endpoint Changes

Open these first:

- `src/app.ts`
- the target file under `src/routes/`
- `apps/shared/src/contracts/index.ts`
- the frontend consumer under `apps/frontend/src/`
- relevant API integration tests

### Auth Changes

Open these first:

- `src/auth.ts`
- `src/routes/auth.ts`
- `src/plugins/auth-middleware.ts`
- `apps/frontend/src/lib/auth-client.ts`
- `tests/browser-smoke/auth-flow.spec.ts`

### Chat, Messages, And Streaming

Open these first:

- `src/routes/chats.ts`
- `src/routes/messages.ts`
- `src/routes/respond.ts`
- `src/routes/respond-stream.ts`
- `src/routes/upload.ts`
- `src/services/chat-service.ts`
- `src/services/message-service.ts`
- `apps/shared/src/contracts/index.ts`
- `apps/frontend/src/hooks/use-text-chat.ts`
- `apps/frontend/src/hooks/use-image-generation.ts`

### Connectors, Providers, Or Secret Storage

Open these first:

- `src/routes/settings/connectors.ts`
- `src/routes/settings/models.ts`
- `src/routes/settings/gemini-aliases.ts`
- `src/services/providers/*`
- `src/services/secret-store/*`
- `src/services/gemini/*`
- `src/lib/config.ts`
- matching frontend settings UI

### Tool Calling And Agentic Flows

Open these first:

- `src/services/tools/*`
- `src/routes/respond-stream.ts`
- `apps/shared/src/types/index.ts` (for `AgentEvent`, `MessagePart`)

### Config, Runtime, Or Standalone Build Behavior

Open these first:

- `src/lib/config.ts`
- `src/index.ts`
- `scripts/build.ts`
- `.mango/config.toml.example`
- `.mango/.env.example`

## Testing Rules

- Unit tests live in `tests/unit/` and integration tests live in `tests/integration/`, mirroring the source tree structure.
- API integration tests must use `createApiTestApp(routePlugin)` from `tests/support/harness/create-api-test-app.ts`.
- Test URLs must match the plugin group path directly. Do not prepend `/api` in API integration tests.
- Validate response shapes with `Value.Check(Schema, payload)` from `@sinclair/typebox/value`.

## Validation

- Unit changes: `bun run --filter @mangostudio/api test:unit`
- Route or flow changes: `bun run --filter @mangostudio/api test:integration`
- Broad API changes: `bun run lint && bun run test`
