/**
 * The chat list's liveness path: a turn finishing in another tab reaches this
 * one only through the activity topic, so the query must go stale on its
 * signals. The server half of the contract — recording `chat_created` or
 * `turn_completed` publishes an `activity` invalidation frame — is pinned by
 * `apps/api/tests/integration/routes/activity.integration.test.ts`.
 */

import { beforeEach, describe, expect, it, jest, mock } from 'bun:test';
import { ACTIVITY_TOPIC } from '@mangostudio/shared/realtime';
import { createMockChat } from '@mangostudio/shared/test-utils';
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
mock.module('@/lib/realtime/realtime-client', () => ({
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
mock.module('../../../src/lib/api-client', () => ({
  client: {
    api: { chats: Object.assign(jest.fn(), { get: mockGet }) },
  } as unknown as typeof ApiClient,
}));

// Static imports are evaluated before any statement above runs, so the module
// under test has to come in afterwards or it binds the real modules.
const { useChatsQuery } = await import('../../../src/features/chat/queries');
const { resetRealtimeInvalidations } = await import('@/lib/realtime/use-realtime-invalidation');

function activitySubscription(): Subscription {
  const subscription = subscriptions.find((entry) => entry.topic === ACTIVITY_TOPIC);
  if (!subscription) throw new Error('No activity subscription was recorded');
  return subscription;
}

describe('useChatsQuery realtime invalidation', () => {
  beforeEach(() => {
    setTestSession({ user: { id: 'user-test' } });
    // Subscriptions are shared per (topic, concern) in module state, so a hook
    // left mounted by an earlier test would otherwise be reused by this one.
    resetRealtimeInvalidations();
    subscriptions = [];
    mockGet.mockClear();
    mockGet.mockResolvedValue({
      data: [createMockChat({ id: 'chat-1', title: 'Chat', createdAt: 1, updatedAt: 1 })],
      error: null,
    });
  });

  it('subscribes to the activity topic on mount', async () => {
    const { result } = renderHook(() => useChatsQuery());
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(subscriptions.map((entry) => entry.topic)).toContain(ACTIVITY_TOPIC);
  });

  it('refetches the chat list when an activity frame arrives', async () => {
    const { result } = renderHook(() => useChatsQuery());
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const fetchesBefore = mockGet.mock.calls.length;

    await act(async () => {
      await activitySubscription().listener({
        type: 'invalidate',
        message: { type: 'invalidate', topic: ACTIVITY_TOPIC },
      });
    });

    // Invalidation with a mounted observer refetches immediately — the row a
    // background turn just changed, not merely a stale flag for later.
    await waitFor(() => expect(mockGet.mock.calls.length).toBe(fetchesBefore + 1));
  });

  it('treats the subscribed ack as a staleness barrier after a reconnect', async () => {
    const { result } = renderHook(() => useChatsQuery());
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const fetchesBefore = mockGet.mock.calls.length;

    // Events published while the socket was down are lost by design, so the
    // ack itself must refresh anything cached for the topic.
    await act(async () => {
      await activitySubscription().listener({ type: 'subscribed' });
    });

    await waitFor(() => expect(mockGet.mock.calls.length).toBe(fetchesBefore + 1));
  });
});
