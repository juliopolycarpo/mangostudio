# Shared Workspace Guidance

Read `../../AGENTS.md` first. This file only adds shared-workspace entrypoints, invariants, and tests.

## Start Here

- Contracts: `src/contracts/index.ts`, `src/contracts/errors.ts`
- Domain types: `src/types/index.ts`
- i18n: `src/i18n/pt-BR.ts`, `src/i18n/en.ts`, `src/i18n/types.ts`
- Utilities: `src/utils/model-detection.ts`
- Test helpers: `src/test-utils/`

## Diagnose By Task

- Contract change: `src/contracts/`, the owning API route, the matching frontend consumer, and the relevant tests
- i18n change: `src/i18n/pt-BR.ts`, `src/i18n/en.ts`, `apps/frontend/src/hooks/use-i18n.tsx`, and the affected frontend components
- Shared type change: `src/types/index.ts`, the API producer, and the frontend consumer
- Shared utility change: the target file under `src/utils/` and the affected API or frontend callers

## Shared Rules

- Keep this workspace framework-agnostic.
- Treat `src/contracts/` as the shared API surface between API and frontend.
- Contract changes must update both consumers in the same task.
- `src/i18n/pt-BR.ts` is the source of truth for message keys.
- `src/i18n/en.ts` must stay in sync with the inferred `Messages` type.
- Avoid leaking provider-specific details into generic shared types unless the product model truly requires them.

## Tests

- Shared-local changes: `bun run --filter @mangostudio/shared test:unit`
- If contracts or i18n change, also run the affected API or frontend tests.
