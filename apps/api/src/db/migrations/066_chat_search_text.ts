import { sql } from 'kysely';
import type { Migration } from 'kysely/migration';

/**
 * Adds `chats.searchText`, the folded text the chat list's `?q=` search looks
 * for a query in. It holds the title, the last segment of the workdir and the
 * runner label, each case- and accent-folded and joined by a newline, so a
 * query folded the same way matches `Configuração` from `CONFIGURAÇÃO` and from
 * `configuracao`. SQLite's own `lower()` folds ASCII only, which is why the
 * fold happens in TypeScript when a chat is written and not in the query.
 *
 * Migrations are frozen snapshots, so the fold below is a copy of the one in
 * `modules/chats/domain/chat-search-key.ts` as it was when this ran, not an
 * import of it; `chat-search-text-migration.test.ts` fails if the two drift
 * apart on a sample that exercises each rule.
 *
 * The column is `NOT NULL DEFAULT ''` so a row written by an older build during
 * a rolling restart is a chat nobody can find by search, not a read error; the
 * next write of the chat repairs it. Existing rows are filled in batches by
 * `id`, so memory stays flat for a long history. The migrator runs the batch of
 * pending migrations as one transaction, so a failure leaves no half-filled
 * column behind.
 */

const BACKFILL_BATCH_SIZE = 500;

function foldForSearch(text: string): string {
  return text
    .toUpperCase()
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replaceAll('ς', 'σ');
}

function workdirFolder(workdir: string | null): string {
  if (!workdir) return '';
  const segments = workdir.split(/[\\/]/).filter((segment) => segment.length > 0);
  return segments.at(-1) ?? '';
}

interface ChatSearchSourceRow {
  id: string;
  title: string;
  workdir: string | null;
  runnerKind: string;
  runnerTargetId: string | null;
}

function searchTextOf(row: ChatSearchSourceRow): string {
  const runnerLabel = row.runnerKind === 'mangostudio' ? 'mango' : (row.runnerTargetId ?? '');
  return [row.title, workdirFolder(row.workdir), runnerLabel].map(foldForSearch).join('\n');
}

export const chatSearchText: Migration = {
  async up(db): Promise<void> {
    await db.schema
      .alterTable('chats')
      .addColumn('searchText', 'text', (col) => col.notNull().defaultTo(''))
      .execute();

    let lastId = '';
    for (;;) {
      const { rows } = await sql<ChatSearchSourceRow>`
        SELECT id, title, workdir, runnerKind, runnerTargetId
        FROM chats
        WHERE id > ${lastId}
        ORDER BY id
        LIMIT ${BACKFILL_BATCH_SIZE}
      `.execute(db);
      for (const row of rows) {
        await sql`UPDATE chats SET searchText = ${searchTextOf(row)} WHERE id = ${row.id}`.execute(
          db
        );
      }
      const last = rows.at(-1);
      if (!last) break;
      lastId = last.id;
    }
  },

  async down(db): Promise<void> {
    await db.schema.alterTable('chats').dropColumn('searchText').execute();
  },
};
