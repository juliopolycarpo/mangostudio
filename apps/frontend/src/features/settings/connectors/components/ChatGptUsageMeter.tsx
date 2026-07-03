import type { ChatGptUsageSnapshot } from '@mangostudio/shared/connectors';
import type { Messages } from '@mangostudio/shared/i18n';
import { useI18n } from '@/hooks/use-i18n';
import { computeBurnPace } from '../lib/usage-pace';

type ConnectorMessages = Messages['settings']['connectors'];
type UsageWindow = NonNullable<ChatGptUsageSnapshot['primary']>;

/** Snapshots older than this get an "updated … ago" hint on the meter. */
const STALE_HINT_MS = 5 * 60_000;

/** Compact duration for countdowns: "42m", "3h 20m", "6d 4h". */
export function formatCompactDuration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const restMinutes = minutes % 60;
    return restMinutes > 0 ? `${hours}h ${restMinutes}m` : `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours > 0 ? `${days}d ${restHours}h` : `${days}d`;
}

function windowLabel(window: UsageWindow, fallback: string, s: ConnectorMessages): string {
  if (window.windowMinutes === undefined) return fallback;
  const hours = window.windowMinutes / 60;
  if (hours >= 24) {
    return s.chatgptUsageWindowDays.replace('{days}', String(Math.round(hours / 24)));
  }
  return s.chatgptUsageWindowHours.replace('{hours}', String(Math.round(hours)));
}

function UsageWindowBar({
  window,
  fallbackLabel,
  s,
  now,
}: {
  window: UsageWindow;
  fallbackLabel: string;
  s: ConnectorMessages;
  now: number;
}) {
  const percent = Math.min(100, Math.max(0, window.usedPercent));
  const showReset = window.resetsAt !== undefined && window.resetsAt > now;
  const pace = computeBurnPace(window, now);
  const paceLabel =
    pace &&
    (pace.status === 'runningHot'
      ? pace.projectedExhaustionAt !== undefined && pace.projectedExhaustionAt > now
        ? `${s.chatgptPaceRunningHot} · ${s.chatgptPaceProjected.replace(
            '{time}',
            formatCompactDuration(pace.projectedExhaustionAt - now)
          )}`
        : s.chatgptPaceRunningHot
      : s.chatgptPaceOnPace);
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2 text-[10px] text-on-surface-variant/60">
        <span>{windowLabel(window, fallbackLabel, s)}</span>
        <span>
          {s.chatgptUsageUsed.replace('{percent}', String(Math.round(percent)))}
          {showReset &&
            ` · ${s.chatgptUsageResets.replace(
              '{time}',
              formatCompactDuration((window.resetsAt as number) - now)
            )}`}
          {paceLabel && (
            <>
              {' · '}
              <span className={pace?.status === 'runningHot' ? 'text-amber-200/90' : undefined}>
                {paceLabel}
              </span>
            </>
          )}
        </span>
      </div>
      <div
        role="progressbar"
        aria-valuenow={Math.round(percent)}
        aria-valuemin={0}
        aria-valuemax={100}
        className="h-1.5 overflow-hidden rounded-full bg-surface-container-high"
      >
        <div
          className={`h-full rounded-full ${percent >= 90 ? 'bg-error/80' : 'bg-primary/70'}`}
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}

/**
 * Compact plan-quota meter for a ChatGPT connector: window bars with reset
 * countdowns, plus reset-credit and pay-as-you-go credit lines when present.
 */
export function ChatGptUsageMeter({ usage }: { usage: ChatGptUsageSnapshot }) {
  const { t } = useI18n();
  const s = t.settings.connectors;
  const now = Date.now();

  const footer: string[] = [];
  if (usage.resetCredits && usage.resetCredits.availableCount > 0) {
    let line = s.chatgptUsageResetCredits.replace(
      '{count}',
      String(usage.resetCredits.availableCount)
    );
    if (usage.resetCredits.nextExpiresAt !== undefined && usage.resetCredits.nextExpiresAt > now) {
      line += ` · ${s.chatgptUsageResetCreditsNextExpiry.replace(
        '{time}',
        formatCompactDuration(usage.resetCredits.nextExpiresAt - now)
      )}`;
    }
    footer.push(line);
  }
  if (usage.credits?.unlimited) {
    footer.push(s.chatgptUsageCreditsUnlimited);
  } else if (usage.credits?.balance !== undefined) {
    footer.push(s.chatgptUsageCreditsBalance.replace('{balance}', String(usage.credits.balance)));
  }
  if (now - usage.capturedAt > STALE_HINT_MS) {
    footer.push(
      s.chatgptUsageUpdated.replace('{time}', formatCompactDuration(now - usage.capturedAt))
    );
  }

  return (
    <div className="mt-1.5 max-w-xs space-y-1.5">
      {usage.limitReached && (
        <p className="text-[11px] font-medium text-amber-200/90">{s.chatgptUsageLimitReached}</p>
      )}
      {usage.primary && (
        <UsageWindowBar
          window={usage.primary}
          fallbackLabel={s.chatgptUsagePrimaryFallback}
          s={s}
          now={now}
        />
      )}
      {usage.secondary && (
        <UsageWindowBar
          window={usage.secondary}
          fallbackLabel={s.chatgptUsageSecondaryFallback}
          s={s}
          now={now}
        />
      )}
      {footer.length > 0 && (
        <p className="text-[10px] text-on-surface-variant/50">{footer.join(' · ')}</p>
      )}
    </div>
  );
}
