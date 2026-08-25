/**
 * Day bucketing for the activity feed: Today, Yesterday, then one bucket per
 * explicit calendar date. Local time, not UTC — "what happened today" is a
 * question asked in the reader's own day.
 *
 * Deliberately simpler than the sidebar's `groupChatsByDate`: the feed has no
 * "this week" or per-month buckets, because it is read a page at a time
 * rather than scrolled through months of history.
 */

import type { ActivityEvent } from '@mangostudio/shared/activity';

export interface ActivityDayGroup {
  readonly key: string;
  readonly kind: 'today' | 'yesterday' | 'date';
  readonly dayStartMs: number;
  readonly events: ActivityEvent[];
}

const DAY_MS = 86_400_000;

function startOfLocalDay(ms: number): Date {
  const date = new Date(ms);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/**
 * Buckets events by local calendar day, preserving the input's order inside
 * each day. Groups come out in the order their first event is seen, so a
 * newest-first input (the feed's own order) produces newest-first groups.
 * Future timestamps land in Today rather than inventing a "later" bucket for
 * a skewed clock.
 */
export function groupActivityByDay(
  events: readonly ActivityEvent[],
  now: Date
): ActivityDayGroup[] {
  const today = startOfLocalDay(now.getTime());
  const groups = new Map<string, ActivityDayGroup>();
  const order: string[] = [];

  for (const event of events) {
    const day = startOfLocalDay(event.createdAt);
    const dayDiff = Math.round((today.getTime() - day.getTime()) / DAY_MS);
    const kind: ActivityDayGroup['kind'] =
      dayDiff <= 0 ? 'today' : dayDiff === 1 ? 'yesterday' : 'date';
    const key = kind === 'date' ? `date-${day.getTime()}` : kind;

    const existing = groups.get(key);
    if (existing) {
      existing.events.push(event);
      continue;
    }
    order.push(key);
    groups.set(key, { key, kind, dayStartMs: day.getTime(), events: [event] });
  }

  return order.map((key) => {
    const group = groups.get(key);
    if (!group) throw new Error(`activity group vanished for key ${key}`);
    return group;
  });
}

/**
 * The label a group renders under. A `date` group's label comes from
 * `Intl.DateTimeFormat` rather than a hand-written table, so it reads in
 * whichever locale is active.
 */
export function activityDayGroupLabel(
  group: ActivityDayGroup,
  labels: { today: string; yesterday: string },
  locale: string
): string {
  if (group.kind === 'today') return labels.today;
  if (group.kind === 'yesterday') return labels.yesterday;
  return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long' }).format(
    group.dayStartMs
  );
}

/**
 * Index into `events` of the first row older than or equal to `lastSeenAt` —
 * the boundary the "since your last visit" divider sits above. `-1` when
 * there is nothing to mark: no bookmark yet, every event still newer than it,
 * or — index `0` — nothing new at all, where a divider at the very top would
 * promise rows above it that do not exist.
 */
export function findLastSeenBoundary(
  events: readonly ActivityEvent[],
  lastSeenAt: number | null
): number {
  if (lastSeenAt === null) return -1;
  const boundary = events.findIndex((event) => event.createdAt <= lastSeenAt);
  return boundary <= 0 ? -1 : boundary;
}

/**
 * How many of these landed after the account last looked — the number the hub
 * card leads with, because "what changed since your last session" is a count
 * before it is a list.
 *
 * `0` without a bookmark: a first visit has no "since" to measure against, and
 * announcing the whole page as new would be a badge that never goes away.
 */
export function countNewSince(events: readonly ActivityEvent[], lastSeenAt: number | null): number {
  if (lastSeenAt === null) return 0;
  return events.filter((event) => event.createdAt > lastSeenAt).length;
}
