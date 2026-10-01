import type { Message } from '@mangostudio/shared';
import type { MessagesPage } from '@mangostudio/shared/chat';
import type { InfiniteData } from '@tanstack/react-query';

/**
 * The shape of the transcript's cache entry.
 *
 * The transcript is read from its NEWEST end: `pages[0]` is the newest page
 * and every later page is older, each holding its rows chronologically (oldest
 * first). The page param of a page is the cursor that fetched it, `null` for
 * the newest. Live writers (optimistic rows, the streaming reply) therefore
 * append to `pages[0]`, and "next page" means "older".
 */
export type MessagesCache = InfiniteData<MessagesPage, string | null>;

/** Fetches one transcript page: the newest when `cursor` is `null`, else the one before `cursor`. */
export type FetchMessagesPage = (cursor: string | null) => Promise<MessagesPage>;

/**
 * How many pages a refresh may fetch while looking for where the new rows meet
 * the pages already loaded. A refresh normally needs two; more only when
 * hundreds of messages arrived since the last read.
 */
const MAX_CATCH_UP_PAGES = 4;

/**
 * Flattens the transcript's cache into the chronological list the feed renders.
 *
 * @example
 * flattenTranscript({ pages: [newest, older], pageParams: [null, 'c'] });
 * // => [...older.messages, ...newest.messages]
 */
export function flattenTranscript(
  data: { readonly pages: readonly MessagesPage[] } | undefined
): Message[] {
  if (!data) return [];
  return data.pages
    .slice()
    .reverse()
    .flatMap((page) => page.messages);
}

/**
 * Refreshes the newest end of a transcript without re-reading the history the
 * reader has scrolled back through.
 *
 * Re-reading every loaded page costs one request per page on every turn. The
 * rows that change are at the newest end (a finished turn, a streamed reply
 * becoming final), so this reads the newest page and, because new rows push the
 * oldest rows of the previous newest page out of it, keeps reading backwards
 * only until it reaches a row the loaded older pages already hold. Everything
 * older than that is kept as it is, so the reader keeps their place and the
 * cost is two requests however deep they have scrolled.
 *
 * The result always starts at the newest page and ends where the loaded history
 * did, so `nextCursor` of its last page still leads to the older rows that were
 * not loaded. When the read does not join the loaded history (no overlap within
 * `MAX_CATCH_UP_PAGES`, so many new rows that the old pages no longer touch
 * them, or the server no longer has a row the reader had loaded), the older
 * pages are dropped: the reader asks for them again by scrolling, from the last
 * page read. Rows already loaded are not re-read, so an edit to one is not seen.
 *
 * @example
 * const next = await catchUpNewestPages(current, (cursor) => fetchMessagesPage(chatId, cursor));
 */
export async function catchUpNewestPages(
  current: MessagesCache,
  fetchPage: FetchMessagesPage
): Promise<MessagesCache> {
  const head = await fetchPage(null);
  const loadedOlder = current.pages.slice(1);
  const loadedOlderParams = current.pageParams.slice(1);

  if (loadedOlder.length === 0) return { pages: [head], pageParams: [null] };

  // The newest page ends where it did: no row slid out of it, so the older
  // pages still start right below it and are kept whole.
  if (head.nextCursor !== null && head.nextCursor === loadedOlderParams[0]) {
    return { pages: [head, ...loadedOlder], pageParams: [null, ...loadedOlderParams] };
  }

  const fetched: MessagesPage[] = [head];
  const fetchedParams: Array<string | null> = [null];

  const knownIds = new Set(loadedOlder.flatMap((page) => page.messages.map((m) => m.id)));
  const touchesKnown = (page: MessagesPage) => page.messages.some((m) => knownIds.has(m.id));

  let last = head;
  while (!touchesKnown(last) && last.nextCursor !== null && fetched.length <= MAX_CATCH_UP_PAGES) {
    fetchedParams.push(last.nextCursor);
    last = await fetchPage(last.nextCursor);
    fetched.push(last);
  }

  // The loaded history joins what was read when the read contains the newest
  // row the reader had loaded below it. Rows are contiguous, so a read that
  // touches loaded rows without reaching that one means the server no longer
  // has it, and the loaded history cannot be trusted to sit below the read.
  const fetchedIds = new Set(fetched.flatMap((page) => page.messages.map((m) => m.id)));
  const newestLoaded = loadedOlder[0]?.messages.at(-1)?.id;
  const joined = newestLoaded !== undefined && fetchedIds.has(newestLoaded);

  // There is nothing older than what was read, or the loaded history is out of
  // reach or no longer true: what was just read is the whole answer.
  if (last.nextCursor === null || !joined) {
    return { pages: fetched, pageParams: fetchedParams };
  }

  const keptPages: MessagesPage[] = [];
  const keptParams: Array<string | null> = [];
  loadedOlder.forEach((page, index) => {
    const messages = page.messages.filter((m) => !fetchedIds.has(m.id));
    if (messages.length === 0) return;
    keptPages.push({ ...page, messages });
    keptParams.push(loadedOlderParams[index] ?? null);
  });

  return { pages: [...fetched, ...keptPages], pageParams: [...fetchedParams, ...keptParams] };
}
