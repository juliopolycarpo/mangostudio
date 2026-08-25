/**
 * The route actions the shell hands around. Both collaborators are injected, so
 * nothing here needs a router or the chat queries — which is the point of the
 * hook taking them as parameters.
 */

import { describe, expect, it, jest } from 'bun:test';
import type { Chat } from '@mangostudio/shared';
import { act } from '@testing-library/react';
import { useChatRouteActions } from '../../../src/hooks/use-chat-route-actions';
import { renderHook, screen } from '../../support/harness/render';

function setup(createdId = 'chat-new') {
  // Creation always lands on the local machine — the create body carries no
  // environment field — which is the whole premise of the scoped variant below.
  const createChat = jest.fn(async () => ({ id: createdId, environmentId: 'local' }) as Chat);
  const updateChatRunner = jest.fn(async () => undefined);
  const updateChatRunnerOnEnvironment = jest.fn(async () => undefined);
  const updateChatWorkdir = jest.fn(async () => undefined);
  const deleteChat = jest.fn(async () => undefined);
  const navigate = jest.fn(async () => undefined);
  const addRecentWorkdir = jest.fn();
  const chats = {
    createChat,
    updateChatRunner,
    updateChatRunnerOnEnvironment,
    updateChatWorkdir,
    deleteChat,
  } as unknown as Parameters<typeof useChatRouteActions>[0]['chats'];

  // A pass-through that keeps score, so a test can pin whether a given write
  // happened under the hold or escaped it.
  let holdDepth = 0;
  const holdWorkdirDefault = jest.fn(async <T,>(task: () => Promise<T>): Promise<T> => {
    holdDepth += 1;
    try {
      return await task();
    } finally {
      holdDepth -= 1;
    }
  });
  const holdDepthDuring = (call: jest.Mock, resolvedValue?: unknown) => {
    let observed = -1;
    call.mockImplementation(() => {
      observed = holdDepth;
      return Promise.resolve(resolvedValue);
    });
    return () => observed;
  };

  const { result } = renderHook(() =>
    useChatRouteActions({
      chats,
      navigate: navigate as unknown as Parameters<typeof useChatRouteActions>[0]['navigate'],
      // `jest.fn` erases the generic; the implementation above is the real
      // pass-through shape.
      holdWorkdirDefault: holdWorkdirDefault as <T>(task: () => Promise<T>) => Promise<T>,
      addRecentWorkdir,
    })
  );
  return {
    result,
    createChat,
    updateChatRunner,
    updateChatRunnerOnEnvironment,
    updateChatWorkdir,
    deleteChat,
    navigate,
    addRecentWorkdir,
    holdWorkdirDefault,
    holdDepthDuring,
  };
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

  /**
   * Creation publishes and selects a local record before the repoint resolves,
   * and the workdir-defaulting effect can observe that intermediate chat —
   * stamping the hub default onto a chat about to be remote, or marking it as
   * defaulted so the repointed chat never gets its picker. Both the creation
   * and the repoint must therefore run inside the hold; navigation happens
   * after it releases.
   */
  it('holds workdir defaulting across the create-and-repoint window', async () => {
    const { result, createChat, updateChatRunnerOnEnvironment, navigate, holdDepthDuring } =
      setup('chat-new');
    const depthAtCreate = holdDepthDuring(createChat, { id: 'chat-new', environmentId: 'local' });
    const depthAtRepoint = holdDepthDuring(updateChatRunnerOnEnvironment);
    const depthAtNavigate = holdDepthDuring(navigate);

    await act(async () => {
      await result.current.handleNewChatWithRunner(
        { kind: 'external', targetId: 'codex' },
        'env-remote'
      );
    });

    expect(depthAtCreate()).toBe(1);
    expect(depthAtRepoint()).toBe(1);
    expect(depthAtNavigate()).toBe(0);
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

  /**
   * The environment that offered the runner can vanish between opening the
   * palette and running this — `createChat` has already published and selected
   * a local chat by the time that write rejects. Left alone, that chat stays
   * current with no indication anything failed, because the palette discards
   * this promise's rejection (`void item.run()`). Rolled back and reported
   * instead.
   */
  it('rolls back the chat and reports the failure when the runner cannot be bound', async () => {
    const { result, deleteChat, navigate, updateChatRunnerOnEnvironment } = setup('chat-new');
    updateChatRunnerOnEnvironment.mockImplementation(() => Promise.reject(new Error('gone')));

    await act(async () => {
      await result.current.handleNewChatWithRunner(
        { kind: 'external', targetId: 'codex' },
        'env-remote'
      );
    });

    expect(deleteChat).toHaveBeenCalledWith('chat-new');
    expect(navigate).not.toHaveBeenCalled();
    expect(screen.getByText(/could not start the chat/i)).toBeTruthy();
  });
});

describe('handleNewChatInWorkdir', () => {
  it('points the new chat at the folder and remembers it', async () => {
    const { result, createChat, updateChatWorkdir, addRecentWorkdir, navigate } = setup('chat-new');

    await act(async () => {
      await result.current.handleNewChatInWorkdir('/srv/projects/mango');
    });

    expect(createChat).toHaveBeenCalledTimes(1);
    expect(updateChatWorkdir).toHaveBeenCalledWith('chat-new', '/srv/projects/mango');
    expect(addRecentWorkdir).toHaveBeenCalledWith('/srv/projects/mango');
    expect(navigate).toHaveBeenCalledWith({ to: '/' });
  });

  /**
   * Creation publishes a chat with no folder before the repoint lands, and the
   * defaulting effect can observe it. Acting on that intermediate record either
   * stamps the configured default folder onto a chat that is about to point
   * somewhere else, or marks the id as defaulted so the repointed one never
   * gets its picker.
   */
  it('holds workdir defaulting across the create-and-repoint window', async () => {
    const { result, createChat, updateChatWorkdir, navigate, holdDepthDuring } = setup('chat-new');
    const depthAtCreate = holdDepthDuring(createChat, { id: 'chat-new', environmentId: 'local' });
    const depthAtRepoint = holdDepthDuring(updateChatWorkdir);
    const depthAtNavigate = holdDepthDuring(navigate);

    await act(async () => {
      await result.current.handleNewChatInWorkdir('/srv/projects/mango');
    });

    expect(depthAtCreate()).toBe(1);
    expect(depthAtRepoint()).toBe(1);
    expect(depthAtNavigate()).toBe(0);
  });

  it('rolls back the chat and reports the failure when the folder cannot be bound', async () => {
    const { result, deleteChat, addRecentWorkdir, navigate, updateChatWorkdir } = setup('chat-new');
    updateChatWorkdir.mockImplementation(() => Promise.reject(new Error('gone')));

    await act(async () => {
      await result.current.handleNewChatInWorkdir('/srv/projects/mango');
    });

    expect(deleteChat).toHaveBeenCalledWith('chat-new');
    // Nothing was opened there, so nothing about the folder became recent.
    expect(addRecentWorkdir).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    expect(screen.getByText(/could not start the chat/i)).toBeTruthy();
  });
});
