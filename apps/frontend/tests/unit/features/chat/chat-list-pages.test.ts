import { describe, expect, it } from 'bun:test';

import type { Chat, ChatListPage } from '@mangostudio/shared/chat';

import {
  type ChatListCache,
  flattenChatPages,
  insertChatAtHead,
  patchChatInPages,
  removeChatFromPages,
} from '../../../../src/features/chat/chat-list-pages';

function chat(id: string, title = id): Chat {
  return {
    id,
    title,
    createdAt: 1,
    updatedAt: 1,
    model: null,
    textModel: null,
    imageModel: null,
    runner: { kind: 'mangostudio', agentId: 'default' },
    runnerPermissions: {},
    runnerModelSelection: {},
    workdir: null,
    environmentId: 'local',
    restrictToolsToWorkdir: null,
  };
}

/** Pages the way the sidebar holds them: the newest first, each carrying its cursor. */
function cacheOf(...pages: string[][]): ChatListCache {
  const listPages: ChatListPage[] = pages.map((ids, index) => ({
    items: ids.map((id) => chat(id)),
    nextCursor: index < pages.length - 1 ? `cursor-${index}` : null,
  }));
  return {
    pages: listPages,
    pageParams: listPages.map((_, index) => (index === 0 ? null : `cursor-${index - 1}`)),
  };
}

const idsOf = (cache: ChatListCache) => cache.pages.map((page) => page.items.map((c) => c.id));

describe('flattenChatPages', () => {
  it('joins the pages in order', () => {
    expect(flattenChatPages(cacheOf(['a', 'b'], ['c'])).map((c) => c.id)).toEqual(['a', 'b', 'c']);
  });

  it('keeps the first occurrence of a chat that two pages both carry', () => {
    // A refetch that straddles a recency bump can serve one chat on two pages.
    const base = cacheOf(['a', 'b'], ['b', 'c']);
    const cache: ChatListCache = {
      ...base,
      pages: base.pages.map((page, index) =>
        index === 0 ? { ...page, items: [chat('a', 'a'), chat('b', 'newer title')] } : page
      ),
    };

    const flat = flattenChatPages(cache);

    expect(flat.map((c) => c.id)).toEqual(['a', 'b', 'c']);
    expect(flat[1]?.title).toBe('newer title');
  });
});

describe('insertChatAtHead', () => {
  it('puts a new chat first on the first page and leaves the cursors alone', () => {
    const cache = cacheOf(['a'], ['b']);

    const next = insertChatAtHead(cache, chat('fresh'));

    expect(idsOf(next)).toEqual([['fresh', 'a'], ['b']]);
    expect(next.pages.map((page) => page.nextCursor)).toEqual(['cursor-0', null]);
    expect(next.pageParams).toEqual(cache.pageParams);
  });

  it('moves a chat already loaded on a later page to the head instead of repeating it', () => {
    const next = insertChatAtHead(cacheOf(['a', 'b'], ['c', 'd']), chat('d'));

    expect(idsOf(next)).toEqual([['d', 'a', 'b'], ['c']]);
  });
});

describe('patchChatInPages', () => {
  it('rewrites the chat wherever its page is, in place', () => {
    const next = patchChatInPages(cacheOf(['a'], ['b', 'c']), 'c', (c) => ({
      ...c,
      title: 'renamed',
    }));

    expect(next.pages[1]?.items.map((c) => c.title)).toEqual(['b', 'renamed']);
    expect(idsOf(next)).toEqual([['a'], ['b', 'c']]);
  });

  it('answers the same cache object when the chat is not loaded', () => {
    const cache = cacheOf(['a'], ['b']);

    expect(patchChatInPages(cache, 'zzz', (c) => ({ ...c, title: 'x' }))).toBe(cache);
  });
});

describe('removeChatFromPages', () => {
  it('drops the chat from its page and keeps every cursor', () => {
    const cache = cacheOf(['a', 'b'], ['c']);

    const next = removeChatFromPages(cache, 'b');

    expect(idsOf(next)).toEqual([['a'], ['c']]);
    expect(next.pages.map((page) => page.nextCursor)).toEqual(['cursor-0', null]);
  });

  it('leaves a page empty rather than dropping it, so its cursor still reaches the next', () => {
    const next = removeChatFromPages(cacheOf(['a'], ['b']), 'a');

    expect(idsOf(next)).toEqual([[], ['b']]);
    expect(next.pages[0]?.nextCursor).toBe('cursor-0');
  });
});
