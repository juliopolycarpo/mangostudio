import { beforeEach, describe, expect, it, jest, mock } from 'bun:test';
import { DEFAULT_WORKSPACE_SETTINGS } from '@mangostudio/shared/app-settings';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { setTestSession } from '../../support/setup/auth-client-stub';

const actualQueries = await import('../../../src/features/chat/queries');

mock.module('../../../src/features/chat/queries', () => ({
  ...actualQueries,
  useMessagesQuery: () => ({
    data: { pages: [{ messages: [], contextInfo: null }] },
    status: 'success',
  }),
}));

function WorkspaceRailStub({ chatId }: { chatId: string }) {
  return <div data-testid="workspace-rail">{chatId}</div>;
}

mock.module('../../../src/features/workspace/rail/WorkspaceRail', () => ({
  WorkspaceRail: WorkspaceRailStub,
}));

function PinnedTodoPanelStub({ chatId }: { chatId: string | null }) {
  return <div data-testid="pinned-todos">{chatId}</div>;
}

mock.module('../../../src/features/chat/components/PinnedTodoPanel', () => ({
  PinnedTodoPanel: PinnedTodoPanelStub,
}));

// After the mock, never before: a static import is evaluated first and would
// bind ChatPage to the real queries and rail components.
const { ChatPage } = await import('../../../src/features/chat/ChatPage');
const { DEFAULT_CONTEXT_SETTINGS } = await import('../../../src/hooks/use-global-settings');
const { render } = await import('../../support/harness/render');

beforeEach(() => {
  setTestSession({ user: { id: 'user-1', name: 'Taylor Tester' } });
});

function renderChatPage(overrides: Partial<React.ComponentProps<typeof ChatPage>> = {}) {
  const props: React.ComponentProps<typeof ChatPage> = {
    chatId: 'chat-1',
    onSubmit: jest.fn(),
    disabled: false,
    isGenerating: false,
    onStop: jest.fn(),
    thinkingEnabled: false,
    reasoningEffort: 'medium',
    onThinkingToggle: jest.fn(),
    onReasoningEffortChange: jest.fn(),
    reasoningVisible: false,
    contextInfo: {
      estimatedInputTokens: 90_000,
      contextLimit: 100_000,
      estimatedUsageRatio: 0.9,
      mode: 'replay',
      severity: 'warning',
    },
    fallbackNotice: null,
    seedContextInfo: jest.fn(),
    contextSettings: DEFAULT_CONTEXT_SETTINGS,
    isContextActionPending: false,
    onCompactCurrentChat: jest.fn().mockResolvedValue(undefined),
    onStartSummarizedChat: jest.fn().mockResolvedValue(undefined),
    onResumeInterruptedTurn: jest.fn().mockResolvedValue(undefined),
    onDismissInterruptedTurn: jest.fn().mockResolvedValue(undefined),
    imageToolIntent: false,
    onImageToolIntentChange: jest.fn(),
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
