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
import { MicroLabel } from '@/components/ui/MicroLabel';
import type { StatusDotTone } from '@/components/ui/StatusDot';
import { useI18n } from '@/hooks/use-i18n';
import { formatRelativeTime } from '@/lib/i18n-format';
import { ICON_SM } from '@/lib/icon-sizes';
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

/**
 * Only a status earns a colour; every other tone reads as a resting icon. The
 * accent is not a status, so an event that merely happened is not tinted.
 */
const STATUS_ICON_CLASS: Partial<Record<StatusDotTone, string>> = {
  success: 'text-success',
  warning: 'text-warning',
  error: 'text-danger',
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
    return <p className="text-xs text-fg-muted">{labels.empty}</p>;
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
  // Resolved to an identity rather than a running index: the divider belongs to
  // one row, and `rows[-1]` is `undefined`, so "no divider" falls out for free
  // without the grouping having to agree on a flat ordering.
  const dividerEventId = rows[findLastSeenBoundary(rows, lastSeenAt)]?.id;

  return (
    <div className="space-y-4">
      {groups.map((group) => (
        <div key={group.key} className="space-y-2">
          <MicroLabel as="p">{activityDayGroupLabel(group, labels, locale)}</MicroLabel>
          <ul className="space-y-2">
            {group.events.map((event) => {
              const showDivider = event.id === dividerEventId;
              return (
                <li key={event.id}>
                  {showDivider ? (
                    <div className="mb-2 flex items-center gap-2">
                      <MicroLabel as="p">{labels.sinceLastVisit}</MicroLabel>
                      <span aria-hidden="true" className="h-px flex-1 bg-stroke" />
                    </div>
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
    <div className="flex min-w-0 items-center gap-2 text-sm">
      <Icon
        aria-hidden="true"
        size={ICON_SM}
        className={`shrink-0 ${STATUS_ICON_CLASS[tone] ?? 'text-fg-muted'}`}
      />
      <p className="min-w-0 flex-1 truncate text-fg-muted">{text}</p>
      <time
        dateTime={new Date(event.createdAt).toISOString()}
        className="shrink-0 text-xs text-fg-subtle"
      >
        {formatRelativeTime(event.createdAt, locale)}
      </time>
    </div>
  );
}
