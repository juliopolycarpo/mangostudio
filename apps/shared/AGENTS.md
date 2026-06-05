# Shared Workspace Guidance

Read `../../AGENTS.md` first. This file only adds shared-workspace entrypoints, invariants, and tests.

## Start Here

- Contract schemas (canonical source of truth): `src/<module>/schemas.ts`
- Contracts barrel (compatibility re-exports only): `src/contracts/index.ts`
- Domain types: `src/types/index.ts`
- i18n: `src/i18n/pt-BR.ts`, `src/i18n/en.ts`, `src/i18n/types.ts`
- Utilities: `src/utils/model-detection.ts`
- Test helpers: `src/test-utils/`

## Diagnose By Task

- Contract change: `src/<module>/schemas.ts` (canonical), the owning API route, the matching frontend consumer, and the relevant tests
- i18n change: `src/i18n/pt-BR.ts`, `src/i18n/en.ts`, `apps/frontend/src/hooks/use-i18n.tsx`, and the affected frontend components
- Shared type change: `src/types/index.ts`, the API producer, and the frontend consumer
- Shared utility change: the target file under `src/utils/` and the affected API or frontend callers

## Shared Rules

- Keep this workspace framework-agnostic.
- Shared contracts are schema-first: define each shape once as a TypeBox schema in `src/<module>/schemas.ts` and derive its public type with `Static<>`. Never hand-write a duplicate interface; use `ReadonlyArraySchema` / `Type.Unsafe` (see `src/schema-helpers.ts`) when the derived type needs `ReadonlyArray` or template-literal precision.
- `src/contracts/index.ts` re-exports those types for backward compatibility only; new code should import from the bounded-context entrypoint (e.g. `@mangostudio/shared/agents`).
- `tests/unit/contract-schema-parity.test.ts` enforces that hand-written domain unions and the compatibility barrel stay in lockstep with the schemas — extend it when adding cross-cutting types.
- Contract changes must update both consumers in the same task.
- `src/i18n/pt-BR.ts` is the source of truth for message keys.
- `src/i18n/en.ts` must stay in sync with the inferred `Messages` type.
- Avoid leaking provider-specific details into generic shared types unless the product model truly requires them.

## Tests

- Shared-local changes: `bun run --filter @mangostudio/shared test:unit`
- If contracts or i18n change, also run the affected API or frontend tests.
