# Shared Workspace Guidance

Read `../../AGENTS.md` first. This file adds shared-workspace guidance only.

## Fast Context

- Shared API contracts live in `src/contracts/index.ts` (DTOs, request/response shapes).
- Shared error contracts live in `src/contracts/errors.ts` (`SSEErrorEvent` for streaming errors).
- Shared domain types live in `src/types/index.ts` (`Chat`, `Message`, `MessagePart`, `AgentEvent`, `ProviderType`, etc).
- Shared utility functions (e.g. model detection) live in `src/utils/model-detection.ts`.
- Shared i18n dictionaries:
  - `src/i18n/pt-BR.ts` — source of truth for message keys. New keys go here first.
  - `src/i18n/en.ts` — must satisfy the `Messages` type so missing keys fail at compile time.
  - `src/i18n/types.ts` — the `Messages` type, derived from `pt-BR.ts`. Also exports the `Locale` type.
  - `src/i18n/index.ts` — re-exports dictionaries, types, and `defaultLocale`.
- Shared runtime test helpers live in `src/test-utils/`.

## Shared Invariants

- Keep this workspace framework-agnostic. Do not import frontend-only or API-only runtime code here.
- Treat `src/contracts/` as the shared API surface between frontend and API. Contract changes must be reflected in both consumers in the same task.
- `apps/shared/src/i18n/pt-BR.ts` is the source of truth for message keys.
- `apps/shared/src/i18n/en.ts` must stay in sync with the `Messages` type so missing keys fail fast at compile time.
- Prefer descriptive type names and avoid leaking provider-specific details into generic shared types unless the product model truly requires them.

## i18n Key Workflow

When adding a new user-visible string:

1. Add the key to `src/i18n/pt-BR.ts` (source of truth — the `Messages` type is derived from it).
2. Add the same key to `src/i18n/en.ts` (must satisfy the `Messages` type, so missing keys are a compile error).
3. Use the key in the frontend component via `const { t } = useI18n()`.

## Change Impact Map

### Contract Changes

Open these first:

- `src/contracts/index.ts`
- `src/contracts/errors.ts`
- the owning API route under `apps/api/src/routes/`
- the owning frontend hook, service, or component under `apps/frontend/src/`
- relevant API and frontend tests

### i18n Changes

Open these first:

- `src/i18n/pt-BR.ts`
- `src/i18n/en.ts`
- `src/i18n/types.ts`
- `apps/frontend/src/hooks/use-i18n.tsx`
- the frontend components that consume the changed keys

### Shared Type Changes

Open these first:

- `src/types/index.ts`
- the API service or route that produces the shape
- the frontend hook or component that consumes the shape

### Shared Utility Changes

Open these first:

- `src/utils/model-detection.ts`
- the API providers that call the utility (`apps/api/src/services/providers/*`)
- the frontend utilities that re-export or wrap the utility

## Validation

- Shared changes: `bun run --filter @mangostudio/shared test:unit`
- If the change affects contracts or i18n, also run the affected API or frontend tests.
