---
name: create-migration
description: Scaffold a new Kysely migration with correct numbering, registration in the migrations index, and paired DB type updates. Migrations change schema, so this skill is user-invoked only.
disable-model-invocation: true
---

# Create migration

Scaffolds a Kysely migration the way this repo expects: `NNN_description.ts` file
naming, a named-export `Migration` object (never a default export), explicit
registration in `apps/api/src/db/migrations/index.ts`, and a paired update to
`apps/api/src/db/types.ts`. Getting the number or the index registration wrong is a
silent-until-runtime failure — follow every step.

The newest migration in `apps/api/src/db/migrations/` is the living example for
current idioms. Read it before scaffolding; prefer what it does over anything here
that has drifted.

## Procedure

1. **Determine the next number.** Take the highest `NNN` prefix in
   `apps/api/src/db/migrations/` and add 1, zero-padded to 3 digits.
2. **Create the migration file** `apps/api/src/db/migrations/NNN_<snake_description>.ts`
   from [template.ts.txt](template.ts.txt):
   - Named export: `camelCase` of the description (e.g. `026_audit_events.ts` exports
     `auditEvents`), typed as `Migration` from `'kysely/migration'`.
   - Implement **both** `up` and `down`; `down` reverses `up` in reverse order.
   - Use `ifNotExists()` on creates and `ifExists()` on drops so reruns are idempotent.
   - Choose FK `onDelete` behavior deliberately (`cascade` for owned child rows;
     otherwise decide, don't default).
   - Name indexes `idx_<table>_<col>`.
3. **Register it** in `apps/api/src/db/migrations/index.ts`: add the import and the
   `'NNN_<snake_description>': <namedExport>` entry, keeping numeric order.
4. **Update `apps/api/src/db/types.ts`:**
   - Add the `<Entity>Table` interface (hand-written; nothing is generated).
   - Add the table to the `Database` interface (key is the `snake_case` table name).
   - Derive the Kysely aliases the owning module will use:
     `export type <Entity>Select = Selectable<<Entity>Table>` and likewise
     `Insert = Insertable<…>` / `Update = Updateable<…>`. Existing entries only
     declare the aliases actually consumed — match that, don't emit all three
     unconditionally.
5. **Conventions checklist:**
   - Tables are `snake_case`; columns are `camelCase` (e.g. `chat_todos.chatId`).
   - JSON payloads are stored as `text` columns (comment the serialized shape, e.g.
     `// JSON-serialized TodoItem[]`).
   - Timestamps are `integer` epoch-millis columns (`createdAt`, `updatedAt`).
6. **Validate.** Run `bun run check`, then the API tests (`bun run test` in
   `apps/api/`) — the integration harness applies every registered migration to a
   fresh database, so a bad migration fails there.

## Scope note

This skill only scaffolds files. Executing migrations against a real database is
gated separately by the user-level policy hook; do not run `src/db/migrate.ts`
against non-test databases as part of scaffolding.
