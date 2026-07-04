import type { ChatGptResetCredit } from '@mangostudio/shared/connectors';
import type { Messages } from '@mangostudio/shared/i18n';
import { useI18n } from '@/hooks/use-i18n';
import { formatCompactDuration } from './ChatGptUsageMeter';

type ConnectorMessages = Messages['settings']['connectors'];

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
 * expires. Spent and expired credits render dimmed as the reset history.
 */
export function ChatGptResetCreditList({ credits }: { credits: ChatGptResetCredit[] }) {
  const { t, locale } = useI18n();
  const s = t.settings.connectors;
  const now = Date.now();

  return (
    <ul className="space-y-1">
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
            className={`flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[11px] ${
              isActive ? 'text-on-surface-variant' : 'text-on-surface-variant/40'
            }`}
          >
            <span className="font-medium">
              {credit.title ?? credit.resetType ?? s.chatgptCreditFallbackTitle}
            </span>
            <span
              className={`rounded-full border px-1.5 py-px text-[9px] uppercase tracking-wide ${
                isActive
                  ? 'border-primary/40 text-primary'
                  : 'border-outline-variant/30 text-on-surface-variant/50'
              }`}
            >
              {statusLabel(credit.status, s)}
            </span>
            {meta.length > 0 && <span className="text-[10px]">{meta.join(' · ')}</span>}
          </li>
        );
      })}
    </ul>
  );
}
