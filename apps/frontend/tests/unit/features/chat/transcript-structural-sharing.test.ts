/**
 * `shareTranscriptStructure` must return what the library's default
 * (`replaceEqualDeep`) returns, object for object, while skipping the walk over
 * rows a writer already kept.
 */

import { describe, expect, it } from 'bun:test';

import type { Message, MessagesPage } from '@mangostudio/shared/chat';
import { replaceEqualDeep } from '@tanstack/react-query';

import { messagesQueryOptions } from '../../../../src/features/chat/queries';
import {
  type MessagesCache,
  shareTranscriptStructure,
} from '../../../../src/features/chat/transcript-pages';
import { patchMessageInCache } from '../../../../src/features/generation/message-cache-patch';

function makeRow(id: string, text = id): Message {
  return {
    id,
    chatId: 'chat-1',
    role: 'ai',
    text,
    timestamp: 1,
    parts: [{ type: 'text', text }],
  };
}

function makeCache(...pages: Message[][]): MessagesCache {
  return {
    pages: pages.map((messages, index): MessagesPage => ({
      messages,
      nextCursor: index === pages.length - 1 ? null : `cursor-${index}`,
    })),
    pageParams: pages.map((_, index) => (index === 0 ? null : `cursor-${index - 1}`)),
  };
}

function createRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296;
    return state / 4_294_967_296;
  };
}

/** Which of `next`'s pages and rows are the very objects `previous` held. */
function keptObjects(previous: MessagesCache, next: MessagesCache): string[] {
  const kept: string[] = [
    `cache:${next === previous}`,
    `pageParams:${next.pageParams === previous.pageParams}`,
  ];
  next.pages.forEach((page, pageIndex) => {
    const before = previous.pages[pageIndex];
    kept.push(`page${pageIndex}:${page === before}`);
    page.messages.forEach((rowValue, rowIndex) => {
      kept.push(`page${pageIndex}.row${rowIndex}:${rowValue === before?.messages[rowIndex]}`);
    });
  });
  return kept;
}

describe('shareTranscriptStructure', () => {
  it('returns the new data when there is nothing before it', () => {
    const next = makeCache([makeRow('a')]);

    expect(shareTranscriptStructure(undefined, next)).toBe(next);
  });

  it('returns the previous cache when a refetch brings equal rows as new objects', () => {
    const previous = makeCache([makeRow('a'), makeRow('b')], [makeRow('c')]);
    const refetched = structuredClone(previous);

    expect(shareTranscriptStructure(previous, refetched)).toBe(previous);
  });

  it('keeps unchanged rows and pages of a refetch and takes the changed row', () => {
    const previous = makeCache([makeRow('a'), makeRow('b')], [makeRow('c')]);
    const refetched = structuredClone(previous);
    const changedRow = refetched.pages[0]?.messages[1];
    if (!changedRow) throw new Error('expected a second row on the newest page');
    changedRow.text = 'changed';

    const shared = shareTranscriptStructure(previous, refetched) as MessagesCache;

    expect(shared.pages[0]?.messages[0]).toBe(previous.pages[0]?.messages[0]);
    expect(shared.pages[0]?.messages[1]?.text).toBe('changed');
    expect(shared.pages[1]).toBe(previous.pages[1]);
  });

  it('matches the library default, object for object, over random writes', () => {
    const random = createRandom(11);
    for (let round = 0; round < 300; round += 1) {
      let nextId = 0;
      const previous = makeCache(
        ...Array.from({ length: 1 + Math.floor(random() * 3) }, () =>
          Array.from({ length: Math.floor(random() * 5) }, () => makeRow(`m${nextId++}`))
        )
      );
      // A write is a patch (shared objects), a refetch (all new objects) or a
      // refetch with one row edited, one row added or one page dropped.
      let next: MessagesCache;
      const kind = Math.floor(random() * 5);
      if (kind === 0) {
        next = patchMessageInCache(previous, `m${Math.floor(random() * (nextId + 1))}`, {
          text: `t${round}`,
        }) as MessagesCache;
      } else {
        next = structuredClone(previous);
        const newest = next.pages[0];
        if (kind === 2 && newest?.messages[0]) newest.messages[0].text = `edited${round}`;
        if (kind === 3 && newest) newest.messages.push(makeRow(`extra${round}`));
        if (kind === 4 && next.pages.length > 1) {
          next.pages.pop();
          next.pageParams.pop();
        }
      }

      const shared = shareTranscriptStructure(previous, next) as MessagesCache;
      const expected = replaceEqualDeep(previous, next) as MessagesCache;

      expect(shared).toEqual(next);
      expect(keptObjects(previous, shared)).toEqual(keptObjects(previous, expected));
    }
  });
});

describe('messagesQueryOptions', () => {
  it('uses shareTranscriptStructure for the transcript query only', () => {
    expect(messagesQueryOptions('chat-1').structuralSharing).toBe(shareTranscriptStructure);
  });
});
