import { beforeEach, describe, expect, it, jest, mock } from 'bun:test';
import { en } from '@mangostudio/shared/i18n';
import { act, renderHook } from '../../support/harness/render';

const mockRedeemChatGptResetCredit = jest.fn();

mock.module('../../../src/features/settings/connectors/api', () => ({
  redeemChatGptResetCredit: (...args: unknown[]) => mockRedeemChatGptResetCredit(...args),
}));

const { useChatGptResetRedeem } = await import(
  '../../../src/features/settings/connectors/hooks/use-chatgpt-reset-redeem'
);

const messages = en.settings.connectors;

function setup() {
  const toast = jest.fn();
  const onSettled = jest.fn();
  const rendered = renderHook(() =>
    useChatGptResetRedeem({ connectorId: 'connector-1', messages, toast, onSettled })
  );
  return { ...rendered, toast, onSettled };
}

describe('useChatGptResetRedeem', () => {
  beforeEach(() => {
    mockRedeemChatGptResetCredit.mockReset();
  });

  it('sends a fresh UUID per attempt and maps the reset outcome to a success toast', async () => {
    mockRedeemChatGptResetCredit.mockResolvedValue({ code: 'reset', windowsReset: 2 });
    const { result, toast, onSettled } = setup();

    await act(async () => {
      await result.current.redeem();
    });

    const [connectorId, requestId] = mockRedeemChatGptResetCredit.mock.calls[0] as [string, string];
    expect(connectorId).toBe('connector-1');
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(toast).toHaveBeenCalledWith(
      messages.chatgptRedeemSuccess.replace('{count}', '2'),
      'success'
    );
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it('reuses the same request id across failed retries and rotates it after an outcome', async () => {
    mockRedeemChatGptResetCredit.mockRejectedValueOnce(new Error('network down'));
    mockRedeemChatGptResetCredit.mockResolvedValueOnce({ code: 'reset', windowsReset: 1 });
    mockRedeemChatGptResetCredit.mockResolvedValueOnce({
      code: 'nothing_to_reset',
      windowsReset: 0,
    });
    const { result, toast } = setup();

    await act(async () => {
      await result.current.redeem();
    });
    expect(toast).toHaveBeenCalledWith(messages.chatgptRedeemFailed, 'error');

    await act(async () => {
      await result.current.redeem();
    });
    await act(async () => {
      await result.current.redeem();
    });

    const ids = mockRedeemChatGptResetCredit.mock.calls.map((call) => call[1] as string);
    expect(ids[0]).toBe(ids[1]);
    expect(ids[2]).not.toBe(ids[1]);
  });

  it.each([
    ['nothing_to_reset', messages.chatgptRedeemNothingToReset, 'info'],
    ['no_credit', messages.chatgptRedeemNoCredit, 'error'],
    ['already_redeemed', messages.chatgptRedeemAlreadyRedeemed, 'info'],
  ] as const)('maps the %s outcome to its toast', async (code, message, type) => {
    mockRedeemChatGptResetCredit.mockResolvedValue({ code, windowsReset: 0 });
    const { result, toast } = setup();

    await act(async () => {
      await result.current.redeem();
    });

    expect(toast).toHaveBeenCalledWith(message, type);
  });
});
