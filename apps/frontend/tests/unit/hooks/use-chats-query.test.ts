/**
 * Unit tests for useChatsQuery chat mutation hooks.
 * Each test gets an isolated QueryClient via the render harness.
 */

import type { Chat } from '@mangostudio/shared';
import { createMockChat } from '@mangostudio/shared/test-utils';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  chatKeys,
  useCreateChatMutation,
  useDeleteChatMutation,
  useUpdateChatMutation,
} from '../../../src/features/chat/queries';
import type * as ApiClient from '../../../src/lib/api-client';
import { act, renderHook, waitFor } from '../../support/harness/render';

const EXISTING_CHAT: Chat = createMockChat({
  id: 'chat-existing',
  title: 'Existing Chat',
  createdAt: 1,
  updatedAt: 1,
});

// vi.mock is hoisted to the top of the file by Vitest, so mock variables must
// be declared with vi.hoisted() to avoid temporal dead zone errors.
const { mockPost, mockPut, mockDelete, mockChatsFn } = vi.hoisted(() => {
  const mockPost = vi.fn();
  const mockPut = vi.fn();
  const mockDelete = vi.fn();
  const mockChatsFn = Object.assign(
    vi.fn(() => ({ put: mockPut, delete: mockDelete })),
    {
      post: mockPost,
      get: vi.fn(),
    }
  );
  return { mockPost, mockPut, mockDelete, mockChatsFn };
});

// Eden Treaty's generic types are too strict for vi.fn() mocks, so the factory is cast via unknown.
vi.mock('../../../src/lib/api-client', () => ({
  client: {
    api: { chats: mockChatsFn },
  } as unknown as typeof ApiClient,
}));

function ok<T>(data: T) {
  return { data, error: null };
}
function fail(message: string) {
  return { data: null, error: { value: message } };
}

describe('useCreateChatMutation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

    expect(result.current.queryClient.getQueryData(chatKeys.lists())).toEqual([
      newChat,
      EXISTING_CHAT,
    ]);
    expect(result.current.queryClient.getQueryData(chatKeys.detail(newChat.id))).toEqual(newChat);
  });

  it('throws when the API returns an error', async () => {
    mockPost.mockResolvedValue(fail('Unauthorized'));

    const { result } = renderHook(() => useCreateChatMutation());

    await expect(
      act(async () => {
        await result.current.mutateAsync({ title: 'Fail Chat' });
      })
    ).rejects.toThrow();
  });
});

describe('useUpdateChatMutation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPut.mockResolvedValue(ok({ success: true }));
  });

  it('calls PUT with the correct id and updates', async () => {
    const { result } = renderHook(() => useUpdateChatMutation());

    await act(async () => {
      await result.current.mutateAsync({ id: 'chat-1', updates: { title: 'Renamed' } });
    });

    expect(mockChatsFn).toHaveBeenCalledWith({ id: 'chat-1' });
    expect(mockPut).toHaveBeenCalledWith({ title: 'Renamed' });
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
    expect(result.current.queryClient.getQueryData(chatKeys.lists())).toEqual([expected]);
    expect(result.current.queryClient.getQueryData(chatKeys.detail(chatWithWorkdir.id))).toEqual(
      expected
    );
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
    expect(result.current.queryClient.getQueryData(chatKeys.lists())).toEqual([expected]);
    expect(result.current.queryClient.getQueryData(chatKeys.detail(chatWithWorkdir.id))).toEqual(
      expected
    );
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
  });

  it('throws when the API returns an error', async () => {
    mockPut.mockResolvedValue(fail('Not found'));

    const { result } = renderHook(() => useUpdateChatMutation());

    await expect(
      act(async () => {
        await result.current.mutateAsync({ id: 'bad-id', updates: { title: 'X' } });
      })
    ).rejects.toThrow();
  });
});

describe('useDeleteChatMutation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDelete.mockResolvedValue(ok({ success: true }));
  });

  it('calls DELETE with the correct id', async () => {
    const { result } = renderHook(() => useDeleteChatMutation());

    await act(async () => {
      await result.current.mutateAsync('chat-to-delete');
    });

    expect(mockChatsFn).toHaveBeenCalledWith({ id: 'chat-to-delete' });
    expect(mockDelete).toHaveBeenCalled();
  });

  it('throws when the API returns an error', async () => {
    mockDelete.mockResolvedValue(fail('Forbidden'));

    const { result } = renderHook(() => useDeleteChatMutation());

    await expect(
      act(async () => {
        await result.current.mutateAsync('bad-id');
      })
    ).rejects.toThrow();
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

    expect(result.current.queryClient.getQueryData(chatKeys.lists())).toEqual([]);
    expect(
      result.current.queryClient.getQueryData(chatKeys.detail(EXISTING_CHAT.id))
    ).toBeUndefined();
  });
});
