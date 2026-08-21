/**
 * Unit tests for useChatsQuery chat mutation hooks.
 * Each test gets an isolated QueryClient via the render harness.
 */

import { beforeEach, describe, expect, it, jest, mock } from 'bun:test';
import type { Chat } from '@mangostudio/shared';
import { createMockChat } from '@mangostudio/shared/test-utils';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type * as ApiClient from '../../../src/lib/api-client';
import { act, renderHook, waitFor } from '../../support/harness/render';

const EXISTING_CHAT: Chat = createMockChat({
  id: 'chat-existing',
  title: 'Existing Chat',
  createdAt: 1,
  updatedAt: 1,
});

// `mock.module` is not hoisted, so a plain const declared before the call is
// enough — no need for `jest.hoisted()`.
const mockPost = jest.fn();
const mockPut = jest.fn();
const mockDelete = jest.fn();
const mockChatsFn = Object.assign(
  jest.fn(() => ({ put: mockPut, delete: mockDelete })),
  {
    post: mockPost,
    get: jest.fn(),
  }
);

// Eden Treaty's generic types are too strict for jest.fn() mocks, so the factory is cast via unknown.
mock.module('../../../src/lib/api-client', () => ({
  client: {
    api: { chats: mockChatsFn },
  } as unknown as typeof ApiClient,
}));

// Static imports are evaluated before any statement above runs, so the module
// under test has to come in afterwards or it binds the real api-client.
const { chatKeys, useCreateChatMutation, useDeleteChatMutation, useUpdateChatMutation } =
  await import('../../../src/features/chat/queries');

function ok<T>(data: T) {
  return { data, error: null };
}
function fail(message: string) {
  return { data: null, error: { value: message } };
}

/**
 * Lets the query cache's capability-invalidation subscriber — a queued
 * microtask behind a mutation settling — finish inside `act`, not leaking
 * into the next test.
 */
async function drainCapabilityInvalidation() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('useCreateChatMutation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('calls the API and returns the created chat', async () => {
    const newChat = createMockChat({
      id: 'chat-new',
      title: 'My Chat',
      createdAt: 1,
      updatedAt: 1,
    });
    mockPost.mockResolvedValue(ok(newChat));

    const { result } = renderHook(() => useCreateChatMutation());

    let created: Chat | undefined;
    await act(async () => {
      created = await result.current.mutateAsync({ title: 'My Chat' });
    });

    expect(mockPost).toHaveBeenCalledWith({ title: 'My Chat' });
    expect(created).toEqual(newChat);
    await drainCapabilityInvalidation();
  });

  it('updates the cached chat list and detail after success', async () => {
    const newChat = createMockChat({
      id: 'chat-new',
      title: 'My Chat',
      createdAt: 2,
      updatedAt: 2,
    });
    mockPost.mockResolvedValue(ok(newChat));

    const { result } = renderHook(() => {
      const mutation = useCreateChatMutation();
      const queryClient = useQueryClient();
      return { mutation, queryClient };
    });

    act(() => {
      result.current.queryClient.setQueryData(chatKeys.lists(), [EXISTING_CHAT]);
    });

    await act(async () => {
      await result.current.mutation.mutateAsync({ title: 'My Chat' });
    });

    // `expect<unknown>` because `getQueryData` has no `TQueryFnData` here and
    // bun-types types `toEqual` against the received type.
    expect<unknown>(result.current.queryClient.getQueryData(chatKeys.lists())).toEqual([
      newChat,
      EXISTING_CHAT,
    ]);
    expect<unknown>(result.current.queryClient.getQueryData(chatKeys.detail(newChat.id))).toEqual(
      newChat
    );
    await drainCapabilityInvalidation();
  });

  it('throws when the API returns an error', async () => {
    mockPost.mockResolvedValue(fail('Unauthorized'));

    const { result } = renderHook(() => useCreateChatMutation());

    // `expect(act(...)).rejects` never settles: the harness's `act` returns a
    // thenable bun's `expect().rejects` does not recognize as a promise, so
    // the assertion has to sit on the mutation call itself, inside `act`.
    await act(async () => {
      await expect(result.current.mutateAsync({ title: 'Fail Chat' })).rejects.toThrow();
    });
    await drainCapabilityInvalidation();
  });
});

describe('useUpdateChatMutation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPut.mockResolvedValue(ok({ success: true }));
  });

  it('calls PUT with the correct id and updates', async () => {
    const { result } = renderHook(() => useUpdateChatMutation());

    await act(async () => {
      await result.current.mutateAsync({ id: 'chat-1', updates: { title: 'Renamed' } });
    });

    expect(mockChatsFn).toHaveBeenCalledWith({ id: 'chat-1' });
    expect(mockPut).toHaveBeenCalledWith({ title: 'Renamed' });
    await drainCapabilityInvalidation();
  });

  it('updates the cached chat list and detail after success', async () => {
    const updatedChat: Chat = { ...EXISTING_CHAT, title: 'Renamed' };

    const { result } = renderHook(() => {
      const mutation = useUpdateChatMutation();
      const listQuery = useQuery({
        queryKey: chatKeys.lists(),
        queryFn: () => Promise.resolve([EXISTING_CHAT]),
        initialData: [EXISTING_CHAT],
        staleTime: Number.POSITIVE_INFINITY,
      });
      const detailQuery = useQuery({
        queryKey: chatKeys.detail(EXISTING_CHAT.id),
        queryFn: () => Promise.resolve(EXISTING_CHAT),
        initialData: EXISTING_CHAT,
        staleTime: Number.POSITIVE_INFINITY,
      });
      return { mutation, chats: listQuery.data, detail: detailQuery.data };
    });

    await act(async () => {
      await result.current.mutation.mutateAsync({
        id: EXISTING_CHAT.id,
        updates: { title: 'Renamed' },
      });
    });

    await waitFor(() => expect(result.current.chats).toEqual([updatedChat]));
    expect(result.current.detail).toEqual(updatedChat);
    await drainCapabilityInvalidation();
  });

  it('clears a cached workdir when the execution environment changes', async () => {
    const chatWithWorkdir: Chat = {
      ...EXISTING_CHAT,
      environmentId: 'local',
      workdir: '/srv/local-project',
    };

    const { result } = renderHook(() => {
      const mutation = useUpdateChatMutation();
      const queryClient = useQueryClient();
      return { mutation, queryClient };
    });

    act(() => {
      result.current.queryClient.setQueryData(chatKeys.lists(), [chatWithWorkdir]);
      result.current.queryClient.setQueryData(chatKeys.detail(chatWithWorkdir.id), chatWithWorkdir);
    });

    await act(async () => {
      await result.current.mutation.mutateAsync({
        id: chatWithWorkdir.id,
        updates: { environmentId: 'remote-dev' },
      });
    });

    const expected = {
      ...chatWithWorkdir,
      environmentId: 'remote-dev',
      workdir: null,
    };
    // `expect<unknown>` because `getQueryData` has no `TQueryFnData` here and
    // bun-types types `toEqual` against the received type.
    expect<unknown>(result.current.queryClient.getQueryData(chatKeys.lists())).toEqual([expected]);
    expect<unknown>(
      result.current.queryClient.getQueryData(chatKeys.detail(chatWithWorkdir.id))
    ).toEqual(expected);
    await drainCapabilityInvalidation();
  });

  it('keeps a workdir the same request supplied alongside a new environment', async () => {
    const chatWithWorkdir: Chat = {
      ...EXISTING_CHAT,
      environmentId: 'local',
      workdir: '/srv/local-project',
    };

    const { result } = renderHook(() => {
      const mutation = useUpdateChatMutation();
      const queryClient = useQueryClient();
      return { mutation, queryClient };
    });

    act(() => {
      result.current.queryClient.setQueryData(chatKeys.lists(), [chatWithWorkdir]);
      result.current.queryClient.setQueryData(chatKeys.detail(chatWithWorkdir.id), chatWithWorkdir);
    });

    await act(async () => {
      await result.current.mutation.mutateAsync({
        id: chatWithWorkdir.id,
        updates: { environmentId: 'remote-dev', workdir: '/srv/remote-project' },
      });
    });

    // The server only clears the workdir when the request omitted one, and its
    // PUT answers `{ success }` rather than the chat, so nothing would repair a
    // cache that blanked a workdir the server just accepted.
    const expected = {
      ...chatWithWorkdir,
      environmentId: 'remote-dev',
      workdir: '/srv/remote-project',
    };
    // `expect<unknown>` because `getQueryData` has no `TQueryFnData` here and
    // bun-types types `toEqual` against the received type.
    expect<unknown>(result.current.queryClient.getQueryData(chatKeys.lists())).toEqual([expected]);
    expect<unknown>(
      result.current.queryClient.getQueryData(chatKeys.detail(chatWithWorkdir.id))
    ).toEqual(expected);
    await drainCapabilityInvalidation();
  });

  it('marks capability projections stale when the environment changes', async () => {
    const chatWithEnvironment: Chat = { ...EXISTING_CHAT, environmentId: 'local' };
    const capabilitiesKey = ['chat-capabilities', chatWithEnvironment.id, null, 'chat', null];

    const { result } = renderHook(() => {
      const mutation = useUpdateChatMutation();
      const queryClient = useQueryClient();
      return { mutation, queryClient };
    });

    act(() => {
      result.current.queryClient.setQueryData(
        chatKeys.detail(chatWithEnvironment.id),
        chatWithEnvironment
      );
      result.current.queryClient.setQueryData(capabilitiesKey, { tools: [] });
    });

    await act(async () => {
      await result.current.mutation.mutateAsync({
        id: chatWithEnvironment.id,
        updates: { environmentId: 'remote-dev' },
      });
    });

    // Shell eligibility comes from the selected runtime's manifest, but the
    // capability key holds no environment, so nothing else marks it stale.
    expect(result.current.queryClient.getQueryState(capabilitiesKey)?.isInvalidated).toBe(true);
    await drainCapabilityInvalidation();
  });

  it('leaves capability projections alone when the environment is unchanged', async () => {
    const chatWithEnvironment: Chat = { ...EXISTING_CHAT, environmentId: 'local' };
    const capabilitiesKey = ['chat-capabilities', chatWithEnvironment.id, null, 'chat', null];

    const { result } = renderHook(() => {
      const mutation = useUpdateChatMutation();
      const queryClient = useQueryClient();
      return { mutation, queryClient };
    });

    act(() => {
      result.current.queryClient.setQueryData(
        chatKeys.detail(chatWithEnvironment.id),
        chatWithEnvironment
      );
      result.current.queryClient.setQueryData(capabilitiesKey, { tools: [] });
    });

    await act(async () => {
      await result.current.mutation.mutateAsync({
        id: chatWithEnvironment.id,
        updates: { title: 'Renamed' },
      });
    });

    expect(result.current.queryClient.getQueryState(capabilitiesKey)?.isInvalidated).toBe(false);
    await drainCapabilityInvalidation();
  });

  it('throws when the API returns an error', async () => {
    mockPut.mockResolvedValue(fail('Not found'));

    const { result } = renderHook(() => useUpdateChatMutation());

    // `expect(act(...)).rejects` never settles: the harness's `act` returns a
    // thenable bun's `expect().rejects` does not recognize as a promise, so
    // the assertion has to sit on the mutation call itself, inside `act`.
    await act(async () => {
      await expect(
        result.current.mutateAsync({ id: 'bad-id', updates: { title: 'X' } })
      ).rejects.toThrow();
    });
    await drainCapabilityInvalidation();
  });
});

describe('useDeleteChatMutation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDelete.mockResolvedValue(ok({ success: true }));
  });

  it('calls DELETE with the correct id', async () => {
    const { result } = renderHook(() => useDeleteChatMutation());

    await act(async () => {
      await result.current.mutateAsync('chat-to-delete');
    });

    expect(mockChatsFn).toHaveBeenCalledWith({ id: 'chat-to-delete' });
    expect(mockDelete).toHaveBeenCalled();
    await drainCapabilityInvalidation();
  });

  it('throws when the API returns an error', async () => {
    mockDelete.mockResolvedValue(fail('Forbidden'));

    const { result } = renderHook(() => useDeleteChatMutation());

    // `expect(act(...)).rejects` never settles: the harness's `act` returns a
    // thenable bun's `expect().rejects` does not recognize as a promise, so
    // the assertion has to sit on the mutation call itself, inside `act`.
    await act(async () => {
      await expect(result.current.mutateAsync('bad-id')).rejects.toThrow();
    });
    await drainCapabilityInvalidation();
  });

  it('removes the deleted chat from the cached chat list and detail', async () => {
    const { result } = renderHook(() => {
      const mutation = useDeleteChatMutation();
      const queryClient = useQueryClient();
      return { mutation, queryClient };
    });

    act(() => {
      result.current.queryClient.setQueryData(chatKeys.lists(), [EXISTING_CHAT]);
      result.current.queryClient.setQueryData(chatKeys.detail(EXISTING_CHAT.id), EXISTING_CHAT);
    });

    await act(async () => {
      await result.current.mutation.mutateAsync(EXISTING_CHAT.id);
    });

    // `expect<unknown>` because `getQueryData` has no `TQueryFnData` here and
    // bun-types types `toEqual` against the received type.
    expect<unknown>(result.current.queryClient.getQueryData(chatKeys.lists())).toEqual([]);
    expect(
      result.current.queryClient.getQueryData(chatKeys.detail(EXISTING_CHAT.id))
    ).toBeUndefined();
    await drainCapabilityInvalidation();
  });
});
