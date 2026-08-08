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
});
