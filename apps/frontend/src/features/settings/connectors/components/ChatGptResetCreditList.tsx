import type { ChatGptResetCredit } from '@mangostudio/shared/connectors';
import type { Messages } from '@mangostudio/shared/i18n';

import { Badge } from '@/components/ui/Badge';
import { useI18n } from '@/hooks/use-i18n';
import { cn } from '@/lib/utils';

import { formatCompactDuration } from './ChatGptUsageMeter';

type ConnectorMessages = Messages['settings']['connectors'];

/** Spent, expired and unknown credits are the history, so they stay neutral. */
const STATUS_BADGE: Partial<Record<string, 'success' | 'accent'>> = {
  available: 'success',
  redeeming: 'accent',
};

function statusLabel(status: string, s: ConnectorMessages): string {
  switch (status) {
    case 'available':
      return s.chatgptCreditStatusAvailable;
    case 'redeeming':
      return s.chatgptCreditStatusRedeeming;
    case 'redeemed':
      return s.chatgptCreditStatusRedeemed;
    case 'expired':
      return s.chatgptCreditStatusExpired;
    default:
      // The backend contract is unversioned: an unknown status must stay
      // visible as-is rather than crash or vanish.
      return status;
  }
}

/**
 * Per-credit breakdown of a ChatGPT connector's rate-limit reset credits:
 * what each credit restores, its status, when it was granted, and when it
 * expires. Spent and expired credits drop to `fg-subtle` as the reset history.
 */
export function ChatGptResetCreditList({ credits }: { credits: ChatGptResetCredit[] }) {
  const { t, locale } = useI18n();
  const s = t.settings.connectors;
  const now = Date.now();

  return (
    <ul className="space-y-2">
      {credits.map((credit) => {
        const isActive = credit.status === 'available' || credit.status === 'redeeming';
        const meta: string[] = [];
        if (credit.grantedAt !== undefined) {
          meta.push(
            s.chatgptCreditGranted.replace(
              '{date}',
              new Date(credit.grantedAt).toLocaleDateString(locale)
            )
          );
        }
        if (
          credit.status === 'available' &&
          credit.expiresAt !== undefined &&
          credit.expiresAt > now
        ) {
          meta.push(
            s.chatgptCreditExpires.replace('{time}', formatCompactDuration(credit.expiresAt - now))
          );
        }
        return (
          <li
            key={credit.id}
            title={credit.description}
            className={cn(
              'flex flex-wrap items-center gap-x-2 gap-y-1 text-xs',
              isActive ? 'text-fg-muted' : 'text-fg-subtle'
            )}
          >
            <span className="font-medium">
              {credit.title ?? credit.resetType ?? s.chatgptCreditFallbackTitle}
            </span>
            <Badge variant={STATUS_BADGE[credit.status] ?? 'neutral'}>
              {statusLabel(credit.status, s)}
            </Badge>
            {meta.length > 0 && <span>{meta.join(' · ')}</span>}
          </li>
        );
      })}
    </ul>
  );
}
