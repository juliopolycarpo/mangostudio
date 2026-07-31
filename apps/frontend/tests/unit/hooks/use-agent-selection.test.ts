import { createMockChat } from '@mangostudio/shared/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatWithContext } from '../../../src/features/chat/queries';
import { useAgentSelection } from '../../../src/hooks/use-agent-selection';
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

describe('useAgentSelection workdir binding', () => {
  const updateChatAgentSelection = vi.fn(() => Promise.resolve());
  const updateChatWorkdir = vi.fn(() => Promise.resolve());
  const addRecentWorkdir = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('applies the default workdir without blocking the mode switch', async () => {
    const { result } = renderHook(() =>
      useAgentSelection({
        currentChatId: CHAT.id,
        currentChat: CHAT,
        defaultWorkdir: '/srv/projects/default',
        updateChatAgentSelection,
        updateChatWorkdir,
        addRecentWorkdir,
      })
    );

    act(() => result.current.setAgentExecutionMode('agent'));

    expect(result.current.agentExecutionMode).toBe('agent');
    await waitFor(() =>
      expect(updateChatWorkdir).toHaveBeenCalledWith(CHAT.id, '/srv/projects/default')
    );
    expect(result.current.isWorkdirPickerOpen).toBe(false);
  });

  it('opens the picker when Agent mode has no chat or default workdir', () => {
    const { result } = renderHook(() =>
      useAgentSelection({
        currentChatId: CHAT.id,
        currentChat: CHAT,
        defaultWorkdir: '',
        updateChatAgentSelection,
        updateChatWorkdir,
        addRecentWorkdir,
      })
    );

    act(() => result.current.setAgentExecutionMode('agent'));

    expect(result.current.agentExecutionMode).toBe('agent');
    expect(result.current.isWorkdirPickerOpen).toBe(true);
  });

  it('binds a selected workdir, records it as recent, and closes the picker', async () => {
    const { result } = renderHook(() =>
      useAgentSelection({
        currentChatId: CHAT.id,
        currentChat: CHAT,
        defaultWorkdir: '',
        updateChatAgentSelection,
        updateChatWorkdir,
        addRecentWorkdir,
      })
    );
    act(() => result.current.openWorkdirPicker());

    await act(async () => {
      await result.current.selectWorkdir('/srv/projects/mango');
    });

    expect(updateChatWorkdir).toHaveBeenCalledWith(CHAT.id, '/srv/projects/mango');
    expect(addRecentWorkdir).toHaveBeenCalledWith('/srv/projects/mango');
    expect(result.current.isWorkdirPickerOpen).toBe(false);
  });
});
