import { beforeEach, describe, expect, it, jest, mock } from 'bun:test';
import type { GitBatchStateRequest, GitSummary } from '@mangostudio/shared/git';
import { useQuery } from '@tanstack/react-query';
import type * as ApiClient from '@/lib/api-client';
import { act, renderHook, waitFor } from '../../support/harness/render';

const mockBatch = jest.fn();
const mockCommit = jest.fn();

mock.module('@/lib/api-client', () => ({
  client: {
    api: {
      git: {
        state: { batch: { post: mockBatch } },
        commit: { post: mockCommit },
      },
    },
  } as unknown as typeof ApiClient,
}));

// Static imports are evaluated before any statement above runs, so the hooks
// under test have to come in afterwards or they bind the real api-client.
const { useBatchedGitSummaries, useCommit } = await import(
  '@/features/workspace/hooks/use-git-state'
);

function summaryFor(chatId: string): GitSummary {
  return {
    branch: `branch-${chatId}`,
    ahead: 1,
    behind: 0,
    changedFileCount: 3,
    workdir: `/repo/${chatId}`,
  };
}

function respondPerRequest() {
  // The server omits chats it has no answer for instead of sending null.
  mockBatch.mockImplementation(async ({ chatIds }: GitBatchStateRequest) => ({
    data: {
      states: Object.fromEntries(
        chatIds
          .filter((chatId) => !chatId.startsWith('null-'))
          .map((chatId) => [chatId, summaryFor(chatId)])
      ),
    },
    error: null,
  }));
}

describe('useBatchedGitSummaries', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('fetches one batch for the visible rows and exposes a chat-keyed map', async () => {
    respondPerRequest();

    const { result } = renderHook(() => useBatchedGitSummaries(['b', 'a', 'null-c']));

    await waitFor(() => expect(Object.keys(result.current)).toHaveLength(3));
    expect(mockBatch).toHaveBeenCalledTimes(1);
    expect(mockBatch).toHaveBeenCalledWith({ chatIds: ['a', 'b', 'null-c'] });
    expect(result.current.a).toEqual(summaryFor('a'));
    expect(result.current.b).toEqual(summaryFor('b'));
    expect(result.current['null-c']).toBeNull();
  });

  it('chunks past the batch limit and merges the responses', async () => {
    respondPerRequest();
    const chatIds = Array.from(
      { length: 60 },
      (_, index) => `chat-${String(index).padStart(2, '0')}`
    );

    const { result } = renderHook(() => useBatchedGitSummaries(chatIds));

    await waitFor(() => expect(Object.keys(result.current)).toHaveLength(60));
    expect(mockBatch).toHaveBeenCalledTimes(2);
    const requested = mockBatch.mock.calls.map(
      (call) => (call[0] as GitBatchStateRequest).chatIds.length
    );
    expect(requested.sort((a, b) => b - a)).toEqual([50, 10]);
    expect(result.current['chat-59']).toEqual(summaryFor('chat-59'));
  });

  it('returns the same record when a caller re-renders with a fresh array of the same ids', async () => {
    respondPerRequest();

    const { result, rerender } = renderHook(
      ({ chatIds }: { chatIds: string[] }) => useBatchedGitSummaries(chatIds),
      { initialProps: { chatIds: ['b', 'a'] } }
    );

    await waitFor(() => expect(Object.keys(result.current)).toHaveLength(2));
    const first = result.current;

    // Pins the outcome the `combine` comment depends on: `useQueries` only
    // shares its combined result structurally while the combine function is
    // stable and the result is a plain object, and a Map or an inline arrow
    // silently gives that up. Losing it re-renders every badge row on a layout
    // that re-renders once per streamed token.
    rerender({ chatIds: ['a', 'b'] });
    rerender({ chatIds: ['b', 'a'] });

    expect(result.current).toBe(first);
    expect(mockBatch).toHaveBeenCalledTimes(1);
  });

  it('does not re-sort the ids when the caller keeps its array', async () => {
    respondPerRequest();
    let reads = 0;
    // Dedupe reads the array through its iterator, so counting those counts the
    // work the memo is there to skip.
    const chatIds = new Proxy(['b', 'a'], {
      get(target, key, receiver) {
        if (key === Symbol.iterator) reads += 1;
        return Reflect.get(target, key, receiver);
      },
    });

    const { result, rerender } = renderHook(
      ({ ids }: { ids: readonly string[] }) => useBatchedGitSummaries(ids),
      { initialProps: { ids: chatIds as readonly string[] } }
    );

    await waitFor(() => expect(Object.keys(result.current)).toHaveLength(2));
    const settled = reads;
    rerender({ ids: chatIds });
    rerender({ ids: chatIds });

    expect(reads).toBe(settled);
  });

  it('fetches again once the id list really changes', async () => {
    respondPerRequest();

    const { result, rerender } = renderHook(
      ({ chatIds }: { chatIds: string[] }) => useBatchedGitSummaries(chatIds),
      { initialProps: { chatIds: ['a'] } }
    );

    await waitFor(() => expect(result.current.a).toEqual(summaryFor('a')));
    rerender({ chatIds: ['a', 'b'] });

    await waitFor(() => expect(result.current.b).toEqual(summaryFor('b')));
    expect(mockBatch).toHaveBeenLastCalledWith({ chatIds: ['a', 'b'] });
  });

  it('resolves a failed chunk to null instead of a permanent pending state', async () => {
    mockBatch.mockResolvedValue({ data: null, error: { value: { error: 'boom' } } });

    const { result } = renderHook(() => useBatchedGitSummaries(['chat-1', 'chat-2']));

    await waitFor(() => expect(Object.keys(result.current)).toHaveLength(2));
    expect(result.current['chat-1']).toBeNull();
    expect(result.current['chat-2']).toBeNull();
  });

  it('does not fetch for an empty list', () => {
    const { result } = renderHook(() => useBatchedGitSummaries([]));
    expect(mockBatch).not.toHaveBeenCalled();
    expect(Object.keys(result.current)).toHaveLength(0);
  });

  it('refetches only the chunk containing a chat when a git write invalidates it', async () => {
    respondPerRequest();
    mockCommit.mockResolvedValue({ data: { hash: 'abc123', subject: 'feat' }, error: null });
    const otherChunkSpy = jest.fn(async () => ({ states: { unrelated: null } }));

    const { result } = renderHook(() => {
      // A second, already-populated chunk that must survive the invalidation.
      useQuery({
        queryKey: ['git-summaries', ['unrelated']],
        queryFn: otherChunkSpy,
        initialData: { states: { unrelated: null } },
        staleTime: Number.POSITIVE_INFINITY,
      });
      const summaries = useBatchedGitSummaries(['chat-1']);
      return { summaries, commit: useCommit('chat-1') };
    });

    await waitFor(() => expect(result.current.summaries['chat-1']).toEqual(summaryFor('chat-1')));
    expect(mockBatch).toHaveBeenCalledTimes(1);

    await act(async () => {
      await result.current.commit.mutateAsync({ title: 'feat: land' });
    });

    await waitFor(() => expect(mockBatch).toHaveBeenCalledTimes(2));
    expect(otherChunkSpy).not.toHaveBeenCalled();
  });
});
