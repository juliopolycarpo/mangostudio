import { Megaphone, X } from 'lucide-react';
import { useState } from 'react';
import { useI18n } from '@/hooks/use-i18n';

const dismissalKey = (connectorId: string) => `mango.chatgpt-promo-dismissed:${connectorId}`;

function readDismissedMessage(connectorId: string): string | null {
  try {
    return window.localStorage.getItem(dismissalKey(connectorId));
  } catch {
    return null;
  }
}

/**
 * Dismissible announcement chip for the occasional ChatGPT promo message.
 * Dismissal is remembered per connector and per message, so a new message
 * shows up again while the dismissed one stays hidden.
 */
export function ChatGptPromoChip({
  connectorId,
  message,
}: {
  connectorId: string;
  message: string;
}) {
  const { t } = useI18n();
  const [dismissedMessage, setDismissedMessage] = useState(() => readDismissedMessage(connectorId));

  if (dismissedMessage === message) return null;

  const dismiss = () => {
    setDismissedMessage(message);
    try {
      window.localStorage.setItem(dismissalKey(connectorId), message);
    } catch {
      // Session-only dismissal is fine when storage is unavailable.
    }
  };

  return (
    <div className="mt-1.5 flex max-w-xs items-start gap-2 rounded-xl border border-primary/20 bg-primary/5 px-3 py-2">
      <Megaphone size={14} className="mt-0.5 shrink-0 text-primary/80" />
      <p className="flex-1 text-[11px] leading-relaxed text-on-surface-variant">{message}</p>
      <button
        type="button"
        onClick={dismiss}
        title={t.settings.connectors.chatgptPromoDismiss}
        aria-label={t.settings.connectors.chatgptPromoDismiss}
        className="shrink-0 cursor-pointer opacity-50 transition-opacity hover:opacity-100"
      >
        <X size={12} />
      </button>
    </div>
  );
}
