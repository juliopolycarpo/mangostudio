import { type Kysely, type RawBuilder, sql } from 'kysely';

import type { Database } from '../../../db/types';
import { findGeneratedImageFilenames } from '../../../services/generated-images/generated-image-storage';
import { IMAGE_REFERENCE_SOURCES, type ImageReferenceSource } from './image-reference-sources';

/** Rows read per statement while scanning a source; bounds what one page holds in memory. */
export const IMAGE_REFERENCE_PAGE_SIZE = 500;

const IMAGE_URL_MARKER = '%/images/%';

export interface ReferenceScanOptions {
  /** Only rows that belong to this chat; without it the scan covers every chat. */
  chatId?: string;
  /**
   * Report only these names. A sweep or a chat delete asks about specific files,
   * so what the scan keeps in memory is bounded by that list, not by the
   * database. (Matching candidates in SQL with `instr` per name was measured and
   * is no faster than this scan at any candidate count: the `LIKE` pass over the
   * message columns dominates.)
   */
  among?: ReadonlySet<string>;
  pageSize?: number;
}

function chatScope(source: ImageReferenceSource, chatId: string | undefined): RawBuilder<unknown> {
  if (chatId === undefined) return sql``;
  if ('column' in source.chat) return sql`AND ${sql.ref(source.chat.column)} = ${chatId}`;
  return sql`AND ${sql.ref(source.chat.messageColumn)} IN (SELECT id FROM messages WHERE chatId = ${chatId})`;
}

type PageRow = Record<string, unknown> & { value: string };

/**
 * Reads one source a page at a time, in key order, and hands each value that
 * mentions `/images/` to `visit`. Paging by the table's key keeps every
 * statement bounded and lets the scan resume where the last page ended.
 */
async function scanSource(
  db: Kysely<Database>,
  source: ImageReferenceSource,
  options: { chatId: string | undefined; pageSize: number },
  visit: (value: string) => void
): Promise<void> {
  const keyList = sql.join(source.pageKey.map((key) => sql.ref(key)));
  const keySelect = sql.join(
    source.pageKey.map((key, index) => sql`${sql.ref(key)} AS ${sql.id(`key${index}`)}`)
  );
  const scope = chatScope(source, options.chatId);
  // Key of the last row of the previous page; the next page starts after it.
  let after: readonly unknown[] | null = null;

  for (;;) {
    const resumeAfter: RawBuilder<unknown> = after
      ? sql`AND (${keyList}) > (${sql.join(after)})`
      : sql``;
    const { rows }: { rows: PageRow[] } = await sql<PageRow>`
      SELECT ${keySelect}, ${sql.ref(source.column)} AS value
      FROM ${sql.table(source.table)}
      WHERE ${sql.ref(source.column)} LIKE ${IMAGE_URL_MARKER}
      ${resumeAfter}
      ${scope}
      ORDER BY ${keyList}
      LIMIT ${options.pageSize}`.execute(db);

    for (const row of rows) visit(row.value);
    const last = rows.at(-1);
    if (!last || rows.length < options.pageSize) return;
    after = source.pageKey.map((_, index) => last[`key${index}`]);
  }
}

/**
 * File names of the generated images that stored rows point at, read from every
 * registered source (`IMAGE_REFERENCE_SOURCES`): artifact rows, legacy and
 * reference message images, `/images/<name>` inside message text, parts and
 * provider state, and the checkpoint deltas of a turn still streaming.
 *
 * @example
 * const inThisChat = await listReferencedGeneratedImageFilenames(db, { chatId });
 */
export async function listReferencedGeneratedImageFilenames(
  db: Kysely<Database>,
  options: ReferenceScanOptions = {}
): Promise<Set<string>> {
  const filenames = new Set<string>();
  const visit = (value: string): void => {
    for (const filename of findGeneratedImageFilenames(value)) {
      if (!options.among || options.among.has(filename)) filenames.add(filename);
    }
  };

  for (const source of IMAGE_REFERENCE_SOURCES) {
    await scanSource(
      db,
      source,
      { chatId: options.chatId, pageSize: options.pageSize ?? IMAGE_REFERENCE_PAGE_SIZE },
      visit
    );
  }
  return filenames;
}
