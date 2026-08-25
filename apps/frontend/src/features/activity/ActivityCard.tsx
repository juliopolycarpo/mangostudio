/**
 * "What changed" as a card, in the two densities the app asks for it.
 *
 * `compact` is the chat hub's five rows beside the composer; the full density
 * is the dashboard's column, with day headers and the "since your last visit"
 * divider. One component rather than two because everything around the rows is
 * the same either way — the same query, the same bookmark, the same silence on
 * load, on error and on an empty feed.
 *
 * That silence is the rule this card exists under: it is optional context, and
 * nothing here may stop somebody from starting a chat.
 * `environment_health_changed` and `quota_refreshed` rows are safe to show
 * beside the cards that already report *current* health and quota — this feed
 * only ever names the *transition* into that state, never the reading itself.
 */

import { SectionCard } from '@/components/ui/SectionCard';
import { HubSkeletonLines } from '@/features/home/widgets/HubSkeletonLines';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';
import { ActivityFeed } from './ActivityFeed';
import { countNewSince } from './lib/group-activity';
import { useActivityBookmark } from './use-activity-bookmark';
import { useActivity } from './useActivity';

/** More than this beside a composer and the strip stops being a glance. */
export const ACTIVITY_STRIP_ROWS = 5;

export interface ActivityCardProps {
  /** Page size, which is also the row cap. Bounded on purpose: page one only. */
  readonly limit: number;
  /** Tight rows, no day headers, no divider — the chat hub's strip. */
  readonly compact?: boolean;
  readonly className?: string;
}

export function ActivityCard({ limit, compact = false, className }: ActivityCardProps) {
  const { t } = useI18n();
  const labels = t.home.activity;
  const { events, isLoading, isError } = useActivity({ limit });
  const lastSeenAt = useActivityBookmark();

  if (isError) return null;
  if (isLoading) {
    return (
      <SectionCard label={labels.label} tone="accent" className={className}>
        <HubSkeletonLines />
      </SectionCard>
    );
  }
  if (events.length === 0) return null;

  // The point of the card, in one number: the hub's greeting promises to say
  // what changed since last time, and without the bookmark this is just a list
  // of things that happened at some point.
  const newCount = countNewSince(events, lastSeenAt);

  return (
    <SectionCard
      label={labels.label}
      tone="accent"
      className={className}
      action={
        newCount > 0 ? (
          <span className="micro-label text-primary/80">
            {formatMessage(labels.newCount, { count: String(newCount) })}
          </span>
        ) : undefined
      }
    >
      <ActivityFeed events={events} compact={compact} maxRows={limit} lastSeenAt={lastSeenAt} />
    </SectionCard>
  );
}
