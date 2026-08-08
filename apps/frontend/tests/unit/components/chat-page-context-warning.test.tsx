import { DEFAULT_WORKSPACE_SETTINGS } from '@mangostudio/shared/app-settings';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ChatPage } from '../../../src/features/chat/ChatPage';
import { DEFAULT_CONTEXT_SETTINGS } from '../../../src/hooks/use-global-settings';
import { render } from '../../support/harness/render';

vi.mock('../../../src/features/chat/queries', () => ({
  useMessagesQuery: () => ({
    data: { pages: [{ messages: [], contextInfo: null }] },
    status: 'success',
  }),
}));

vi.mock('../../../src/lib/auth-client', () => ({
  authClient: {
    useSession: () => ({ data: { user: { name: 'Taylor Tester' } } }),
  },
}));

vi.mock('../../../src/features/workspace/rail/WorkspaceRail', () => ({
  WorkspaceRail: ({ chatId }: { chatId: string }) => (
    <div data-testid="workspace-rail">{chatId}</div>
  ),
}));

vi.mock('../../../src/features/chat/components/PinnedTodoPanel', () => ({
  PinnedTodoPanel: ({ chatId }: { chatId: string | null }) => (
    <div data-testid="pinned-todos">{chatId}</div>
  ),
}));

function renderChatPage(overrides: Partial<React.ComponentProps<typeof ChatPage>> = {}) {
  const props: React.ComponentProps<typeof ChatPage> = {
    chatId: 'chat-1',
    onSubmit: vi.fn(),
    disabled: false,
    isGenerating: false,
    onStop: vi.fn(),
    thinkingEnabled: false,
    reasoningEffort: 'medium',
    onThinkingToggle: vi.fn(),
    onReasoningEffortChange: vi.fn(),
    reasoningVisible: false,
    contextInfo: {
      estimatedInputTokens: 90_000,
      contextLimit: 100_000,
      estimatedUsageRatio: 0.9,
      mode: 'replay',
      severity: 'warning',
    },
    fallbackNotice: null,
    seedContextInfo: vi.fn(),
    contextSettings: DEFAULT_CONTEXT_SETTINGS,
    isContextActionPending: false,
    onCompactCurrentChat: vi.fn().mockResolvedValue(undefined),
    onStartSummarizedChat: vi.fn().mockResolvedValue(undefined),
    onResumeInterruptedTurn: vi.fn().mockResolvedValue(undefined),
    onDismissInterruptedTurn: vi.fn().mockResolvedValue(undefined),
    imageToolIntent: false,
    onImageToolIntentChange: vi.fn(),
    ...overrides,
  };

  return { ...render(<ChatPage {...props} />), props };
}

describe('ChatPage context warning', () => {
  it('blocks submission until the user chooses to continue', async () => {
    const user = userEvent.setup();
    renderChatPage();

    await user.type(screen.getByRole('textbox'), 'hello');

    const sendButton = screen.getByRole('button', { name: 'Send' });
    expect(sendButton).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Continue anyway' }));

    expect(sendButton).toBeEnabled();
  });

  it('does not show the warning when compaction prompts are turned off', async () => {
    const user = userEvent.setup();
    renderChatPage({
      contextSettings: { ...DEFAULT_CONTEXT_SETTINGS, compactionBehavior: 'off' },
    });

    await user.type(screen.getByRole('textbox'), 'hello');

    expect(screen.queryByRole('button', { name: 'Continue anyway' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();
  });

  it('shows the workspace rail and falls back to the pinned panel when the rail hides todos', () => {
    const { props, rerender } = renderChatPage({
      workdir: '/srv/projects/mangostudio',
    });
    expect(screen.getByTestId('workspace-rail')).toHaveTextContent('chat-1');
    expect(screen.queryByTestId('pinned-todos')).not.toBeInTheDocument();

    rerender(
      <ChatPage
        {...props}
        workspaceSettings={{
          ...DEFAULT_WORKSPACE_SETTINGS,
          sidePanel: {
            ...DEFAULT_WORKSPACE_SETTINGS.sidePanel,
            visiblePanelIds: ['git'],
          },
        }}
      />
    );
    expect(screen.getByTestId('pinned-todos')).toHaveTextContent('chat-1');
  });
});
