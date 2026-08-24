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
  // Creation always lands on the local machine — the create body carries no
  // environment field — which is the whole premise of the scoped variant below.
  const createChat = jest.fn(async () => ({ id: createdId, environmentId: 'local' }) as Chat);
  const updateChatRunner = jest.fn(async () => undefined);
  const updateChatRunnerOnEnvironment = jest.fn(async () => undefined);
  const navigate = jest.fn(async () => undefined);
  const chats = {
    createChat,
    updateChatRunner,
    updateChatRunnerOnEnvironment,
  } as unknown as Parameters<typeof useChatRouteActions>[0]['chats'];

  const { result } = renderHook(() =>
    useChatRouteActions({
      chats,
      navigate: navigate as unknown as Parameters<typeof useChatRouteActions>[0]['navigate'],
    })
  );
  return { result, createChat, updateChatRunner, updateChatRunnerOnEnvironment, navigate };
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

  /**
   * A vendor is only ever offered because discovery found it on one particular
   * machine. Creation lands on `local`, and nothing server-side rejects a
   * remote vendor on a local chat — so dropping the environment here binds the
   * new chat to an installation it does not have.
   */
  it('binds the new chat to the machine the runner came from', async () => {
    const { result, updateChatRunner, updateChatRunnerOnEnvironment, navigate } = setup();

    await act(async () => {
      await result.current.handleNewChatWithRunner(
        { kind: 'external', targetId: 'codex' },
        'env-remote'
      );
    });

    // One write, not two: a runner stored ahead of its machine is a pairing
    // that briefly exists and that a submitted turn would dispatch on.
    expect(updateChatRunnerOnEnvironment).toHaveBeenCalledWith(
      'chat-new',
      { kind: 'external', targetId: 'codex' },
      'env-remote'
    );
    expect(updateChatRunner).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith({ to: '/' });
  });

  it('leaves the machine alone when the runner was found on the one it starts in', async () => {
    const { result, updateChatRunner, updateChatRunnerOnEnvironment } = setup();

    await act(async () => {
      await result.current.handleNewChatWithRunner(
        { kind: 'external', targetId: 'codex' },
        'local'
      );
    });

    expect(updateChatRunnerOnEnvironment).not.toHaveBeenCalled();
    expect(updateChatRunner).toHaveBeenCalledWith('chat-new', {
      kind: 'external',
      targetId: 'codex',
    });
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
