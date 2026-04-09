/**
 * Unit tests for useChatsQuery chat mutation hooks.
 * Each test gets an isolated QueryClient via the render harness.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '../../support/harness/render';
import {
  useCreateChatMutation,
  useUpdateChatMutation,
  useDeleteChatMutation,
  chatKeys,
} from '../../../src/hooks/use-chats-query';
import { useQueryClient } from '@tanstack/react-query';
import type { Chat } from '@mangostudio/shared';

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
  } as unknown as typeof import('../../../src/lib/api-client'),
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
    const newChat: Chat = { id: 'chat-new', title: 'My Chat', createdAt: 1, updatedAt: 1 };
    mockPost.mockResolvedValue(ok(newChat));

    const { result } = renderHook(() => useCreateChatMutation());

    let created: Chat | undefined;
    await act(async () => {
      created = await result.current.mutateAsync({ title: 'My Chat' });
    });

    expect(mockPost).toHaveBeenCalledWith({ title: 'My Chat' });
    expect(created).toEqual(newChat);
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

  it('invalidates the chats list after successful delete', async () => {
    const { result } = renderHook(() => {
      const mutation = useDeleteChatMutation();
      const queryClient = useQueryClient();
      return { mutation, queryClient };
    });

    act(() => {
      result.current.queryClient.setQueryData(chatKeys.lists(), []);
    });

    await act(async () => {
      await result.current.mutation.mutateAsync('chat-x');
    });

    await waitFor(() => {
      const state = result.current.queryClient.getQueryState(chatKeys.lists());
      expect(state?.isInvalidated).toBe(true);
    });
  });
});
