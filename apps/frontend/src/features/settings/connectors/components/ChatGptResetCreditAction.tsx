import type { Connector } from '@mangostudio/shared/connectors';
import { Zap } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { useToast } from '@/components/ui/Toast';
import { useI18n } from '@/hooks/use-i18n';
import { usePlural } from '@/hooks/use-plural';
import { ICON_SM } from '@/lib/icon-sizes';

import { useChatGptResetRedeem } from '../hooks/use-chatgpt-reset-redeem';

interface ChatGptResetCreditActionProps {
  connector: Connector;
  /** Called after every redeem attempt so the caller can refresh usage. */
  onRedeemed: () => void | Promise<void>;
}

/**
 * "Use a rate-limit reset" action for a ChatGPT connector. Rendered only when
 * a window is exhausted AND a reset credit is available; always gated behind
 * a confirmation dialog because redeeming spends an irreversible perk.
 */
export function ChatGptResetCreditAction({ connector, onRedeemed }: ChatGptResetCreditActionProps) {
  const { t, locale } = useI18n();
  const plural = usePlural();
  const { toast } = useToast();
  const s = t.settings.connectors;
  const [isConfirmOpen, setIsConfirmOpen] = useState(false);
  const { redeem, isRedeeming, lastWindowsReset } = useChatGptResetRedeem({
    connectorId: connector.id,
    messages: s,
    locale,
    toast,
    onSettled: onRedeemed,
  });

  const availableCount = connector.usage?.resetCredits?.availableCount ?? 0;
  if (!connector.usage?.limitReached || availableCount < 1) return null;

  const handleConfirm = () => {
    setIsConfirmOpen(false);
    void redeem();
  };

  const confirmBody = [
    s.chatgptRedeemConfirmBody.replace('{count}', String(availableCount)),
    lastWindowsReset !== null && lastWindowsReset > 0
      ? plural(
          { one: s.chatgptRedeemConfirmRestoresOne, other: s.chatgptRedeemConfirmRestoresOther },
          lastWindowsReset
        )
      : null,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div>
      <Button
        variant="secondary"
        size="sm"
        onClick={() => setIsConfirmOpen(true)}
        loading={isRedeeming}
      >
        {isRedeeming ? null : <Zap size={ICON_SM} />}
        {isRedeeming ? s.chatgptRedeeming : s.chatgptRedeemButton}
      </Button>

      {isConfirmOpen && (
        <Dialog
          size="sm"
          title={s.chatgptRedeemConfirmTitle}
          description={confirmBody}
          onClose={() => setIsConfirmOpen(false)}
          footer={
            <>
              <Button variant="secondary" onClick={() => setIsConfirmOpen(false)}>
                {s.cancelButton}
              </Button>
              <Button variant="primary" onClick={handleConfirm}>
                {s.chatgptRedeemConfirmAction}
              </Button>
            </>
          }
        />
      )}
    </div>
  );
}
