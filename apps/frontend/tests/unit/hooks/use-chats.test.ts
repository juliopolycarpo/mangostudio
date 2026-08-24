import { afterEach, beforeEach, describe, expect, it, jest, mock } from 'bun:test';
import type { Chat } from '@mangostudio/shared';
import { createMockChat } from '@mangostudio/shared/test-utils';
import { act, renderHook } from '../../support/harness/render';
import { useFakeTimers } from '../../support/harness/timers';

const CHAT_A: Chat = createMockChat({
  id: 'chat-a',
  title: 'Alpha',
  createdAt: 1,
  updatedAt: 1,
});
const CHAT_B: Chat = createMockChat({
  id: 'chat-b',
  title: 'Beta',
  createdAt: 2,
  updatedAt: 2,
});

type ChatsQueryResult = {
  data: Chat[] | undefined;
  isLoading: boolean;
  error: Error | null;
  refetch: ReturnType<typeof jest.fn>;
};

const { mockCreateChat, mockUpdateChat, mockDeleteChat, mockLoadChats, mockChatsQueryResult } = {
  mockCreateChat: jest.fn(),
  mockUpdateChat: jest.fn(),
  mockDeleteChat: jest.fn(),
  mockLoadChats: jest.fn(),
  mockChatsQueryResult: jest.fn(
    (): ChatsQueryResult => ({
      data: [] as Chat[],
      isLoading: false,
      error: null,
      refetch: jest.fn(),
    })
  ),
};

mock.module('../../../src/features/chat/queries', () => ({
  useChatsQuery: () => mockChatsQueryResult(),
  useCreateChatMutation: () => ({ mutateAsync: mockCreateChat }),
  useUpdateChatMutation: () => ({ mutateAsync: mockUpdateChat }),
  useDeleteChatMutation: () => ({ mutateAsync: mockDeleteChat }),
}));

// Static imports are evaluated before any statement above runs, so the hook
// has to come in afterwards or it binds the real chat queries.
const { useChats } = await import('../../../src/features/chat/hooks/use-chats');

describe('useChats', () => {
  beforeEach(() => {
    useFakeTimers();
    jest.setSystemTime(new Date(2026, 4, 9, 7, 5));
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
    jest.clearAllMocks();
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

  describe('updateChatRunner', () => {
    it('calls the update mutation with a mangostudio runner', async () => {
      const { result } = renderHook(() => useChats());

      await act(async () => {
        await result.current.updateChatRunner(CHAT_A.id, {
          kind: 'mangostudio',
          agentId: 'user:my-agent',
        });
      });

      expect(mockUpdateChat).toHaveBeenCalledWith({
        id: CHAT_A.id,
        updates: { runner: { kind: 'mangostudio', agentId: 'user:my-agent' } },
      });
    });
  });

  describe('updateChatWorkdir', () => {
    it('sets and clears the chat workdir through the update mutation', async () => {
      const { result } = renderHook(() => useChats());

      await act(async () => {
        await result.current.updateChatWorkdir(CHAT_A.id, '/srv/projects/mango');
        await result.current.updateChatWorkdir(CHAT_A.id, null);
      });

      expect(mockUpdateChat).toHaveBeenNthCalledWith(1, {
        id: CHAT_A.id,
        updates: { workdir: '/srv/projects/mango' },
      });
      expect(mockUpdateChat).toHaveBeenNthCalledWith(2, {
        id: CHAT_A.id,
        updates: { workdir: null },
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

    it('clears a selection made after the callback was captured', async () => {
      mockChatsQueryResult.mockReturnValue({
        data: [CHAT_A, CHAT_B],
        isLoading: false,
        error: null,
        refetch: mockLoadChats,
      });

      const { result } = renderHook(() => useChats());

      // What the rollback in `handleNewChatWithRunner` does: it holds one
      // `useChats` object across creation and deletion, so the `deleteChat` it
      // calls predates the selection `createChat` made.
      const staleDeleteChat = result.current.deleteChat;
      act(() => {
        result.current.selectChat(CHAT_B.id);
      });

      await act(async () => {
        await staleDeleteChat(CHAT_B.id);
      });

      expect(result.current.currentChatId).toBe(CHAT_A.id);
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

      expect(mockLoadChats).toHaveBeenCalledTimes(1);
    });
  });
});
