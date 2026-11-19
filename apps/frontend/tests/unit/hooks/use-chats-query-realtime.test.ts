/**
 * The chat list's liveness path: a turn finishing in another tab reaches this
 * one only through the chats topic, so the query must go stale on its signals
 * and on nobody else's. The server half of the contract — every writer that
 * moves `chats.updatedAt` or creates a chat publishes a `chats` frame — is
 * pinned by the API tests that install a recording realtime bus.
 */

import { beforeEach, describe, expect, it, jest, mock } from 'bun:test';

import { ACTIVITY_TOPIC, CHATS_TOPIC } from '@mangostudio/shared/realtime';
import { createMockChat } from '@mangostudio/shared/test-utils';
import { useQueryClient } from '@tanstack/react-query';

import type { RealtimeTopicListener } from '@/lib/realtime/realtime-client';

import type * as ApiClient from '../../../src/lib/api-client';
import { act, renderHook, waitFor } from '../../support/harness/render';
import { setTestSession } from '../../support/setup/auth-client-stub';

interface Subscription {
  topic: string;
  listener: RealtimeTopicListener;
}

let subscriptions: Subscription[] = [];

// The seam is the client module, not the WebSocket global.
void mock.module('@/lib/realtime/realtime-client', () => ({
  bindRealtimeClientToUser: jest.fn(),
  getRealtimeClient: () => ({
    subscribe: (topic: string, listener: RealtimeTopicListener) => {
      subscriptions.push({ topic, listener });
      return jest.fn();
    },
  }),
}));

const mockGet = jest.fn();

// Eden Treaty's generic types are too strict for jest.fn() mocks, so the
// factory is cast via unknown.
void mock.module('../../../src/lib/api-client', () => ({
  client: {
    api: { chats: Object.assign(jest.fn(), { get: mockGet }) },
  } as unknown as typeof ApiClient.client,
}));

// Static imports are evaluated before any statement above runs, so the module
// under test has to come in afterwards or it binds the real modules.
const { chatKeys, useChatsQuery } = await import('../../../src/features/chat/queries');
const { resetRealtimeInvalidations } = await import('@/lib/realtime/use-realtime-invalidation');

const chatNamed = (id: string) => createMockChat({ id, title: id, createdAt: 1, updatedAt: 1 });

/** The Eden answer for a list that fits in one page. */
function onePage() {
  return { data: { items: [chatNamed('chat-1')], nextCursor: null }, error: null };
}

function subscriptionFor(topic: string): Subscription {
  const subscription = subscriptions.find((entry) => entry.topic === topic);
  if (!subscription) throw new Error(`No ${topic} subscription was recorded`);
  return subscription;
}

/** Delivers one invalidate frame to every listener the way the socket does. */
async function deliverFrame(topic: typeof ACTIVITY_TOPIC | typeof CHATS_TOPIC): Promise<void> {
  for (const subscription of subscriptions.filter((entry) => entry.topic === topic)) {
    await act(async () => {
      await subscription.listener({
        type: 'invalidate',
        message: { type: 'invalidate', topic },
      });
    });
  }
}

describe('useChatsQuery realtime invalidation', () => {
  beforeEach(() => {
    setTestSession({ user: { id: 'user-test' } });
    // Subscriptions are shared per (topic, concern) in module state, so a hook
    // left mounted by an earlier test would otherwise be reused by this one.
    resetRealtimeInvalidations();
    subscriptions = [];
    mockGet.mockClear();
    mockGet.mockResolvedValue(onePage());
  });

  it('subscribes to the chats topic on mount, and not to the activity topic', async () => {
    const { result } = renderHook(() => useChatsQuery());
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(subscriptions.map((entry) => entry.topic)).toEqual([CHATS_TOPIC]);
  });

  it('refetches the chat list when a chats frame arrives', async () => {
    const { result } = renderHook(() => useChatsQuery());
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const fetchesBefore = mockGet.mock.calls.length;

    await deliverFrame(CHATS_TOPIC);

    // Invalidation with a mounted observer refetches immediately — the row a
    // background turn just changed, not merely a stale flag for later.
    await waitFor(() => expect(mockGet.mock.calls.length).toBe(fetchesBefore + 1));
  });

  it('also marks a cached search and a chat read by id stale on a chats frame', async () => {
    const { result } = renderHook(() => ({ list: useChatsQuery(), queryClient: useQueryClient() }));
    await waitFor(() => expect(result.current.list.isSuccess).toBe(true));
    act(() => {
      result.current.queryClient.setQueryData(chatKeys.search('plan'), {
        pages: [],
        pageParams: [],
      });
      result.current.queryClient.setQueryData(chatKeys.detail('chat-9'), chatNamed('chat-9'));
    });

    await deliverFrame(CHATS_TOPIC);

    const stale = (key: readonly unknown[]) =>
      result.current.queryClient.getQueryState(key)?.isInvalidated;
    expect(
      { search: stale(chatKeys.search('plan')), detail: stale(chatKeys.detail('chat-9')) },
      '(chats frame): expected search and detail invalidated: true | received'
    ).toEqual({ search: true, detail: true });
  });

  it('does not refetch the chat list when an activity frame arrives', async () => {
    const { result } = renderHook(() => useChatsQuery());
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const fetchesBefore = mockGet.mock.calls.length;

    // A feed row that is not a chat change (a commit, a quota refresh) must not
    // cost the list a GET /chats that returns what the tab already has.
    await deliverFrame(ACTIVITY_TOPIC);

    expect(mockGet.mock.calls.length).toBe(fetchesBefore);
  });

  it('treats the subscribed ack as a staleness barrier after a reconnect', async () => {
    const { result } = renderHook(() => useChatsQuery());
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const fetchesBefore = mockGet.mock.calls.length;

    // Events published while the socket was down are lost by design, so the
    // ack itself must refresh anything cached for the topic.
    await act(async () => {
      await subscriptionFor(CHATS_TOPIC).listener({ type: 'subscribed' });
    });

    await waitFor(() => expect(mockGet.mock.calls.length).toBe(fetchesBefore + 1));
  });
});

describe('useChatsQuery with several pages loaded', () => {
  /** Two pages behind one cursor; `bumped` is what the server answers after a chat moved. */
  function twoPagedHub(state: { bumped: boolean }) {
    mockGet.mockImplementation(({ query }: { query: { limit: number; cursor?: string } }) => {
      if (query.cursor === 'after-page-1') {
        return Promise.resolve({
          data: { items: [chatNamed('chat-3'), chatNamed('chat-4')], nextCursor: null },
          error: null,
        });
      }
      const first = state.bumped ? ['chat-3', 'chat-1'] : ['chat-1', 'chat-2'];
      return Promise.resolve({
        data: { items: first.map(chatNamed), nextCursor: 'after-page-1' },
        error: null,
      });
    });
  }

  beforeEach(() => {
    setTestSession({ user: { id: 'user-test' } });
    resetRealtimeInvalidations();
    subscriptions = [];
    mockGet.mockReset();
  });

  it('loads the next page behind the cursor the previous one handed back', async () => {
    twoPagedHub({ bumped: false });
    const { result } = renderHook(() => useChatsQuery());
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.hasNextPage).toBe(true);

    await act(async () => {
      await result.current.fetchNextPage();
    });

    await waitFor(() =>
      expect(result.current.data?.map((chat) => chat.id)).toEqual([
        'chat-1',
        'chat-2',
        'chat-3',
        'chat-4',
      ])
    );
    expect(result.current.hasNextPage).toBe(false);
    expect(mockGet.mock.calls.map(([arg]) => arg)).toEqual([
      { query: { limit: 50 } },
      { query: { limit: 50, cursor: 'after-page-1' } },
    ]);
  });

  it('re-reads every loaded page on a chats frame and lists a bumped chat once, newest first', async () => {
    const hub = { bumped: false };
    twoPagedHub(hub);
    const { result } = renderHook(() => useChatsQuery());
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.hasNextPage).toBe(true);
    await act(async () => {
      await result.current.fetchNextPage();
    });
    await waitFor(() => expect(result.current.data).toHaveLength(4));
    mockGet.mockClear();

    // chat-3 was on page two; a turn moved it to the head, ahead of chat-1.
    hub.bumped = true;
    await deliverFrame(CHATS_TOPIC);

    // The refetched first page now ends in chat-1 and the second page still
    // carries chat-3; the flat list must show chat-3 once, at its new place.
    await waitFor(() =>
      expect(result.current.data?.map((chat) => chat.id)).toEqual(['chat-3', 'chat-1', 'chat-4'])
    );
    expect(mockGet.mock.calls).toHaveLength(2);
  });
});

/**
 * One streaming turn as the hub publishes it, in order. Deltas travel over the
 * turn's own SSE response and publish nothing on the realtime socket, so the
 * frames are the side effects: tools that commit or push add feed rows
 * (`activity`), an external agent's usage refresh adds one more, and the turn's
 * finalizer moves the chat (`chats`) and records `turn_completed` (`activity`).
 *
 * The same script, subscribed through the old arrangement where the list
 * listened on `activity`, refetches once per activity frame. Pinning the count
 * here is the regression test for that cost.
 */
const STREAMING_TURN_FRAMES: ReadonlyArray<{
  readonly after: string;
  readonly topic: typeof ACTIVITY_TOPIC | typeof CHATS_TOPIC;
}> = [
  { after: 'tool 2: git commit', topic: ACTIVITY_TOPIC },
  { after: 'tool 3: git commit', topic: ACTIVITY_TOPIC },
  { after: 'tool 4: git push', topic: ACTIVITY_TOPIC },
  { after: 'tool 5: external usage refresh', topic: ACTIVITY_TOPIC },
  { after: 'finalize: chat moved', topic: CHATS_TOPIC },
  { after: 'finalize: turn_completed row', topic: ACTIVITY_TOPIC },
];

describe('useChatsQuery during a streaming turn', () => {
  beforeEach(() => {
    setTestSession({ user: { id: 'user-test' } });
    resetRealtimeInvalidations();
    subscriptions = [];
    mockGet.mockClear();
    mockGet.mockResolvedValue(onePage());
  });

  it('refetches once for the turn that moved the chat, not once per activity frame', async () => {
    const { result } = renderHook(() => useChatsQuery());
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const initialFetches = mockGet.mock.calls.length;

    // The turn's text deltas and tool events travel over its SSE response, so
    // the socket carries none of them. Only the frames above reach the query
    // client, and each is awaited the way spaced-out frames in a real turn are.
    for (const frame of STREAMING_TURN_FRAMES) {
      await deliverFrame(frame.topic);
    }

    const listRefetches = mockGet.mock.calls.length - initialFetches;
    const chatFrames = STREAMING_TURN_FRAMES.filter((frame) => frame.topic === CHATS_TOPIC);
    expect(
      listRefetches,
      `(chat-list): expected one GET /chats per chats frame: ${chatFrames.length} | received: ${listRefetches} across ${STREAMING_TURN_FRAMES.length} frames`
    ).toBe(chatFrames.length);
  });
});
