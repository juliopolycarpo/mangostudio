/**
 * Issue #948: a query that subscribes to a realtime topic was fetched once when
 * it mounted and again when the `subscribed` ack arrived, on every page load.
 * The ack is a staleness barrier, but only for data read before the subscribe
 * frame went out; a read taken after it has nothing left to catch up on.
 *
 * Each hook below is mounted against a fake realtime client that lets the test
 * pick the frame's `requestedAt` relative to the moment the query's data landed.
 */

import { beforeEach, describe, expect, it, jest, mock } from 'bun:test';

import { ACTIVITY_TOPIC, ENVIRONMENTS_TOPIC, SETTINGS_TOPIC } from '@mangostudio/shared/realtime';
import { type QueryClient, useQueryClient } from '@tanstack/react-query';

import type { RealtimeTopicListener } from '@/lib/realtime/realtime-client';

import type * as ApiClient from '../../../../src/lib/api-client';
import { act, renderHook, waitFor } from '../../../support/harness/render';
import { setTestSession } from '../../../support/setup/auth-client-stub';

interface Subscription {
  topic: string;
  listener: RealtimeTopicListener;
}

/** Named fake for the socket: records subscriptions so a test can deliver an ack. */
let subscriptions: Subscription[] = [];

void mock.module('@/lib/realtime/realtime-client', () => ({
  bindRealtimeClientToUser: jest.fn(),
  getRealtimeClient: () => ({
    subscribe: (topic: string, listener: RealtimeTopicListener) => {
      subscriptions.push({ topic, listener });
      return jest.fn();
    },
  }),
}));

const fakeHub = {
  listEnvironments: jest.fn(),
  listToolIdentities: jest.fn(),
  listActivity: jest.fn(),
};

// Eden Treaty's generic types are too strict for jest.fn() mocks, so the
// factory is cast via unknown.
void mock.module('../../../../src/lib/api-client', () => ({
  client: {
    api: {
      environments: Object.assign(jest.fn(), { get: fakeHub.listEnvironments }),
      'tool-identities': Object.assign(jest.fn(), { get: fakeHub.listToolIdentities }),
    },
  } as unknown as typeof ApiClient.client,
}));

void mock.module('@/services/activity-service', () => ({
  listActivity: fakeHub.listActivity,
}));

// Static imports are evaluated before any statement above runs, so the hooks
// come in afterwards or they bind the real modules.
const { useActivity } = await import('@/features/activity/useActivity');
const { useToolIdentities } = await import('@/features/environments/identity/use-tool-identities');
const { useEnvironmentEntitiesQuery, environmentKeys } =
  await import('@/features/environments/queries');
const { activityKeys } = await import('@/features/activity/queries');
const { toolIdentityKeys } = await import('@/features/environments/identity/queries');
const { resetRealtimeInvalidations } = await import('@/lib/realtime/use-realtime-invalidation');

interface Surface {
  readonly name: string;
  readonly topic: string;
  readonly fetches: () => number;
  readonly queryKey: readonly unknown[];
  /** Mounts the hook under test and returns the query client it runs on. */
  readonly mount: () => { result: { current: { client: QueryClient } } };
}

const surfaces: Surface[] = [
  {
    name: 'activity feed',
    topic: ACTIVITY_TOPIC,
    fetches: () => fakeHub.listActivity.mock.calls.length,
    queryKey: activityKeys.all,
    mount: () =>
      renderHook(() => {
        useActivity();
        return { client: useQueryClient() };
      }),
  },
  {
    name: 'tool identities',
    topic: SETTINGS_TOPIC,
    fetches: () => fakeHub.listToolIdentities.mock.calls.length,
    queryKey: toolIdentityKeys.all,
    mount: () =>
      renderHook(() => {
        useToolIdentities();
        return { client: useQueryClient() };
      }),
  },
  {
    name: 'environment entities',
    topic: ENVIRONMENTS_TOPIC,
    fetches: () => fakeHub.listEnvironments.mock.calls.length,
    queryKey: environmentKeys.entities(),
    mount: () =>
      renderHook(() => {
        useEnvironmentEntitiesQuery();
        return { client: useQueryClient() };
      }),
  },
];

function subscriptionFor(topic: string): Subscription {
  const subscription = subscriptions.find((entry) => entry.topic === topic);
  if (!subscription) throw new Error(`expected a ${topic} subscription | received none`);
  return subscription;
}

describe('subscribed ack after the first read', () => {
  beforeEach(() => {
    setTestSession({ user: { id: 'user-test' } });
    resetRealtimeInvalidations();
    subscriptions = [];
    fakeHub.listEnvironments.mockReset().mockResolvedValue({ data: [], error: null });
    fakeHub.listToolIdentities
      .mockReset()
      .mockResolvedValue({ data: { identities: {} }, error: null });
    fakeHub.listActivity.mockReset().mockResolvedValue({ events: [], nextCursor: null });
  });

  for (const surface of surfaces) {
    describe(surface.name, () => {
      it('is fetched once when its data landed after the subscribe frame was sent', async () => {
        const { result } = surface.mount();
        await waitFor(() => expect(surface.fetches()).toBe(1));
        const dataUpdatedAt = await settledDataUpdatedAt(result.current.client, surface.queryKey);

        await act(async () => {
          await subscriptionFor(surface.topic).listener({
            type: 'subscribed',
            requestedAt: dataUpdatedAt - 1,
          });
        });

        expect(
          surface.fetches(),
          `(${surface.name}): expected requests after an ack for a read taken after the frame: 1 | received: ${surface.fetches()}`
        ).toBe(1);
      });

      it('is fetched again when a write could fall between its read and the ack', async () => {
        const { result } = surface.mount();
        await waitFor(() => expect(surface.fetches()).toBe(1));
        const dataUpdatedAt = await settledDataUpdatedAt(result.current.client, surface.queryKey);

        await act(async () => {
          await subscriptionFor(surface.topic).listener({
            type: 'subscribed',
            requestedAt: dataUpdatedAt + 1,
          });
        });

        await waitFor(() => expect(surface.fetches()).toBe(2));
      });

      it('is fetched again by an ack that carries no send time', async () => {
        const { result } = surface.mount();
        await waitFor(() => expect(surface.fetches()).toBe(1));
        await settledDataUpdatedAt(result.current.client, surface.queryKey);

        await act(async () => {
          await subscriptionFor(surface.topic).listener({ type: 'subscribed' });
        });

        await waitFor(() => expect(surface.fetches()).toBe(2));
      });

      it('is fetched again by an invalidate frame whatever the read time', async () => {
        const { result } = surface.mount();
        await waitFor(() => expect(surface.fetches()).toBe(1));
        await settledDataUpdatedAt(result.current.client, surface.queryKey);

        await act(async () => {
          await subscriptionFor(surface.topic).listener({
            type: 'invalidate',
            message: { type: 'invalidate', topic: surface.topic },
          });
        });

        await waitFor(() => expect(surface.fetches()).toBe(2));
      });
    });
  }
});

/** Waits for the query to hold data and returns when that data landed. */
async function settledDataUpdatedAt(
  queryClient: QueryClient,
  queryKey: readonly unknown[]
): Promise<number> {
  let dataUpdatedAt = 0;
  await waitFor(() => {
    const [query] = queryClient.getQueryCache().findAll({ queryKey });
    dataUpdatedAt = query?.state.dataUpdatedAt ?? 0;
    expect(dataUpdatedAt).toBeGreaterThan(0);
  });
  return dataUpdatedAt;
}
