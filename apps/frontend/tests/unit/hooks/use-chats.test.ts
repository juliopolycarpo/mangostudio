import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '../../support/harness/render';
import { useChats } from '../../../src/features/chat/hooks/use-chats';

const { mockCreateChat, mockLoadChats } = vi.hoisted(() => ({
  mockCreateChat: vi.fn(),
  mockLoadChats: vi.fn(),
}));

vi.mock('../../../src/features/chat/queries', () => ({
  useChatsQuery: () => ({ data: [], isLoading: false, error: null, refetch: mockLoadChats }),
  useCreateChatMutation: () => ({ mutateAsync: mockCreateChat }),
  useUpdateChatMutation: () => ({ mutateAsync: vi.fn() }),
  useDeleteChatMutation: () => ({ mutateAsync: vi.fn() }),
}));

describe('useChats', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 4, 9, 7, 5));
    mockCreateChat.mockResolvedValue({
      id: 'chat-new',
      title: 'New Chat [2026-05-09 07:05]',
      createdAt: 1,
      updatedAt: 1,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('creates untitled chats with a timestamp fallback title', async () => {
    const { result } = renderHook(() => useChats());

    await act(async () => {
      await result.current.createChat();
    });

    expect(mockCreateChat).toHaveBeenCalledWith({ title: 'New Chat [2026-05-09 07:05]' });
    expect(result.current.currentChatId).toBe('chat-new');
  });
});
