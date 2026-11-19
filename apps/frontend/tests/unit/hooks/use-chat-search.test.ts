/**
 * The server-side chat search and the by-id chat read: a list that is paged
 * cannot be searched or opened from what happens to be loaded, so both ask the
 * hub. The hub is a named fake here, so each test states the exact requests it
 * expects.
 */

import { beforeEach, describe, expect, it, jest, mock } from 'bun:test';

import { CHAT_SEARCH_MAX_LENGTH } from '@mangostudio/shared/chat';
import { createMockChat } from '@mangostudio/shared/test-utils';
import { useQueryClient } from '@tanstack/react-query';

import type * as ApiClient from '../../../src/lib/api-client';
import { act, renderHook, waitFor } from '../../support/harness/render';

const mockList = jest.fn();
const mockGetById = jest.fn();
const mockPut = jest.fn();
const mockDelete = jest.fn();

/** `client.api.chats(...)` addresses one chat; `client.api.chats.get` lists. */
const chatsEndpoint = Object.assign(
  jest.fn(() => ({ get: mockGetById, put: mockPut, delete: mockDelete })),
  { get: mockList, post: jest.fn() }
);

// Eden Treaty's generic types are too strict for jest.fn() mocks, so the
// factory is cast via unknown.
void mock.module('../../../src/lib/api-client', () => ({
  client: { api: { chats: chatsEndpoint } } as unknown as typeof ApiClient.client,
}));

// Static imports are evaluated before any statement above runs, so the module
// under test has to come in afterwards or it binds the real api-client.
const {
  chatKeys,
  useChatDetailQuery,
  useChatSearch,
  useDeleteChatMutation,
  useUpdateChatMutation,
} = await import('../../../src/features/chat/queries');

const chatNamed = (id: string, title = id) =>
  createMockChat({ id, title, createdAt: 1, updatedAt: 1 });

function page(items: ReturnType<typeof chatNamed>[], nextCursor: string | null = null) {
  return { data: { items, nextCursor }, error: null };
}

/** The `q` of each list request the hub saw, in order. */
function searchedTerms(): (string | undefined)[] {
  return mockList.mock.calls.map(([arg]) => (arg as { query: { q?: string } }).query.q);
}

describe('useChatSearch', () => {
  beforeEach(() => {
    mockList.mockReset();
    mockGetById.mockReset();
    mockList.mockResolvedValue(page([]));
  });

  it('asks for nothing while the text is blank', async () => {
    const { result } = renderHook(() => useChatSearch('   '));

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
    });

    expect(
      mockList,
      '(useChatSearch): expected list requests for a blank query: 0'
    ).not.toHaveBeenCalled();
    expect(result.current.isPending).toBe(false);
    expect(result.current.chats).toEqual([]);
  });

  it('sends one request for a burst of keystrokes, with the final trimmed text', async () => {
    mockList.mockResolvedValue(page([chatNamed('hit', 'Release plan')]));
    const { result, rerender } = renderHook(({ text }) => useChatSearch(text), {
      initialProps: { text: 'r' },
    });
    rerender({ text: 're' });
    rerender({ text: ' rel ' });

    await waitFor(() => expect(result.current.chats.map((chat) => chat.id)).toEqual(['hit']));

    expect(searchedTerms()).toEqual(['rel']);
    expect(mockList.mock.calls[0]?.[0]).toMatchObject({ query: { limit: 50, q: 'rel' } });
    expect(result.current.isPending).toBe(false);
  });

  it('reports pending from the first keystroke until the matches arrive', async () => {
    mockList.mockResolvedValue(page([chatNamed('hit')]));
    const { result } = renderHook(() => useChatSearch('hit'));

    expect(result.current.isPending, 'before the debounce fires').toBe(true);
    await waitFor(() => expect(result.current.isPending).toBe(false));
  });

  it('truncates the text to the longest query the hub accepts instead of being refused', async () => {
    renderHook(() => useChatSearch('x'.repeat(CHAT_SEARCH_MAX_LENGTH + 20)));

    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(1));

    expect(searchedTerms()[0]?.length).toBe(CHAT_SEARCH_MAX_LENGTH);
  });

  it('pages the matches with the same cursor the list uses', async () => {
    mockList.mockImplementation(({ query }: { query: { cursor?: string } }) =>
      Promise.resolve(
        query.cursor ? page([chatNamed('older')]) : page([chatNamed('newer')], 'cursor-after-newer')
      )
    );
    const { result } = renderHook(() => useChatSearch('x'));
    await waitFor(() => expect(result.current.paging.hasMore).toBe(true));

    await act(async () => {
      await result.current.paging.loadMore();
    });

    await waitFor(() =>
      expect(result.current.chats.map((chat) => chat.id)).toEqual(['newer', 'older'])
    );
    expect(mockList.mock.calls[1]?.[0]).toMatchObject({
      query: { q: 'x', cursor: 'cursor-after-newer' },
    });
    expect(result.current.paging.hasMore).toBe(false);
  });

  it('reports a refused search as an error and keeps asking nothing more', async () => {
    mockList.mockResolvedValue({ data: null, error: { value: 'boom' } });
    const { result } = renderHook(() => useChatSearch('x'));

    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(result.current.isPending).toBe(false);
  });

  it('keeps the previous matches on screen while the next text is being searched', async () => {
    mockList.mockImplementation(({ query }: { query: { q: string } }) =>
      query.q === 'a' ? Promise.resolve(page([chatNamed('for-a')])) : new Promise(() => undefined)
    );
    const { result, rerender } = renderHook(({ text }) => useChatSearch(text), {
      initialProps: { text: 'a' },
    });
    await waitFor(() => expect(result.current.chats.map((chat) => chat.id)).toEqual(['for-a']));

    rerender({ text: 'ab' });

    expect(result.current.isPending).toBe(true);
    expect(result.current.chats.map((chat) => chat.id)).toEqual(['for-a']);
  });
});

describe('useChatDetailQuery', () => {
  beforeEach(() => {
    mockList.mockReset();
    mockGetById.mockReset();
  });

  it('reads the chat by id when enabled', async () => {
    mockGetById.mockResolvedValue({ data: chatNamed('deep', 'Deep chat'), error: null });
    const { result } = renderHook(() => useChatDetailQuery('deep', true));

    await waitFor(() => expect(result.current.data?.title).toBe('Deep chat'));

    expect(chatsEndpoint).toHaveBeenCalledWith({ id: 'deep' });
  });

  it('asks for nothing when disabled or without an id', async () => {
    renderHook(() => useChatDetailQuery('deep', false));
    renderHook(() => useChatDetailQuery(null, true));

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(mockGetById).not.toHaveBeenCalled();
  });

  it('shows the cached chat at once while it revalidates', () => {
    mockGetById.mockReturnValue(new Promise(() => undefined));
    const { result, rerender } = renderHook(
      ({ enabled }) => ({
        queryClient: useQueryClient(),
        detail: useChatDetailQuery('cached', enabled),
      }),
      { initialProps: { enabled: false } }
    );
    act(() => {
      result.current.queryClient.setQueryData(chatKeys.detail('cached'), chatNamed('cached'));
    });

    rerender({ enabled: true });

    expect(result.current.detail.data?.id).toBe('cached');
  });
});

describe('search caches follow chat mutations', () => {
  beforeEach(() => {
    mockList.mockReset();
    mockPut.mockReset();
    mockDelete.mockReset();
  });

  function seededSearch() {
    const { result } = renderHook(() => ({
      queryClient: useQueryClient(),
      update: useUpdateChatMutation(),
      remove: useDeleteChatMutation(),
    }));
    act(() => {
      result.current.queryClient.setQueryData(chatKeys.search('plan'), {
        pages: [
          { items: [chatNamed('c1', 'Plan A'), chatNamed('c2', 'Plan B')], nextCursor: null },
        ],
        pageParams: [null],
      });
    });
    const titles = () =>
      (
        result.current.queryClient.getQueryData(chatKeys.search('plan')) as {
          pages: { items: { id: string; title: string }[] }[];
        }
      ).pages.flatMap((entry) => entry.items.map((item) => `${item.id}:${item.title}`));
    return { result, titles };
  }

  it('shows a rename in a cached search without waiting for the refetch', async () => {
    mockPut.mockResolvedValue({ data: { success: true }, error: null });
    const { result, titles } = seededSearch();

    await act(async () => {
      await result.current.update.mutateAsync({ id: 'c1', updates: { title: 'Plan Z' } });
    });

    expect(titles()).toEqual(['c1:Plan Z', 'c2:Plan B']);
  });

  it('marks cached searches stale after a rename, since the title may stop matching', async () => {
    mockPut.mockResolvedValue({ data: { success: true }, error: null });
    const { result } = seededSearch();

    await act(async () => {
      await result.current.update.mutateAsync({ id: 'c1', updates: { title: 'Other' } });
    });

    expect(result.current.queryClient.getQueryState(chatKeys.search('plan'))?.isInvalidated).toBe(
      true
    );
  });

  it('drops a deleted chat from a cached search', async () => {
    mockDelete.mockResolvedValue({ data: { success: true }, error: null });
    const { result, titles } = seededSearch();

    await act(async () => {
      await result.current.remove.mutateAsync('c1');
    });

    expect(titles()).toEqual(['c2:Plan B']);
  });
});
