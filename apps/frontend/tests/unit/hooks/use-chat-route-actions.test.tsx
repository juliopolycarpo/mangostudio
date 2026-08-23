/**
 * The route actions the shell hands around. Both collaborators are injected, so
 * nothing here needs a router or the chat queries — which is the point of the
 * hook taking them as parameters.
 */

import { describe, expect, it, jest } from 'bun:test';
import type { Chat } from '@mangostudio/shared';
import { act } from '@testing-library/react';
import { useChatRouteActions } from '../../../src/hooks/use-chat-route-actions';
import { renderHook } from '../../support/harness/render';

function setup(createdId = 'chat-new') {
  const createChat = jest.fn(async () => ({ id: createdId }) as Chat);
  const updateChatRunner = jest.fn(async () => undefined);
  const navigate = jest.fn(async () => undefined);
  const chats = { createChat, updateChatRunner } as unknown as Parameters<
    typeof useChatRouteActions
  >[0]['chats'];

  const { result } = renderHook(() =>
    useChatRouteActions({
      chats,
      navigate: navigate as unknown as Parameters<typeof useChatRouteActions>[0]['navigate'],
    })
  );
  return { result, createChat, updateChatRunner, navigate };
}

describe('handleNewChatWithRunner', () => {
  /**
   * The whole reason this action exists rather than "create, then use the
   * runner selector": the selector persists against the chat that is *currently*
   * selected, and React has not observed the new one when this resolves — so
   * that route would rewrite the runner of the chat the user just left.
   */
  it('writes the runner against the id the creation returned', async () => {
    const { result, createChat, updateChatRunner } = setup('chat-new');

    await act(async () => {
      await result.current.handleNewChatWithRunner({ kind: 'external', targetId: 'codex' });
    });

    expect(createChat).toHaveBeenCalledTimes(1);
    expect(updateChatRunner).toHaveBeenCalledWith('chat-new', {
      kind: 'external',
      targetId: 'codex',
    });
  });

  it('lands on the chat surface once the runner is stored', async () => {
    const { result, updateChatRunner, navigate } = setup();

    await act(async () => {
      await result.current.handleNewChatWithRunner({ kind: 'mangostudio', agentId: 'explore' });
    });

    expect(updateChatRunner).toHaveBeenCalledWith('chat-new', {
      kind: 'mangostudio',
      agentId: 'explore',
    });
    expect(navigate).toHaveBeenCalledWith({ to: '/' });
  });

  it('does not navigate when the chat could not be created', async () => {
    const { result, createChat, updateChatRunner, navigate } = setup();
    createChat.mockImplementation(() => Promise.reject(new Error('offline')));

    await act(async () => {
      await expect(
        result.current.handleNewChatWithRunner({ kind: 'external', targetId: 'codex' })
      ).rejects.toThrow('offline');
    });

    expect(updateChatRunner).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });
});
