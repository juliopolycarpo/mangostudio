/**
 * The hub's compact view of "what changed" — a few of the newest events
 * across every chat and machine.
 *
 * Renders `ActivityFeed` in `compact` mode rather than its own row markup, so
 * the strip and any future full list agree on what one row looks like. Silent
 * on load, on error, and on an empty feed: this card is optional context, and
 * the hub's one rule is that nothing here may stop somebody from starting a
 * chat. `environment_health_changed` and `quota_refreshed` rows are safe to
 * show beside the cards that already report *current* health and quota — this
 * feed only ever names the *transition* into that state, never the reading
 * itself.
 */

import { SectionCard } from '@/components/ui/SectionCard';
import { HubSkeletonLines } from '@/features/home/widgets/HubSkeletonLines';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';
import { ActivityFeed } from './ActivityFeed';
import { countNewSince } from './lib/group-activity';
import { useActivityBookmark } from './use-activity-bookmark';
import { useActivity } from './useActivity';

/** More than this and the strip stops being a glance. */
const ACTIVITY_STRIP_ROW_LIMIT = 5;

export function ActivityStrip() {
  const { t } = useI18n();
  const labels = t.home.activity;
  const { events, isLoading, isError } = useActivity({ limit: ACTIVITY_STRIP_ROW_LIMIT });
  const lastSeenAt = useActivityBookmark();

  if (isError) return null;
  if (isLoading) {
    return (
      <SectionCard label={labels.label} tone="accent" className="sm:col-span-2">
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
      className="sm:col-span-2"
      action={
        newCount > 0 ? (
          <span className="micro-label text-primary/80">
            {formatMessage(labels.newCount, { count: String(newCount) })}
          </span>
        ) : undefined
      }
    >
      <ActivityFeed events={events} compact maxRows={ACTIVITY_STRIP_ROW_LIMIT} />
    </SectionCard>
  );
}
