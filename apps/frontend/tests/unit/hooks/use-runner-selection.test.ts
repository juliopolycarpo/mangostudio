import { createMockChat } from '@mangostudio/shared/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatWithContext } from '../../../src/features/chat/queries';
import { useRunnerSelection } from '../../../src/hooks/use-runner-selection';
import { act, renderHook, waitFor } from '../../support/harness/render';

vi.mock('../../../src/features/settings/agents/queries', () => ({
  agentSettingsKeys: { all: ['agent-settings'] },
  agentSettingsListQueryOptions: () => ({
    queryKey: ['agent-settings', 'test'],
    queryFn: () => Promise.resolve({ agents: [] }),
  }),
}));

const CHAT: ChatWithContext = createMockChat({
  id: 'chat-1',
  title: 'Workspace chat',
  createdAt: 1,
  updatedAt: 1,
  workdir: null,
});

describe('useRunnerSelection workdir binding', () => {
  const updateChatRunner = vi.fn(() => Promise.resolve());
  const updateChatRunnerPermissions = vi.fn(() => Promise.resolve());
  const updateChatWorkdir = vi.fn(() => Promise.resolve());
  const addRecentWorkdir = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
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
  const updateChatRunner = vi.fn(() => Promise.resolve());
  const updateChatRunnerPermissions = vi.fn(() => Promise.resolve());
  const updateChatWorkdir = vi.fn(() => Promise.resolve());
  const addRecentWorkdir = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
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
    const rejectingUpdateChatRunner = vi.fn(() => Promise.reject(new Error('nope')));
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

  it('applies the default workdir before the first turn opens', async () => {
    const { result } = renderOnEmptyState('/srv/projects/default');

    await act(async () => {
      await result.current.bindNewChat('chat-new');
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
  const updateChatWorkdir = vi.fn(() => Promise.resolve());
  const addRecentWorkdir = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows the chosen agent optimistically', async () => {
    const updateChatRunner = vi.fn(() => Promise.resolve());
    const updateChatRunnerPermissions = vi.fn(() => Promise.resolve());
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
    const updateChatRunner = vi.fn(() => Promise.reject(new Error('nope')));
    const updateChatRunnerPermissions = vi.fn(() => Promise.resolve());
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
