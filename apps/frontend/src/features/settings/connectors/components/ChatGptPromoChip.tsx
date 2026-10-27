import { Megaphone, X } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { useI18n } from '@/hooks/use-i18n';
import { ICON_MD } from '@/lib/icon-sizes';

const dismissalKey = (connectorId: string) => `mango.chatgpt-promo-dismissed:${connectorId}`;

function readDismissedMessage(connectorId: string): string | null {
  try {
    return window.localStorage.getItem(dismissalKey(connectorId));
  } catch {
    return null;
  }
}

/**
 * Dismissible announcement for the occasional ChatGPT promo message, drawn as
 * an info `Callout`. Dismissal is remembered per connector and per message, so
 * a new message shows up again while the dismissed one stays hidden.
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
    <Callout
      tone="info"
      icon={<Megaphone size={ICON_MD} />}
      action={
        <Button
          variant="subtle"
          size="icon-sm"
          onClick={dismiss}
          title={t.settings.connectors.chatgptPromoDismiss}
          aria-label={t.settings.connectors.chatgptPromoDismiss}
        >
          <X size={ICON_MD} />
        </Button>
      }
    >
      {message}
    </Callout>
  );
}
