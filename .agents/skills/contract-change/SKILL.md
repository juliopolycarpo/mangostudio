---
name: contract-change
description: Schema-first workflow for changing a public API shape — adding or changing a field on an API request or response, editing a TypeBox schema or shared contract under apps/shared, adding or reshaping an Elysia route, or consuming a changed endpoint from the frontend. Ensures schema, API route, frontend consumer, and tests are updated together.
---

# Contract change

Public API shapes are schema-first: the TypeBox schema in
`apps/shared/src/<module>/schemas.ts` is the single source of truth, and every shape
change must land schema + API route + frontend consumer + tests in the same task.

## Procedure

1. **Schema first.** Locate or create the schema in
   `apps/shared/src/<module>/schemas.ts` and derive the public type next to it with
   `type X = Static<typeof XSchema>`. Never hand-write an interface that duplicates a
   schema. Shared TypeBox helpers (e.g. `ReadonlyArraySchema`) live in
   `apps/shared/src/schema-helpers.ts`.
2. **Follow the fallout outward.** Change the schema, then let the typecheck
   (`bun run check`) drive the rest:
   - API route: `apps/api/src/modules/<module>/http/`
   - application/domain/infrastructure layers of the module if the shape is persisted
   - frontend consumer: the feature hook under `apps/frontend/src/features/` or
     `apps/frontend/src/services/`
3. **Satellite rules checklist:**
   - Grep for the type name to confirm no duplicate hand-written interface exists.
   - New code imports from the bounded-context entrypoint
     (`@mangostudio/shared/<module>`), never the `contracts/index.ts` barrel.
   - Error responses use `ApiErrorResponse` (`@mangostudio/shared/errors`) or
     `SSEErrorEvent` (`@mangostudio/shared/streaming`).
   - Any new user-visible frontend string comes from `@mangostudio/shared/i18n`.
4. **Tests.** Update the module's route tests and any schema conformance tables.
   Shared-workspace changes fan out, so finish with `bun run check && bun run test`.

## Worked example: add an optional field to a response

Adding `note?: string` to `GET /api/chats/:id/todos` touches four surfaces:

```ts
// 1. apps/shared/src/todos/schemas.ts — schema and derived type change together
export const ChatTodosResponseSchema = Type.Object({
  todos: TodoListSchema,
  updatedAt: Type.Union([Type.Number(), Type.Null()]),
  note: Type.Optional(Type.String()), // new
});
// `ChatTodosResponse` already derives via Static<>, so it picks the field up.
```

```ts
// 2. apps/api/src/modules/todos/http/todo-routes.ts (via the repository/application
//    layer) — return the new field so the handler satisfies ChatTodosResponse
```

```ts
// 3. apps/frontend/src/features/chat/hooks/use-chat-todos.ts — consume the field;
//    the type flows in from '@mangostudio/shared/todos'
```

```ts
// 4. The module's route tests — assert the new field in the response shape
```
