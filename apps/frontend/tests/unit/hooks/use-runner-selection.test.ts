import { beforeEach, describe, expect, it, jest, mock } from 'bun:test';
import { createMockChat } from '@mangostudio/shared/test-utils';
import type { ChatWithContext } from '../../../src/features/chat/queries';
import { act, renderHook, waitFor } from '../../support/harness/render';

mock.module('../../../src/features/settings/agents/queries', () => ({
  agentSettingsKeys: { all: ['agent-settings'] },
  agentSettingsListQueryOptions: () => ({
    queryKey: ['agent-settings', 'test'],
    queryFn: () => Promise.resolve({ agents: [] }),
  }),
}));

// Static imports are evaluated before any statement above runs, so the hook
// has to come in afterwards or it binds the real agent settings queries.
const { useRunnerSelection } = await import('../../../src/hooks/use-runner-selection');

const CHAT: ChatWithContext = createMockChat({
  id: 'chat-1',
  title: 'Workspace chat',
  createdAt: 1,
  updatedAt: 1,
  workdir: null,
});

describe('useRunnerSelection workdir binding', () => {
  const updateChatRunner = jest.fn(() => Promise.resolve());
  const updateChatRunnerPermissions = jest.fn(() => Promise.resolve());
  const updateChatWorkdir = jest.fn(() => Promise.resolve());
  const addRecentWorkdir = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('applies the default workdir the first time a chat without one is observed', async () => {
    const { result } = renderHook(() =>
      useRunnerSelection({
        currentChatId: CHAT.id,
        currentChat: CHAT,
        defaultWorkdir: '/srv/projects/default',
        updateChatRunner,
        updateChatRunnerPermissions,
        updateChatWorkdir,
        addRecentWorkdir,
      })
    );

    await waitFor(() =>
      expect(updateChatWorkdir).toHaveBeenCalledWith(CHAT.id, '/srv/projects/default')
    );
    expect(result.current.isWorkdirPickerOpen).toBe(false);
  });

  it('opens the picker when the chat has no workdir and no default is configured', async () => {
    const { result } = renderHook(() =>
      useRunnerSelection({
        currentChatId: CHAT.id,
        currentChat: CHAT,
        defaultWorkdir: '',
        updateChatRunner,
        updateChatRunnerPermissions,
        updateChatWorkdir,
        addRecentWorkdir,
      })
    );

    await waitFor(() => expect(result.current.isWorkdirPickerOpen).toBe(true));
  });

  /**
   * `workspaceSettings.defaultWorkdir` is one path with no machine attached —
   * it is picked in Settings against the hub. Sending it to another machine
   * either fails after a round trip to a runtime that may be a cold dial, or,
   * where a same-named directory happens to exist, succeeds and silently binds
   * the chat to the wrong project.
   */
  it('never sends the hub default to a chat on another machine', async () => {
    const remote = { ...CHAT, environmentId: 'ubuntu-box' };
    const { result } = renderHook(() =>
      useRunnerSelection({
        currentChatId: remote.id,
        currentChat: remote,
        defaultWorkdir: '/srv/projects/default',
        updateChatRunner,
        updateChatRunnerPermissions,
        updateChatWorkdir,
        addRecentWorkdir,
      })
    );

    // The picker browses through the chat, so it lists the machine the chat is
    // on — which is what makes asking the right move rather than a fallback.
    await waitFor(() => expect(result.current.isWorkdirPickerOpen).toBe(true));
    expect(updateChatWorkdir).not.toHaveBeenCalled();
  });

  it('binds a selected workdir, records it as recent, and closes the picker', async () => {
    const { result } = renderHook(() =>
      useRunnerSelection({
        currentChatId: CHAT.id,
        currentChat: CHAT,
        defaultWorkdir: '',
        updateChatRunner,
        updateChatRunnerPermissions,
        updateChatWorkdir,
        addRecentWorkdir,
      })
    );

    await act(async () => {
      await result.current.selectWorkdir('/srv/projects/mango');
    });

    expect(updateChatWorkdir).toHaveBeenCalledWith(CHAT.id, '/srv/projects/mango');
    expect(addRecentWorkdir).toHaveBeenCalledWith('/srv/projects/mango');
    expect(result.current.isWorkdirPickerOpen).toBe(false);
  });

  /**
   * `handleNewChatWithRunner` creates a *local* chat and only then repoints it
   * to the runner's machine. The intermediate record is observable for the
   * whole repoint request; defaulting against it would send the hub path to a
   * chat about to be remote, and marking it would rob the repointed chat of
   * its picker. The hold defers the effect — including the marking — until the
   * setup settles, and the effect then acts on the record's final machine.
   */
  it('defers defaulting while a hold is open, then acts on the settled record', async () => {
    const { promise: setupDone, resolve: releaseSetup } = Promise.withResolvers<void>();

    const { result, rerender } = renderHook(
      (props: { currentChat: ChatWithContext | null }) =>
        useRunnerSelection({
          currentChatId: CHAT.id,
          currentChat: props.currentChat,
          defaultWorkdir: '/srv/projects/default',
          updateChatRunner,
          updateChatRunnerPermissions,
          updateChatWorkdir,
          addRecentWorkdir,
        }),
      { initialProps: { currentChat: null as ChatWithContext | null } }
    );

    let held: Promise<void> = Promise.resolve();
    act(() => {
      held = result.current.holdWorkdirDefault(() => setupDone);
    });
    // Creation publishes the local record with no workdir while the repoint is
    // still in flight — exactly the window the hold exists for.
    rerender({ currentChat: CHAT });
    expect(updateChatWorkdir).not.toHaveBeenCalled();

    // The repoint lands in the cache before the hold releases: the update
    // mutation writes the record in onSuccess, which runs before the awaited
    // call resolves inside the held task.
    rerender({ currentChat: { ...CHAT, environmentId: 'ubuntu-box' } });
    expect(updateChatWorkdir).not.toHaveBeenCalled();

    await act(async () => {
      releaseSetup();
      await held;
    });

    // Not marked as defaulted during the hold: the settled remote record still
    // gets its picker, and the hub path was never sent anywhere.
    await waitFor(() => expect(result.current.isWorkdirPickerOpen).toBe(true));
    expect(updateChatWorkdir).not.toHaveBeenCalled();
  });

  it('waits for the chat record before defaulting, so a loading chat is never overwritten', async () => {
    const { rerender } = renderHook(
      (props: { currentChat: ChatWithContext | null }) =>
        useRunnerSelection({
          currentChatId: CHAT.id,
          currentChat: props.currentChat,
          defaultWorkdir: '/srv/projects/default',
          updateChatRunner,
          updateChatRunnerPermissions,
          updateChatWorkdir,
          addRecentWorkdir,
        }),
      { initialProps: { currentChat: null as ChatWithContext | null } }
    );

    // The id is selected but the row has not arrived; a null record is not
    // evidence that the chat has no workdir.
    expect(updateChatWorkdir).not.toHaveBeenCalled();

    rerender({ currentChat: { ...CHAT, workdir: '/srv/projects/persisted' } });

    await waitFor(() => expect(updateChatWorkdir).not.toHaveBeenCalled());
  });
});

describe('useRunnerSelection binding a chat created mid-submit', () => {
  const updateChatRunner = jest.fn(() => Promise.resolve());
  const updateChatRunnerPermissions = jest.fn(() => Promise.resolve());
  const updateChatWorkdir = jest.fn(() => Promise.resolve());
  const addRecentWorkdir = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  interface SelectionProps {
    readonly currentChatId: string | null;
    readonly currentChat: ChatWithContext | null;
  }

  const EMPTY_STATE: SelectionProps = { currentChatId: null, currentChat: null };

  function renderOnEmptyState(defaultWorkdir: string) {
    return renderHook(
      (props: SelectionProps) =>
        useRunnerSelection({
          ...props,
          defaultWorkdir,
          updateChatRunner,
          updateChatRunnerPermissions,
          updateChatWorkdir,
          addRecentWorkdir,
        }),
      { initialProps: EMPTY_STATE }
    );
  }

  it('persists the agent picked before any chat existed', async () => {
    const { result, rerender } = renderOnEmptyState('/srv/projects/default');

    act(() => result.current.setRunnerAgentId('explore'));
    expect(updateChatRunner).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.bindNewChat('chat-new');
    });

    expect(updateChatRunner).toHaveBeenCalledWith('chat-new', {
      kind: 'mangostudio',
      agentId: 'explore',
    });

    // `createChat` selects the new id, and the retargeted override has to
    // survive that — otherwise the picker snaps back to the server's `default`
    // as soon as the new chat renders, and so does every later turn.
    rerender({
      currentChatId: 'chat-new',
      currentChat: { ...CHAT, id: 'chat-new', workdir: '/srv/projects/default' },
    });

    expect(result.current.selectedAgentId).toBe('explore');
  });

  it('returns the effective agent selection, falling back after a rejected persist', async () => {
    const rejectingUpdateChatRunner = jest.fn(() => Promise.reject(new Error('nope')));
    const { result } = renderHook(
      (props: SelectionProps) =>
        useRunnerSelection({
          ...props,
          defaultWorkdir: '/srv/projects/default',
          updateChatRunner: rejectingUpdateChatRunner,
          updateChatRunnerPermissions,
          updateChatWorkdir,
          addRecentWorkdir,
        }),
      { initialProps: EMPTY_STATE }
    );

    act(() => result.current.setRunnerAgentId('explore'));

    let selection: { agentId: string; agentName?: string } | undefined;
    await act(async () => {
      selection = await result.current.bindNewChat('chat-new');
    });

    // The persist failed, so the turn must run as the agent the chat actually
    // stores — not the optimistic pick `getAgentSelection` would otherwise
    // have kept reading from a stale closure.
    expect(selection).toEqual({ agentId: 'default', agentName: undefined });
  });

  it('persists the permissions picked before any chat existed', async () => {
    const { result, rerender } = renderOnEmptyState('/srv/projects/default');

    act(() => result.current.setRunnerTarget('codex'));
    act(() =>
      result.current.setRunnerPermissions({ level: 'full-access', routing: 'auto-review' })
    );
    expect(updateChatRunnerPermissions).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.bindNewChat('chat-new');
    });

    // Awaited inside `bindNewChat`, so the pair is stored before the caller
    // opens the first turn — otherwise that turn runs on the chat defaults and
    // the composer chip claims a level the vendor never received.
    expect(updateChatRunnerPermissions).toHaveBeenCalledWith('chat-new', {
      level: 'full-access',
      routing: 'auto-review',
    });

    rerender({
      currentChatId: 'chat-new',
      currentChat: { ...CHAT, id: 'chat-new', workdir: '/srv/projects/default' },
    });

    expect(result.current.runnerPermissions).toEqual({
      level: 'full-access',
      routing: 'auto-review',
    });
  });

  it('takes the optimistic permissions back when the bind write is rejected', async () => {
    const rejecting = jest.fn(() => Promise.reject(new Error('nope')));
    const { result } = renderHook(
      (props: SelectionProps) =>
        useRunnerSelection({
          ...props,
          defaultWorkdir: '/srv/projects/default',
          updateChatRunner,
          updateChatRunnerPermissions: rejecting,
          updateChatWorkdir,
          addRecentWorkdir,
        }),
      { initialProps: EMPTY_STATE }
    );

    act(() =>
      result.current.setRunnerPermissions({ level: 'full-access', routing: 'auto-review' })
    );
    await act(async () => {
      await result.current.bindNewChat('chat-new');
    });

    expect(rejecting).toHaveBeenCalled();
    expect(result.current.runnerPermissions).not.toEqual({
      level: 'full-access',
      routing: 'auto-review',
    });
  });

  it('applies the default workdir before the first turn opens', async () => {
    const { result } = renderOnEmptyState('/srv/projects/default');

    await act(async () => {
      await result.current.bindNewChat('chat-new');
      // `bindNewChat` resolves the moment its own awaits settle, but the
      // agent-selection state it returns updates a tick later — give it room
      // to run inside `act` rather than after.
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(updateChatWorkdir).toHaveBeenCalledWith('chat-new', '/srv/projects/default');
    expect(addRecentWorkdir).toHaveBeenCalledWith('/srv/projects/default');
  });

  it('opens the picker when no default workdir is configured', async () => {
    const { result } = renderOnEmptyState('');

    await act(async () => {
      await result.current.bindNewChat('chat-new');
    });

    expect(updateChatWorkdir).not.toHaveBeenCalled();
    expect(result.current.isWorkdirPickerOpen).toBe(true);
  });

  it('does not re-apply the default once the chat record arrives', async () => {
    const { result, rerender } = renderOnEmptyState('/srv/projects/default');

    await act(async () => {
      await result.current.bindNewChat('chat-new');
    });

    rerender({
      currentChatId: 'chat-new',
      currentChat: { ...CHAT, id: 'chat-new', workdir: null },
    });

    await waitFor(() => expect(updateChatWorkdir).toHaveBeenCalledTimes(1));
  });
});

describe('useRunnerSelection agent selection', () => {
  const updateChatWorkdir = jest.fn(() => Promise.resolve());
  const addRecentWorkdir = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('shows the chosen agent optimistically', async () => {
    const updateChatRunner = jest.fn(() => Promise.resolve());
    const updateChatRunnerPermissions = jest.fn(() => Promise.resolve());
    const { result } = renderHook(() =>
      useRunnerSelection({
        currentChatId: CHAT.id,
        currentChat: { ...CHAT, workdir: '/srv/projects/bound' },
        defaultWorkdir: '/srv/projects/default',
        updateChatRunner,
        updateChatRunnerPermissions,
        updateChatWorkdir,
        addRecentWorkdir,
      })
    );

    act(() => result.current.setRunnerAgentId('explore'));

    await waitFor(() => expect(result.current.selectedAgentId).toBe('explore'));
    expect(updateChatRunner).toHaveBeenCalledWith(CHAT.id, {
      kind: 'mangostudio',
      agentId: 'explore',
    });
  });

  it('takes the optimistic selection back when the write is rejected', async () => {
    const updateChatRunner = jest.fn(() => Promise.reject(new Error('nope')));
    const updateChatRunnerPermissions = jest.fn(() => Promise.resolve());
    const { result } = renderHook(() =>
      useRunnerSelection({
        currentChatId: CHAT.id,
        currentChat: { ...CHAT, workdir: '/srv/projects/bound' },
        defaultWorkdir: '/srv/projects/default',
        updateChatRunner,
        updateChatRunnerPermissions,
        updateChatWorkdir,
        addRecentWorkdir,
      })
    );

    act(() => result.current.setRunnerAgentId('explore'));

    // Falling back to the persisted runner keeps the picker and every
    // subsequent turn agreeing with what the chat actually stores.
    await waitFor(() => expect(result.current.selectedAgentId).toBe('default'));
  });
});

describe('useRunnerSelection whenRunnerPersisted', () => {
  const updateChatWorkdir = jest.fn(() => Promise.resolve());
  const updateChatRunnerPermissions = jest.fn(() => Promise.resolve());
  const addRecentWorkdir = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  function renderSelection(updateChatRunner: () => Promise<void>) {
    return renderHook(() =>
      useRunnerSelection({
        currentChatId: CHAT.id,
        currentChat: { ...CHAT, workdir: '/srv/projects/bound' },
        defaultWorkdir: '/srv/projects/default',
        updateChatRunner,
        updateChatRunnerPermissions,
        updateChatWorkdir,
        addRecentWorkdir,
      })
    );
  }

  // The hub dispatches on the stored runner, so a turn opened while the switch
  // is still in flight would run on the runner being replaced.
  it('waits for a switch that has not been answered yet', async () => {
    let settle: (() => void) | undefined;
    const updateChatRunner = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          settle = resolve;
        })
    );
    const { result } = renderSelection(updateChatRunner);

    act(() => result.current.setRunnerTarget('codex'));

    let waited = false;
    const pending = result.current.whenRunnerPersisted().then(() => {
      waited = true;
    });
    await Promise.resolve();
    expect(waited).toBe(false);

    await act(async () => {
      settle?.();
      await pending;
      // The switch's own state settling lands a tick behind `pending` —
      // give it room to run inside `act` rather than after.
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(waited).toBe(true);
  });

  it('resolves immediately when no switch is open', async () => {
    const updateChatRunner = jest.fn(() => Promise.resolve());
    const { result } = renderSelection(updateChatRunner);

    await expect(result.current.whenRunnerPersisted()).resolves.toBeUndefined();
    expect(updateChatRunner).not.toHaveBeenCalled();
  });

  // A rejected write must not leave the gate closed for every later send.
  it('stops waiting once a rejected switch settles', async () => {
    const updateChatRunner = jest.fn(() => Promise.reject(new Error('nope')));
    const { result } = renderSelection(updateChatRunner);

    act(() => result.current.setRunnerTarget('codex'));

    // The rejection's `.catch` handler updates state, so the wait for it has
    // to sit inside `act`, not around it.
    await act(async () => {
      await expect(result.current.whenRunnerPersisted()).resolves.toBeUndefined();
    });
    await waitFor(() =>
      expect(result.current.runner).toEqual({
        kind: 'mangostudio',
        agentId: 'default',
      })
    );
  });
});
