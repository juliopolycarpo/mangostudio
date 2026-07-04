import type { Connector } from '@mangostudio/shared';
import { RefreshCw, Zap } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui/Toast';
import { useI18n } from '@/hooks/use-i18n';
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
  const { t } = useI18n();
  const { toast } = useToast();
  const s = t.settings.connectors;
  const [isConfirmOpen, setIsConfirmOpen] = useState(false);
  const { redeem, isRedeeming, lastWindowsReset } = useChatGptResetRedeem({
    connectorId: connector.id,
    messages: s,
    toast,
    onSettled: onRedeemed,
  });

  const availableCount = connector.usage?.resetCredits?.availableCount ?? 0;
  if (!connector.usage?.limitReached || availableCount < 1) return null;

  const handleConfirm = () => {
    setIsConfirmOpen(false);
    void redeem();
  };

  return (
    <div className="mt-1.5">
      <Button
        variant="secondary"
        size="sm"
        onClick={() => setIsConfirmOpen(true)}
        disabled={isRedeeming}
      >
        {isRedeeming ? (
          <>
            <RefreshCw size={14} className="animate-spin" />
            {s.chatgptRedeeming}
          </>
        ) : (
          <>
            <Zap size={14} />
            {s.chatgptRedeemButton}
          </>
        )}
      </Button>

      {isConfirmOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-background/80 backdrop-blur-sm animate-in fade-in duration-200">
          <div className="bg-surface-container-high w-full max-w-sm rounded-3xl p-5 sm:p-8 shadow-2xl border border-outline-variant/20 space-y-5 sm:space-y-6">
            <div className="space-y-2 text-center">
              <div className="p-4 bg-primary/10 rounded-full w-fit mx-auto text-primary mb-2">
                <Zap size={32} />
              </div>
              <h3 className="text-xl font-bold text-on-surface">{s.chatgptRedeemConfirmTitle}</h3>
              <p className="text-sm text-on-surface-variant/70">
                {s.chatgptRedeemConfirmBody.replace('{count}', String(availableCount))}
                {lastWindowsReset !== null &&
                  lastWindowsReset > 0 &&
                  ` ${s.chatgptRedeemConfirmRestores.replace('{count}', String(lastWindowsReset))}`}
              </p>
            </div>

            <div className="flex gap-3">
              <Button
                variant="secondary"
                onClick={() => setIsConfirmOpen(false)}
                className="flex-1"
              >
                {s.cancelButton}
              </Button>
              <Button variant="primary" onClick={handleConfirm} className="flex-1">
                {s.chatgptRedeemConfirmAction}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
