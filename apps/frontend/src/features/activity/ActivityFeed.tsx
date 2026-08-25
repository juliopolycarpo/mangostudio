/**
 * The activity list, in two densities.
 *
 * `compact` is the hub strip's five rows: no day headers, no "since your last
 * visit" divider, just the newest events. The full density adds both, so
 * `ActivityStrip` and any future full list agree on what one row looks like —
 * same icon, same relative time, same `describeActivity()` sentence — instead
 * of two components each rendering their own copy of an activity row.
 */

import type { ActivityEvent } from '@mangostudio/shared/activity';
import type { Messages } from '@mangostudio/shared/i18n';
import type { StatusDotTone } from '@/components/ui/StatusDot';
import { useI18n } from '@/hooks/use-i18n';
import { formatRelativeTime } from '@/lib/i18n-format';
import { describeActivity } from './lib/describe-activity';
import {
  activityDayGroupLabel,
  findLastSeenBoundary,
  groupActivityByDay,
} from './lib/group-activity';

export interface ActivityFeedProps {
  readonly events: readonly ActivityEvent[];
  /** Tight rows, no day headers, no "since your last visit" divider. */
  readonly compact?: boolean;
  /** Caps the rendered rows; anything past it is simply not shown. */
  readonly maxRows?: number;
  /** Ignored when `compact`: the divider sits above the first row at or before this. */
  readonly lastSeenAt?: number | null;
}

const TONE_ICON_CLASS: Record<StatusDotTone, string> = {
  accent: 'text-primary',
  success: 'text-success',
  warning: 'text-warning',
  error: 'text-error',
  neutral: 'text-on-surface-variant/60',
};

export function ActivityFeed({
  events,
  compact = false,
  maxRows,
  lastSeenAt = null,
}: ActivityFeedProps) {
  const { t, locale } = useI18n();
  const labels = t.home.activity;
  const rows = maxRows !== undefined ? events.slice(0, maxRows) : events;

  if (rows.length === 0) {
    return <p className="text-xs text-on-surface-variant/70">{labels.empty}</p>;
  }

  if (compact) {
    return (
      <ul className="space-y-2">
        {rows.map((event) => (
          <li key={event.id}>
            <ActivityRow event={event} locale={locale} t={t} />
          </li>
        ))}
      </ul>
    );
  }

  const groups = groupActivityByDay(rows, new Date());
  const dividerIndex = findLastSeenBoundary(rows, lastSeenAt);
  let index = -1;

  return (
    <div className="space-y-4">
      {groups.map((group) => (
        <div key={group.key} className="space-y-2">
          <p className="micro-label text-on-surface-variant/60">
            {activityDayGroupLabel(group, labels, locale)}
          </p>
          <ul className="space-y-2">
            {group.events.map((event) => {
              index += 1;
              const showDivider = index === dividerIndex;
              return (
                <li key={event.id}>
                  {showDivider ? (
                    <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-primary/70">
                      {labels.sinceLastVisit}
                    </p>
                  ) : null}
                  <ActivityRow event={event} locale={locale} t={t} />
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}

function ActivityRow({ event, locale, t }: { event: ActivityEvent; locale: string; t: Messages }) {
  const { text, icon: Icon, tone } = describeActivity(event, t, locale);
  return (
    <div className="flex min-w-0 items-start gap-2 text-sm">
      <Icon aria-hidden="true" className={`mt-0.5 size-3.5 shrink-0 ${TONE_ICON_CLASS[tone]}`} />
      <p className="min-w-0 flex-1 truncate text-on-surface-variant">{text}</p>
      <time
        dateTime={new Date(event.createdAt).toISOString()}
        className="shrink-0 text-xs text-on-surface-variant/50"
      >
        {formatRelativeTime(event.createdAt, locale)}
      </time>
    </div>
  );
}
