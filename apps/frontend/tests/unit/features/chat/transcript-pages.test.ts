/**
 * The pure rules of the transcript cache: how pages flatten into a chat, and
 * how a refresh of the newest end joins the history already loaded.
 *
 * Pages here are the shape `FakeTranscriptApi` serves: chronological inside a
 * page, newest page first, `nextCursor` the position of a page's oldest row.
 */

import { describe, expect, it } from 'bun:test';
import type { Message } from '@mangostudio/shared';
import type { MessagesPage } from '@mangostudio/shared/chat';
import {
  catchUpNewestPages,
  type FetchMessagesPage,
  flattenTranscript,
  loadOlderPage,
  type MessagesCache,
  transcriptPageSizes,
} from '../../../../src/features/chat/transcript-pages';
import { FakeTranscriptApi } from '../../../support/mocks/fake-transcript-api';

const CHAT_ID = 'chat-1';

function row(position: number): Message {
  return FakeTranscriptApi.messageAt(CHAT_ID, position);
}

function rows(first: number, last: number): Message[] {
  return Array.from({ length: last - first + 1 }, (_, index) => row(first + index));
}

/** The page the hub serves for rows `first..last`; its cursor is the position of `first`. */
function page(first: number, last: number, hasOlder = first > 1): MessagesPage {
  return { messages: rows(first, last), nextCursor: hasOlder ? String(first) : null };
}

/** A transcript holding exactly these pages, newest first, each fetched with the cursor before it. */
function cache(...pages: MessagesPage[]): MessagesCache {
  return {
    pages,
    pageParams: pages.map((_, index) =>
      index === 0 ? null : (pages[index - 1]?.nextCursor ?? null)
    ),
  };
}

/**
 * A hub holding rows `1..total` that answers one page per call and records the
 * cursors it was asked with, so a test can say how many requests a refresh cost.
 */
function hubWith(total: number, limit = 50) {
  const cursors: Array<string | null> = [];
  const fetchPage: FetchMessagesPage = (cursor) => {
    cursors.push(cursor);
    const before = cursor === null ? total + 1 : Number(cursor);
    const first = Math.max(1, before - limit);
    const last = before - 1;
    return Promise.resolve(page(first, last));
  };
  return { fetchPage, cursors };
}

function summarize(data: MessagesCache): string {
  return data.pages.map((p) => `${p.messages[0]?.text}..${p.messages.at(-1)?.text}`).join(' | ');
}

describe('flattenTranscript', () => {
  it('lays pages out oldest first although the cache holds the newest page first', () => {
    const flat = flattenTranscript(cache(page(71, 120), page(21, 70)));

    expect(flat.map((message) => message.text).filter((_, i) => i % 49 === 0)).toEqual([
      'msg-021',
      'msg-070',
      'msg-119',
    ]);
    expect(flat).toHaveLength(100);
  });

  it('reads nothing as an empty chat', () => {
    expect(flattenTranscript(undefined)).toEqual([]);
  });
});

describe('catchUpNewestPages', () => {
  it('reads only the newest page when nothing slid out of it', async () => {
    const hub = hubWith(120);
    const loaded = cache(page(71, 120), page(21, 70), page(1, 20));

    const next = await catchUpNewestPages(loaded, hub.fetchPage);

    expect(hub.cursors).toEqual([null]);
    expect(summarize(next)).toBe('msg-071..msg-120 | msg-021..msg-070 | msg-001..msg-020');
    expect(next.pages[1]).toBe(loaded.pages[1]);
  });

  it('joins new rows to the loaded history in two reads', async () => {
    const hub = hubWith(122);
    const loaded = cache(page(71, 120), page(21, 70), page(1, 20));

    const next = await catchUpNewestPages(loaded, hub.fetchPage);

    expect(hub.cursors).toEqual([null, '73']);
    const flat = flattenTranscript(next);
    expect(`${flat[0]?.text} .. ${flat.at(-1)?.text} (${flat.length})`).toBe(
      'msg-001 .. msg-122 (122)'
    );
  });

  it('keeps every row once when the new rows split a loaded page', async () => {
    const hub = hubWith(125);
    const loaded = cache(page(71, 120), page(21, 70), page(1, 20));

    const flat = flattenTranscript(await catchUpNewestPages(loaded, hub.fetchPage));

    const texts = flat.map((message) => message.text);
    expect(texts).toEqual(rows(1, 125).map((message) => message.text));
  });

  it('keeps the oldest cursor so the first rows are still reachable', async () => {
    const hub = hubWith(122);
    const loaded = cache(page(71, 120), page(21, 70));

    const next = await catchUpNewestPages(loaded, hub.fetchPage);

    expect(next.pages.at(-1)?.nextCursor).toBe('21');
  });

  it('drops the older pages when the new rows outrun them, and reads on from the last page read', async () => {
    const hub = hubWith(500);
    const loaded = cache(page(71, 120), page(21, 70));

    const next = await catchUpNewestPages(loaded, hub.fetchPage);

    expect(next.pages).toHaveLength(5);
    expect(next.pages.at(-1)?.nextCursor).toBe(String(500 - 5 * 50 + 1));
  });

  it('does not graft loaded rows the server has since removed onto what it read', async () => {
    // The hub now holds only rows 1..60; the reader had loaded rows 1..120.
    const hub = hubWith(60);
    const loaded = cache(page(71, 120), page(21, 70), page(1, 20));

    const next = await catchUpNewestPages(loaded, hub.fetchPage);

    const flat = flattenTranscript(next).map((message) => message.text);
    expect(`${flat[0]} .. ${flat.at(-1)} (${flat.length})`).toBe('msg-011 .. msg-060 (50)');
    expect(next.pages.at(-1)?.nextCursor).toBe('11');
  });

  it('returns what it read when only one page was loaded', async () => {
    const hub = hubWith(122);

    const next = await catchUpNewestPages(cache(page(71, 120)), hub.fetchPage);

    expect(hub.cursors).toEqual([null]);
    expect(summarize(next)).toBe('msg-073..msg-122');
  });

  it('stops at the start of the chat without keeping rows it already holds', async () => {
    const hub = hubWith(60);
    const loaded = cache(page(11, 60), page(1, 10, false));

    const next = await catchUpNewestPages(loaded, hub.fetchPage);

    expect(flattenTranscript(next)).toHaveLength(60);
  });
});

describe('transcriptPageSizes', () => {
  it('lists the rows of each page, oldest page first', () => {
    const sizes = transcriptPageSizes(cache(page(71, 120), page(21, 70), page(1, 20)));
    expect(`page sizes: ${sizes.join(',')}`).toBe('page sizes: 20,50,50');
  });

  it('reads nothing as no pages', () => {
    expect(`page sizes: ${transcriptPageSizes(undefined).length}`).toBe('page sizes: 0');
  });
});

describe('loadOlderPage', () => {
  it('adds the page below the oldest loaded one', async () => {
    const hub = hubWith(120);
    const current = cache(page(71, 120));

    const next = await loadOlderPage(() => current, hub.fetchPage);

    expect(`pages: ${summarize(next)}`).toBe('pages: msg-071..msg-120 | msg-021..msg-070');
    expect(`cursors asked: ${hub.cursors.join(',')}`).toBe('cursors asked: 71');
    expect(`page params: ${next.pageParams.join(',')}`).toBe('page params: ,71');
  });

  it('asks for nothing when the oldest message is already loaded', async () => {
    const hub = hubWith(30);
    const current = cache(page(1, 30));

    const next = await loadOlderPage(() => current, hub.fetchPage);

    expect(next).toBe(current);
    expect(`requests: ${hub.cursors.length}`).toBe('requests: 0');
  });

  it('keeps a row a live writer added while the page was in flight', async () => {
    const hub = hubWith(120);
    let live = cache(page(71, 120));
    const fetchPage: FetchMessagesPage = async (cursor, signal) => {
      const older = await hub.fetchPage(cursor, signal);
      // The optimistic row lands on the newest page while the older one is read.
      const [newest, ...rest] = live.pages;
      if (!newest) throw new Error('expected a newest page | received none');
      live = {
        ...live,
        pages: [{ ...newest, messages: [...newest.messages, row(121)] }, ...rest],
      };
      return older;
    };

    const next = await loadOlderPage(() => live, fetchPage);

    expect(`newest page ends: ${next.pages[0]?.messages.at(-1)?.text}`).toBe(
      'newest page ends: msg-121'
    );
    expect(`pages: ${next.pages.length}`).toBe('pages: 2');
  });

  it('drops a page that no longer follows the loaded history', async () => {
    const hub = hubWith(120);
    let live = cache(page(71, 120));
    const fetchPage: FetchMessagesPage = async (cursor, signal) => {
      const older = await hub.fetchPage(cursor, signal);
      // A refetch replaced the history meanwhile: its oldest page starts elsewhere.
      live = cache(page(81, 130));
      return older;
    };

    const next = await loadOlderPage(() => live, fetchPage);

    expect(`pages: ${summarize(next)}`).toBe('pages: msg-081..msg-130');
  });

  it('throws what a reader-driven fetch threw', async () => {
    const failing: FetchMessagesPage = () => Promise.reject(new Error('boom'));

    await expect(loadOlderPage(() => cache(page(71, 120)), failing)).rejects.toThrow('boom');
  });

  it('leaves the cache as it is when a background fetch fails, and says so', async () => {
    const current = cache(page(71, 120));
    const failing: FetchMessagesPage = () => Promise.reject(new Error('boom'));
    let failures = 0;

    const next = await loadOlderPage(() => current, failing, {
      signal: new AbortController().signal,
      onFailure: () => {
        failures++;
      },
    });

    expect(next).toBe(current);
    expect(`failures reported: ${failures}`).toBe('failures reported: 1');
  });

  it('leaves the cache as it is when a background fetch is aborted, without a failure', async () => {
    const current = cache(page(71, 120));
    const controller = new AbortController();
    const aborted: FetchMessagesPage = () => {
      controller.abort();
      return Promise.reject(new DOMException('The operation was aborted.', 'AbortError'));
    };
    let failures = 0;

    const next = await loadOlderPage(() => current, aborted, {
      signal: controller.signal,
      onFailure: () => {
        failures++;
      },
    });

    expect(next).toBe(current);
    expect(`failures reported: ${failures}`).toBe('failures reported: 0');
  });
});
