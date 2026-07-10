---
name: create-migration
description: Scaffold a new Kysely migration with correct numbering, registration in the migrations index, and paired DB type updates. Use only when the user explicitly asks to create or scaffold a database migration because migrations change the schema.
---

# Create migration

Scaffold a Kysely migration the way this repository expects: `NNN_description.ts`
file naming, a named-export `Migration` object (never a default export), explicit
registration in `apps/api/src/db/migrations/index.ts`, and a paired update to
`apps/api/src/db/types.ts`. Follow every step because an incorrect number or missing
index registration fails only at runtime.

Read the newest migration in `apps/api/src/db/migrations/` before scaffolding. Treat
it as the living example for current idioms when it differs from this skill.

## Procedure

1. **Determine the next number.** Take the highest `NNN` prefix in
   `apps/api/src/db/migrations/` and add 1, zero-padded to 3 digits.
2. **Create the migration file** `apps/api/src/db/migrations/NNN_<snake_description>.ts`
   from [template.ts.txt](template.ts.txt):
   - Export the camel-case description as a named `Migration` (for example,
     `026_audit_events.ts` exports `auditEvents`).
   - Implement both `up` and `down`; make `down` reverse `up` in reverse order.
   - Use `ifNotExists()` on creates and `ifExists()` on drops so reruns are idempotent.
   - Choose FK `onDelete` behavior deliberately: use `cascade` for owned child rows;
     otherwise decide based on the relationship.
   - Name indexes `idx_<table>_<col>`.
3. **Register the migration** in `apps/api/src/db/migrations/index.ts`: add the import
   and the `'NNN_<snake_description>': <namedExport>` entry in numeric order.
4. **Update `apps/api/src/db/types.ts`:**
   - Add the hand-written `<Entity>Table` interface.
   - Add the table to the `Database` interface using its `snake_case` name.
   - Derive only the Kysely aliases the owning module uses:
     `Selectable<<Entity>Table>`, `Insertable<<Entity>Table>`, and/or
     `Updateable<<Entity>Table>`. Match nearby entries rather than emitting all three.
5. **Apply repository conventions:**
   - Use `snake_case` table names and `camelCase` column names.
   - Store JSON payloads in `text` columns and comment the serialized shape.
   - Store timestamps such as `createdAt` and `updatedAt` as integer epoch milliseconds.
6. **Validate.** Run `bun run check`, then `bun run test` from the repository root.
   The API integration harness applies every registered migration to a fresh database.

## Scope

Only scaffold files. Do not execute `src/db/migrate.ts` against a non-test database;
running migrations against a real database requires separate user confirmation.
