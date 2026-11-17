import { describe, expect, it } from 'bun:test';

import type { Message, MessagesPage } from '@mangostudio/shared/chat';
import type { InfiniteData } from '@tanstack/react-query';

import { patchMessageInCache } from '../../../../src/features/generation/message-cache-patch';

type MessagesCache = InfiniteData<MessagesPage, string | null>;

function makeMessage(id: string, text = id): Message {
  return { id, chatId: 'chat-1', role: 'ai', text, timestamp: 0, isGenerating: false };
}

function makeCache(...pages: Message[][]): MessagesCache {
  return {
    pages: pages.map((messages, index) => ({
      messages,
      nextCursor: index === pages.length - 1 ? null : `cursor-${index}`,
    })),
    pageParams: pages.map((_, index) => (index === 0 ? null : `cursor-${index - 1}`)),
  };
}

/** The updater `useOptimisticMessages` ran before the patch moved here: every page and row mapped. */
function referencePatchMessageInCache(
  cache: MessagesCache | undefined,
  messageId: string,
  updates: Partial<Message>
): MessagesCache | undefined {
  if (!cache) return cache;
  return {
    ...cache,
    pages: cache.pages.map((page) => ({
      ...page,
      messages: page.messages.map((m) => (m.id === messageId ? { ...m, ...updates } : m)),
    })),
  };
}

describe('patchMessageInCache', () => {
  it('returns an empty cache untouched', () => {
    expect(patchMessageInCache(undefined, 'm1', { text: 'x' })).toBeUndefined();
  });

  it('returns the same cache object when no row has the id', () => {
    const cache = makeCache([makeMessage('m1')]);

    expect(patchMessageInCache(cache, 'missing', { text: 'x' })).toBe(cache);
  });

  it('merges the updates into the named row only', () => {
    const cache = makeCache([makeMessage('m1'), makeMessage('m2')]);

    const next = patchMessageInCache(cache, 'm2', { text: 'patched', isGenerating: true });

    expect(next?.pages[0]?.messages[1]).toMatchObject({
      id: 'm2',
      text: 'patched',
      isGenerating: true,
    });
    expect(next?.pages[0]?.messages[0]).toBe(cache.pages[0]?.messages[0]);
  });

  it('keeps the identity of other rows and of pages that do not hold the row', () => {
    const older = [makeMessage('o1'), makeMessage('o2')];
    const newest = [makeMessage('n1'), makeMessage('n2')];
    const cache = makeCache(newest, older);

    const next = patchMessageInCache(cache, 'n2', { text: 'patched' });

    expect(next).not.toBe(cache);
    expect(next?.pages[0]).not.toBe(cache.pages[0]);
    expect(next?.pages[0]?.messages).not.toBe(newest);
    expect(next?.pages[0]?.messages[1]).not.toBe(newest[1]);
    expect(next?.pages[0]?.messages[0]).toBe(newest[0]);
    expect(next?.pages[1]).toBe(cache.pages[1]);
    expect(next?.pageParams).toBe(cache.pageParams);
  });

  it('does not mutate the cache it was given', () => {
    const cache = makeCache([makeMessage('m1', 'before')]);

    patchMessageInCache(cache, 'm1', { text: 'after' });

    expect(cache.pages[0]?.messages[0]?.text).toBe('before');
  });

  it('patches a row on an older page', () => {
    const cache = makeCache([makeMessage('n1')], [makeMessage('o1')]);

    const next = patchMessageInCache(cache, 'o1', { text: 'patched' });

    expect(next?.pages[1]?.messages[0]?.text).toBe('patched');
    expect(next?.pages[0]).toBe(cache.pages[0]);
  });

  it('matches the previous full-map updater over random caches and patches', () => {
    let seed = 20_251_117;
    const random = () => {
      seed = (seed * 1_664_525 + 1_013_904_223) % 4_294_967_296;
      return seed / 4_294_967_296;
    };
    for (let round = 0; round < 200; round += 1) {
      const pageCount = 1 + Math.floor(random() * 3);
      let nextId = 0;
      const pages = Array.from({ length: pageCount }, () =>
        Array.from({ length: Math.floor(random() * 5) }, () => makeMessage(`m${nextId++}`))
      );
      const cache = makeCache(...pages);
      const targetId = `m${Math.floor(random() * (nextId + 1))}`;
      const updates: Partial<Message> = {
        text: `t${round}`,
        ...(random() < 0.5 ? { isGenerating: random() < 0.5 } : {}),
        ...(random() < 0.3 ? { id: `renamed-${round}` } : {}),
      };

      expect(patchMessageInCache(cache, targetId, updates)).toEqual(
        referencePatchMessageInCache(cache, targetId, updates)
      );
    }
  });
});
