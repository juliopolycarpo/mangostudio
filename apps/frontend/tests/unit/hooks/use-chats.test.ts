import type { Chat } from '@mangostudio/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChats } from '../../../src/features/chat/hooks/use-chats';
import { act, renderHook } from '../../support/harness/render';

const CHAT_A: Chat = { id: 'chat-a', title: 'Alpha', createdAt: 1, updatedAt: 1 };
const CHAT_B: Chat = { id: 'chat-b', title: 'Beta', createdAt: 2, updatedAt: 2 };

type ChatsQueryResult = {
  data: Chat[] | undefined;
  isLoading: boolean;
  error: Error | null;
  refetch: ReturnType<typeof vi.fn>;
};

const { mockCreateChat, mockUpdateChat, mockDeleteChat, mockLoadChats, mockChatsQueryResult } =
  vi.hoisted(() => ({
    mockCreateChat: vi.fn(),
    mockUpdateChat: vi.fn(),
    mockDeleteChat: vi.fn(),
    mockLoadChats: vi.fn(),
    mockChatsQueryResult: vi.fn(
      (): ChatsQueryResult => ({
        data: [] as Chat[],
        isLoading: false,
        error: null,
        refetch: vi.fn(),
      })
    ),
  }));

vi.mock('../../../src/features/chat/queries', () => ({
  useChatsQuery: () => mockChatsQueryResult(),
  useCreateChatMutation: () => ({ mutateAsync: mockCreateChat }),
  useUpdateChatMutation: () => ({ mutateAsync: mockUpdateChat }),
  useDeleteChatMutation: () => ({ mutateAsync: mockDeleteChat }),
}));

describe('useChats', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 4, 9, 7, 5));
    mockChatsQueryResult.mockReturnValue({
      data: [],
      isLoading: false,
      error: null,
      refetch: mockLoadChats,
    });
    mockCreateChat.mockResolvedValue({
      ...CHAT_A,
      id: 'chat-new',
      title: 'New Chat [2026-05-09 07:05]',
    });
    mockUpdateChat.mockResolvedValue({ success: true });
    mockDeleteChat.mockResolvedValue({ success: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  describe('initial state', () => {
    it('exposes empty chats and null selection when query returns no data', () => {
      const { result } = renderHook(() => useChats());

      expect(result.current.chats).toEqual([]);
      expect(result.current.currentChatId).toBeNull();
      expect(result.current.currentChat).toBeNull();
      expect(result.current.isLoading).toBe(false);
      expect(result.current.error).toBeNull();
    });

    it('exposes isLoading=true while query is loading', () => {
      mockChatsQueryResult.mockReturnValue({
        data: undefined,
        isLoading: true,
        error: null,
        refetch: mockLoadChats,
      });

      const { result } = renderHook(() => useChats());

      expect(result.current.isLoading).toBe(true);
      expect(result.current.chats).toEqual([]);
    });

    it('propagates the query error message as a string', () => {
      mockChatsQueryResult.mockReturnValue({
        data: undefined,
        isLoading: false,
        error: new Error('Network failure'),
        refetch: mockLoadChats,
      });

      const { result } = renderHook(() => useChats());

      expect(result.current.error).toBe('Network failure');
    });
  });

  describe('chat selection', () => {
    it('auto-selects the first chat when no explicit selection is made', () => {
      mockChatsQueryResult.mockReturnValue({
        data: [CHAT_A, CHAT_B],
        isLoading: false,
        error: null,
        refetch: mockLoadChats,
      });

      const { result } = renderHook(() => useChats());

      expect(result.current.currentChatId).toBe(CHAT_A.id);
      expect(result.current.currentChat).toEqual(CHAT_A);
    });

    it('selectChat changes the active chat', () => {
      mockChatsQueryResult.mockReturnValue({
        data: [CHAT_A, CHAT_B],
        isLoading: false,
        error: null,
        refetch: mockLoadChats,
      });

      const { result } = renderHook(() => useChats());

      act(() => {
        result.current.selectChat(CHAT_B.id);
      });

      expect(result.current.currentChatId).toBe(CHAT_B.id);
      expect(result.current.currentChat).toEqual(CHAT_B);
    });

    it('explicit selection takes precedence over auto-select', () => {
      mockChatsQueryResult.mockReturnValue({
        data: [CHAT_A, CHAT_B],
        isLoading: false,
        error: null,
        refetch: mockLoadChats,
      });

      const { result } = renderHook(() => useChats());

      act(() => {
        result.current.selectChat(CHAT_B.id);
      });

      expect(result.current.currentChatId).toBe(CHAT_B.id);
    });
  });

  describe('createChat', () => {
    it('creates an untitled chat with a timestamp fallback title', async () => {
      const { result } = renderHook(() => useChats());

      await act(async () => {
        await result.current.createChat();
      });

      expect(mockCreateChat).toHaveBeenCalledWith({ title: 'New Chat [2026-05-09 07:05]' });
      expect(result.current.currentChatId).toBe('chat-new');
    });

    it('creates a chat with an explicit title when provided', async () => {
      mockCreateChat.mockResolvedValue({ ...CHAT_A, id: 'chat-explicit', title: 'My Chat' });

      const { result } = renderHook(() => useChats());

      await act(async () => {
        await result.current.createChat('My Chat');
      });

      expect(mockCreateChat).toHaveBeenCalledWith({ title: 'My Chat' });
      expect(result.current.currentChatId).toBe('chat-explicit');
    });
  });

  describe('updateChatTitle', () => {
    it('calls the update mutation with the new title', async () => {
      const { result } = renderHook(() => useChats());

      await act(async () => {
        await result.current.updateChatTitle(CHAT_A.id, 'Renamed');
      });

      expect(mockUpdateChat).toHaveBeenCalledWith({ id: CHAT_A.id, updates: { title: 'Renamed' } });
    });
  });

  describe('updateChatModel', () => {
    it('calls the update mutation for textModel', async () => {
      const { result } = renderHook(() => useChats());

      await act(async () => {
        await result.current.updateChatModel(CHAT_A.id, 'textModel', 'gpt-4o');
      });

      expect(mockUpdateChat).toHaveBeenCalledWith({
        id: CHAT_A.id,
        updates: { textModel: 'gpt-4o' },
      });
    });

    it('calls the update mutation for imageModel', async () => {
      const { result } = renderHook(() => useChats());

      await act(async () => {
        await result.current.updateChatModel(CHAT_A.id, 'imageModel', 'dall-e-3');
      });

      expect(mockUpdateChat).toHaveBeenCalledWith({
        id: CHAT_A.id,
        updates: { imageModel: 'dall-e-3' },
      });
    });
  });

  describe('updateChatAgentSelection', () => {
    it('calls the update mutation with agent mode and id', async () => {
      const { result } = renderHook(() => useChats());

      await act(async () => {
        await result.current.updateChatAgentSelection(CHAT_A.id, {
          lastUsedMode: 'agent',
          selectedAgentId: 'user:my-agent',
        });
      });

      expect(mockUpdateChat).toHaveBeenCalledWith({
        id: CHAT_A.id,
        updates: { lastUsedMode: 'agent', selectedAgentId: 'user:my-agent' },
      });
    });

    it('calls the update mutation with chat mode and no agent id', async () => {
      const { result } = renderHook(() => useChats());

      await act(async () => {
        await result.current.updateChatAgentSelection(CHAT_A.id, { lastUsedMode: 'chat' });
      });

      expect(mockUpdateChat).toHaveBeenCalledWith({
        id: CHAT_A.id,
        updates: { lastUsedMode: 'chat' },
      });
    });
  });

  describe('deleteChat', () => {
    it('calls the delete mutation', async () => {
      mockChatsQueryResult.mockReturnValue({
        data: [CHAT_A, CHAT_B],
        isLoading: false,
        error: null,
        refetch: mockLoadChats,
      });

      const { result } = renderHook(() => useChats());

      await act(async () => {
        await result.current.deleteChat(CHAT_B.id);
      });

      expect(mockDeleteChat).toHaveBeenCalledWith(CHAT_B.id);
    });

    it('auto-selects the next remaining chat when the current chat is deleted', async () => {
      mockChatsQueryResult.mockReturnValue({
        data: [CHAT_A, CHAT_B],
        isLoading: false,
        error: null,
        refetch: mockLoadChats,
      });

      const { result } = renderHook(() => useChats());

      act(() => {
        result.current.selectChat(CHAT_A.id);
      });

      await act(async () => {
        await result.current.deleteChat(CHAT_A.id);
      });

      expect(result.current.currentChatId).toBe(CHAT_B.id);
    });

    it('sets currentChatId to null when the last chat is deleted', async () => {
      mockChatsQueryResult.mockReturnValue({
        data: [CHAT_A],
        isLoading: false,
        error: null,
        refetch: mockLoadChats,
      });

      const { result, rerender } = renderHook(() => useChats());

      act(() => {
        result.current.selectChat(CHAT_A.id);
      });

      await act(async () => {
        await result.current.deleteChat(CHAT_A.id);
      });

      // Simulate TanStack Query cache update: the deleted chat is removed.
      // Without this, auto-select would re-pick CHAT_A from the stale mock list.
      mockChatsQueryResult.mockReturnValue({
        data: [],
        isLoading: false,
        error: null,
        refetch: mockLoadChats,
      });
      rerender();

      expect(result.current.currentChatId).toBeNull();
    });

    it('does not change selection when a non-current chat is deleted', async () => {
      mockChatsQueryResult.mockReturnValue({
        data: [CHAT_A, CHAT_B],
        isLoading: false,
        error: null,
        refetch: mockLoadChats,
      });

      const { result } = renderHook(() => useChats());

      act(() => {
        result.current.selectChat(CHAT_A.id);
      });

      await act(async () => {
        await result.current.deleteChat(CHAT_B.id);
      });

      expect(result.current.currentChatId).toBe(CHAT_A.id);
    });
  });

  describe('loadChats', () => {
    it('calls refetch', async () => {
      const { result } = renderHook(() => useChats());

      await act(async () => {
        await result.current.loadChats();
      });

      expect(mockLoadChats).toHaveBeenCalledOnce();
    });
  });
});
