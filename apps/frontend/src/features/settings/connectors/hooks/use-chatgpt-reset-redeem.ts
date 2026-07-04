/**
 * Hook: redeem a ChatGPT rate-limit reset credit.
 *
 * Redeeming spends a scarce, irreversible perk, so the idempotency key is
 * generated once per attempt and kept across failed retries — the backend can
 * then never double-spend on a network retry. Only a definitive outcome from
 * the backend clears the key for the next attempt.
 */

import type { ChatGptRedeemOutcome } from '@mangostudio/shared/connectors';
import type { Messages } from '@mangostudio/shared/i18n';
import { useCallback, useRef, useState } from 'react';
import { redeemChatGptResetCredit } from '../api';

type ToastType = 'success' | 'error' | 'info';

interface UseChatGptResetRedeemOptions {
  connectorId: string;
  messages: Messages['settings']['connectors'];
  toast: (message: string, type?: ToastType) => void;
  /** Called after every attempt (any outcome or failure) to refresh usage. */
  onSettled?: () => void | Promise<void>;
}

function outcomeToast(
  code: ChatGptRedeemOutcome,
  windowsReset: number,
  s: Messages['settings']['connectors']
): { message: string; type: ToastType } {
  switch (code) {
    case 'reset':
      return {
        message: s.chatgptRedeemSuccess.replace('{count}', String(windowsReset)),
        type: 'success',
      };
    case 'nothing_to_reset':
      return { message: s.chatgptRedeemNothingToReset, type: 'info' };
    case 'no_credit':
      return { message: s.chatgptRedeemNoCredit, type: 'error' };
    case 'already_redeemed':
      return { message: s.chatgptRedeemAlreadyRedeemed, type: 'info' };
  }
}

export function useChatGptResetRedeem({
  connectorId,
  messages,
  toast,
  onSettled,
}: UseChatGptResetRedeemOptions) {
  const [isRedeeming, setIsRedeeming] = useState(false);
  /** Windows restored by the last successful redemption; null until one lands. */
  const [lastWindowsReset, setLastWindowsReset] = useState<number | null>(null);
  const requestIdRef = useRef<string | null>(null);

  const redeem = useCallback(async () => {
    if (requestIdRef.current === null) requestIdRef.current = crypto.randomUUID();
    const redeemRequestId = requestIdRef.current;

    setIsRedeeming(true);
    try {
      const result = await redeemChatGptResetCredit(connectorId, redeemRequestId);
      requestIdRef.current = null;
      if (result.code === 'reset') setLastWindowsReset(result.windowsReset);
      const { message, type } = outcomeToast(result.code, result.windowsReset, messages);
      toast(message, type);
    } catch {
      // Keep the request id: the redemption state is unknown, so the retry
      // must replay the same idempotency key.
      toast(messages.chatgptRedeemFailed, 'error');
    } finally {
      setIsRedeeming(false);
      await onSettled?.();
    }
  }, [connectorId, messages, toast, onSettled]);

  return { redeem, isRedeeming, lastWindowsReset };
}
