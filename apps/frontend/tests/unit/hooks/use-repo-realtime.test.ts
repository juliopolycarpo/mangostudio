/**
 * The sidebar's liveness path for git badges: a write made from one chat, or from
 * a linked worktree of the same repository, reaches the other rows only through
 * the `repo:<key>` topic. Each test drives the real `useBatchedGitSummaries` and
 * `useRepoRealtimeInvalidation` over a real QueryClient, with the realtime client
 * and the batch endpoint faked, and counts the requests the frames cost.
 */

import { beforeEach, describe, expect, it, jest, mock, setSystemTime } from 'bun:test';

import type { GitBatchStateRequest, GitSummary } from '@mangostudio/shared/git';
import {
  type GitScope,
  MAX_REALTIME_TOPICS_PER_MESSAGE,
  repoTopic,
} from '@mangostudio/shared/realtime';

import type { RealtimeSignal, RealtimeTopicListener } from '@/lib/realtime/realtime-client';

import type * as ApiClient from '../../../src/lib/api-client';
import { act, flushAsyncRender, renderHook, waitFor } from '../../support/harness/render';
import { setTestSession } from '../../support/setup/auth-client-stub';

/** What a hook asked the socket for, and the release it must eventually call. */
class FakeRealtimeSocket {
  readonly listeners = new Map<string, RealtimeTopicListener>();
  readonly released: string[] = [];

  subscribe = (topic: string, listener: RealtimeTopicListener) => {
    this.listeners.set(topic, listener);
    return () => {
      this.released.push(topic);
      if (this.listeners.get(topic) === listener) this.listeners.delete(topic);
    };
  };

  get topics(): string[] {
    return [...this.listeners.keys()].sort();
  }

  async deliver(topic: string, signal: RealtimeSignal): Promise<void> {
    const listener = this.listeners.get(topic);
    if (!listener) throw new Error(`(FakeRealtimeSocket): expected a listener on ${topic}`);
    await act(async () => {
      await listener(signal);
    });
  }

  /** Frames that reach the tab back to back: none is awaited before the next arrives. */
  async deliverBurst(topic: string, writes: ReadonlyArray<ReadonlyArray<GitScope>>) {
    const listener = this.listeners.get(topic);
    if (!listener) throw new Error(`(FakeRealtimeSocket): expected a listener on ${topic}`);
    await act(async () => {
      await Promise.all(
        writes.map((scopes) =>
          listener({
            type: 'invalidate',
            message: { type: 'invalidate', topic, scopes: [...scopes] },
          })
        )
      );
    });
  }

  async deliverWrite(
    topic: string,
    scopes: ReadonlyArray<'state' | 'github' | 'branches'> = ['state']
  ) {
    await this.deliver(topic, {
      type: 'invalidate',
      message: { type: 'invalidate', topic, scopes: [...scopes] },
    });
  }
}

const socket = new FakeRealtimeSocket();

void mock.module('@/lib/realtime/realtime-client', () => ({
  bindRealtimeClientToUser: jest.fn(),
  getRealtimeClient: () => ({ subscribe: socket.subscribe }),
}));

const mockBatch = jest.fn();

void mock.module('@/lib/api-client', () => ({
  client: {
    api: { git: { state: { batch: { post: mockBatch } } } },
  } as unknown as typeof ApiClient,
}));

// Static imports are evaluated before any statement above runs, so the hooks
// under test have to come in afterwards or they bind the real modules.
const { useBatchedGitSummaries, useRepoRealtimeInvalidation } =
  await import('@/features/workspace/hooks/use-git-state');
const { resetRealtimeInvalidations } = await import('@/lib/realtime/use-realtime-invalidation');

/** Which repository each chat sits in; a chat absent here has no key (older hub). */
let repoKeyByChat: Record<string, string | undefined> = {};

function summaryFor(chatId: string): GitSummary {
  const repoKey = repoKeyByChat[chatId];
  return {
    branch: 'main',
    ahead: 0,
    behind: 0,
    changedFileCount: 1,
    workdir: `/work/${chatId}`,
    ...(repoKey === undefined ? {} : { repoKey }),
  };
}

function respondPerRequest() {
  // eslint-disable-next-line @typescript-eslint/require-await -- The fake keeps the async shape of the endpoint.
  mockBatch.mockImplementation(async ({ chatIds }: GitBatchStateRequest) => ({
    data: { states: Object.fromEntries(chatIds.map((chatId) => [chatId, summaryFor(chatId)])) },
    error: null,
  }));
}

/** Both hooks the shell mounts, over the rows it reports in view. */
function useShellBadges(chatIdsInView: readonly string[]) {
  const summaries = useBatchedGitSummaries(chatIdsInView, { includeCached: true });
  useRepoRealtimeInvalidation(chatIdsInView, summaries);
  return summaries;
}

function batchedIds(call: number): string[] {
  return [...((mockBatch.mock.calls[call]?.[0] as GitBatchStateRequest).chatIds as string[])];
}

const SHARED_REPO = 'sharedRepoKey';
const OTHER_REPO = 'otherRepoKey';

async function mountSidebar(chatIds: readonly string[]) {
  const mounted = renderHook(({ ids }) => useShellBadges(ids), { initialProps: { ids: chatIds } });
  await flushAsyncRender();
  await waitFor(() => expect(Object.keys(mounted.result.current)).toHaveLength(chatIds.length));
  return mounted;
}

describe('sidebar repo realtime invalidation', () => {
  beforeEach(() => {
    setTestSession({ user: { id: 'user-test' } });
    resetRealtimeInvalidations();
    socket.listeners.clear();
    socket.released.length = 0;
    mockBatch.mockReset();
    setSystemTime();
    repoKeyByChat = {};
    respondPerRequest();
  });

  it('subscribes one repo topic per repository in view, not one per chat', async () => {
    repoKeyByChat = { a: SHARED_REPO, b: SHARED_REPO, c: SHARED_REPO, d: OTHER_REPO };

    await mountSidebar(['a', 'b', 'c', 'd']);

    expect(socket.topics).toEqual([repoTopic(OTHER_REPO), repoTopic(SHARED_REPO)]);
  });

  it('subscribes to nothing when the hub issued no repo key', async () => {
    // An older hub: the badges still load and the sidebar keeps its focus refresh.
    await mountSidebar(['a', 'b']);

    expect(socket.topics).toEqual([]);
  });

  it('refreshes a sibling chat of the same repository, and no chat of another one', async () => {
    repoKeyByChat = { a: SHARED_REPO, b: SHARED_REPO, c: OTHER_REPO };
    await mountSidebar(['a', 'b', 'c']);
    expect(mockBatch).toHaveBeenCalledTimes(1);
    mockBatch.mockClear();

    // A commit made from chat A's checkout: the frame carries no chat id, and
    // chat B hears of it only because it shares the repository.
    await socket.deliverWrite(repoTopic(SHARED_REPO));

    await waitFor(() => expect(mockBatch).toHaveBeenCalledTimes(1));
    expect(batchedIds(0)).toEqual(['a', 'b']);
  });

  it('costs one batched request for every chat in the repository, not one per chat', async () => {
    const chatIds = Array.from(
      { length: 40 },
      (_, index) => `chat-${String(index).padStart(2, '0')}`
    );
    repoKeyByChat = Object.fromEntries(chatIds.map((chatId) => [chatId, SHARED_REPO]));
    await mountSidebar(chatIds);
    mockBatch.mockClear();

    await socket.deliverWrite(repoTopic(SHARED_REPO), ['state', 'github']);

    await waitFor(() => expect(mockBatch).toHaveBeenCalled());
    await flushAsyncRender();
    const requests = mockBatch.mock.calls.length;
    expect(
      requests,
      `(git badges): expected 1 POST /git/state/batch for ${chatIds.length} chats in one repo | received: ${requests}`
    ).toBe(1);
    expect(batchedIds(0)).toHaveLength(chatIds.length);
  });

  it('folds a burst of frames for one write into one refetch', async () => {
    repoKeyByChat = { a: SHARED_REPO, b: SHARED_REPO };
    await mountSidebar(['a', 'b']);
    mockBatch.mockClear();

    // Frames that reach the tab back to back, as the hub publishes the writes of
    // one request, are delivered without waiting on each other.
    await socket.deliverBurst(repoTopic(SHARED_REPO), [
      ['state'],
      ['branches'],
      ['state', 'github'],
    ]);

    await waitFor(() => expect(mockBatch).toHaveBeenCalled());
    await flushAsyncRender();
    expect(mockBatch).toHaveBeenCalledTimes(1);
  });

  it('refetches nothing for a scope that does not touch the badge', async () => {
    repoKeyByChat = { a: SHARED_REPO, b: SHARED_REPO };
    await mountSidebar(['a', 'b']);
    mockBatch.mockClear();

    await socket.deliverWrite(repoTopic(SHARED_REPO), ['github']);
    await Bun.sleep(100);

    expect(mockBatch).not.toHaveBeenCalled();
  });

  it('does not refetch badges that were read moments before the subscription was acked', async () => {
    repoKeyByChat = { a: SHARED_REPO, b: SHARED_REPO };
    await mountSidebar(['a', 'b']);
    mockBatch.mockClear();

    await socket.deliver(repoTopic(SHARED_REPO), { type: 'subscribed' });
    await Bun.sleep(100);

    expect(mockBatch).not.toHaveBeenCalled();
  });

  it('refetches badges older than the subscription when it is acked again after a reconnect', async () => {
    repoKeyByChat = { a: SHARED_REPO, b: SHARED_REPO };
    await mountSidebar(['a', 'b']);
    mockBatch.mockClear();

    // The socket was down for a while: whatever happened meanwhile was lost.
    setSystemTime(new Date(Date.now() + 60_000));
    await socket.deliver(repoTopic(SHARED_REPO), { type: 'subscribed' });

    await waitFor(() => expect(mockBatch).toHaveBeenCalledTimes(1));
    expect(batchedIds(0)).toEqual(['a', 'b']);
  });

  it('releases a repository topic when its last row leaves the view', async () => {
    repoKeyByChat = { a: SHARED_REPO, b: OTHER_REPO };
    const { rerender } = await mountSidebar(['a', 'b']);
    expect(socket.topics).toEqual([repoTopic(OTHER_REPO), repoTopic(SHARED_REPO)]);

    rerender({ ids: ['a'] });
    await flushAsyncRender();

    expect(socket.topics).toEqual([repoTopic(SHARED_REPO)]);
    expect(socket.released).toContain(repoTopic(OTHER_REPO));
  });

  it('keeps a repository topic subscribed while any of its rows stays in view', async () => {
    repoKeyByChat = { a: SHARED_REPO, b: SHARED_REPO };
    const { rerender } = await mountSidebar(['a', 'b']);

    rerender({ ids: ['b'] });
    await flushAsyncRender();

    expect(socket.topics).toEqual([repoTopic(SHARED_REPO)]);
  });

  it('bounds the subscriptions to one frame of topics however many repositories are in view', async () => {
    const chatIds = Array.from(
      { length: 50 },
      (_, index) => `chat-${String(index).padStart(2, '0')}`
    );
    repoKeyByChat = Object.fromEntries(chatIds.map((chatId, index) => [chatId, `repo${index}`]));

    await mountSidebar(chatIds);

    expect(socket.topics).toHaveLength(MAX_REALTIME_TOPICS_PER_MESSAGE);
    // The nearest rows win: the first rows in the list are the ones subscribed.
    expect(socket.topics).toContain(repoTopic('repo0'));
    expect(socket.topics).not.toContain(repoTopic('repo49'));
  });
});
