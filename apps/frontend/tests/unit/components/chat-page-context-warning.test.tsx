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
    imageToolIntent: false,
    onImageToolIntentChange: vi.fn(),
    ...overrides,
  };

  render(<ChatPage {...props} />);
  return props;
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
});
