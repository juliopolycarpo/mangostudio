import { beforeEach, describe, expect, it, jest, mock } from 'bun:test';
import type { Connector } from '@mangostudio/shared';
import type { ChatGptUsageSnapshot } from '@mangostudio/shared/connectors';
import { fireEvent, render, screen, waitFor } from '../../support/harness/render';

const mockRedeemChatGptResetCredit = jest.fn();

mock.module('@/features/settings/connectors/api', () => ({
  redeemChatGptResetCredit: (...args: unknown[]) => mockRedeemChatGptResetCredit(...args),
}));

// After the mock, never before: a static import is evaluated first and would
// bind the action to the real connectors API.
const { ChatGptResetCreditAction } = await import(
  '@/features/settings/connectors/components/ChatGptResetCreditAction'
);

function makeConnector(usage: Partial<ChatGptUsageSnapshot>): Connector {
  return {
    id: 'connector-1',
    name: 'my-chatgpt',
    provider: 'chatgpt',
    configured: true,
    source: 'bun-secrets',
    maskedSuffix: '****...1234',
    updatedAt: Date.now(),
    enabledModels: [],
    userId: 'user-1',
    baseUrl: null,
    usage: { capturedAt: Date.now(), source: 'endpoint', ...usage },
  } as unknown as Connector;
}

describe('ChatGptResetCreditAction', () => {
  beforeEach(() => {
    mockRedeemChatGptResetCredit.mockReset();
  });

  it.each([
    ['no limit reached, credits available', { resetCredits: { availableCount: 2 } }],
    ['limit reached, no credits', { limitReached: true, resetCredits: { availableCount: 0 } }],
    ['limit reached, credits missing', { limitReached: true }],
  ] as const)('renders nothing when %s', (_label, usage) => {
    render(
      <ChatGptResetCreditAction connector={makeConnector(usage)} onRedeemed={() => undefined} />
    );

    expect(screen.queryByText('Use a rate-limit reset')).not.toBeInTheDocument();
  });

  it('shows the button when a window is exhausted and a credit is available', () => {
    render(
      <ChatGptResetCreditAction
        connector={makeConnector({ limitReached: true, resetCredits: { availableCount: 2 } })}
        onRedeemed={() => undefined}
      />
    );

    expect(screen.getByText('Use a rate-limit reset')).toBeInTheDocument();
  });

  it('never redeems without confirmation and cancels cleanly', () => {
    render(
      <ChatGptResetCreditAction
        connector={makeConnector({ limitReached: true, resetCredits: { availableCount: 2 } })}
        onRedeemed={() => undefined}
      />
    );

    fireEvent.click(screen.getByText('Use a rate-limit reset'));
    expect(screen.getByText('Use a rate-limit reset?')).toBeInTheDocument();
    expect(screen.getByText(/spends one of your 2 reset credits/)).toBeInTheDocument();

    fireEvent.click(screen.getByText('Cancel'));
    expect(screen.queryByText('Use a rate-limit reset?')).not.toBeInTheDocument();
    expect(mockRedeemChatGptResetCredit).not.toHaveBeenCalled();
  });

  it('redeems after confirmation and notifies the caller', async () => {
    mockRedeemChatGptResetCredit.mockResolvedValue({ code: 'reset', windowsReset: 1 });
    const onRedeemed = jest.fn();
    render(
      <ChatGptResetCreditAction
        connector={makeConnector({ limitReached: true, resetCredits: { availableCount: 1 } })}
        onRedeemed={onRedeemed}
      />
    );

    fireEvent.click(screen.getByText('Use a rate-limit reset'));
    fireEvent.click(screen.getByText('Use reset'));

    await waitFor(() => expect(onRedeemed).toHaveBeenCalledTimes(1));
    expect(mockRedeemChatGptResetCredit).toHaveBeenCalledWith(
      'connector-1',
      expect.stringMatching(/^[0-9a-f-]{36}$/)
    );
    expect(screen.queryByText('Use a rate-limit reset?')).not.toBeInTheDocument();
  });

  it('surfaces the windows restored by the last redemption in the next confirmation', async () => {
    mockRedeemChatGptResetCredit.mockResolvedValue({ code: 'reset', windowsReset: 2 });
    const onRedeemed = jest.fn();
    render(
      <ChatGptResetCreditAction
        connector={makeConnector({ limitReached: true, resetCredits: { availableCount: 2 } })}
        onRedeemed={onRedeemed}
      />
    );

    fireEvent.click(screen.getByText('Use a rate-limit reset'));
    expect(screen.queryByText(/restored 2 window/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Use reset'));
    await waitFor(() => expect(onRedeemed).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByText('Use a rate-limit reset'));
    expect(screen.getByText(/restored 2 window\(s\)/)).toBeInTheDocument();
  });
});
