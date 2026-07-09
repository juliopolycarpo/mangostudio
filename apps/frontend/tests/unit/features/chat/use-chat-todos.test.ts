/**
 * Unit tests for the chat todo query hook: endpoint fetch, disabled state
 * without a chat, and the `todo_update` cache-write path that keeps the
 * pinned panel live without a refetch round-trip.
 */

import type { TodoList } from '@mangostudio/shared/todos';
import { useQueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setChatTodos, useChatTodos } from '../../../../src/features/chat/hooks/use-chat-todos';
import { act, renderHook, waitFor } from '../../../support/harness/render';
import { createFetchScenario } from '../../../support/mocks/create-fetch-scenario';

const CHAT_ID = 'chat-1';
const INITIAL_TODOS: TodoList = [{ content: 'Add validation', status: 'in_progress' }];

describe('useChatTodos', () => {
  const fetchScenario = createFetchScenario();

  beforeEach(() => {
    fetchScenario.install();
  });

  afterEach(() => {
    fetchScenario.restore();
  });

  it('fetches the chat todo state from the API', async () => {
    fetchScenario.respondWithJson('GET', `/api/chats/${CHAT_ID}/todos`, {
      body: { todos: INITIAL_TODOS, updatedAt: 100 },
    });

    const { result } = renderHook(() => useChatTodos(CHAT_ID));

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({ todos: INITIAL_TODOS, updatedAt: 100 });
  });

  it('stays disabled without a chat id', () => {
    const { result } = renderHook(() => useChatTodos(null));

    expect(result.current.fetchStatus).toBe('idle');
    expect(fetchScenario.fetchMock).not.toHaveBeenCalled();
  });

  it('setChatTodos updates the hook data from a stream chunk without a refetch', async () => {
    fetchScenario.respondWithJson('GET', `/api/chats/${CHAT_ID}/todos`, {
      body: { todos: INITIAL_TODOS, updatedAt: 100 },
    });

    const { result, rerender } = renderHook(() => ({
      query: useChatTodos(CHAT_ID),
      queryClient: useQueryClient(),
    }));

    await waitFor(() => expect(result.current.query.isSuccess).toBe(true));

    const streamedTodos: TodoList = [
      { content: 'Add validation', status: 'completed' },
      { content: 'Write tests', status: 'in_progress' },
    ];
    act(() => {
      setChatTodos(result.current.queryClient, CHAT_ID, streamedTodos);
    });
    // jsdom drops the observer's re-render notification for external cache
    // writes; the observer state itself is updated, so a manual rerender
    // exposes it without any refetch.
    rerender();

    expect(result.current.query.data?.todos).toEqual(streamedTodos);
    expect(result.current.query.data?.updatedAt).toBeTypeOf('number');
    expect(fetchScenario.fetchMock).toHaveBeenCalledTimes(1);
  });
});
