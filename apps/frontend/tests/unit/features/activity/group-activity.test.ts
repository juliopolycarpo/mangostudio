/**
 * Bucket edges for the activity feed's date grouping and the "since your last
 * visit" boundary. Every case injects its own clock — local-midnight
 * boundaries are exactly where an uncontrolled `Date.now()` makes a test lie
 * twice a day.
 */

import { describe, expect, it } from 'bun:test';
import type { ActivityEvent } from '@mangostudio/shared/activity';
import {
  activityDayGroupLabel,
  countNewSince,
  findLastSeenBoundary,
  groupActivityByDay,
} from '@/features/activity/lib/group-activity';

const LABELS = { today: 'Today', yesterday: 'Yesterday' };

/** Sunday 2026-08-23, midday local time. */
const NOW = new Date(2026, 7, 23, 12, 0, 0);

function local(...args: [number, number, number, number?, number?, number?]): number {
  return new Date(...args).getTime();
}

function eventAt(id: string, createdAt: number): ActivityEvent {
  return {
    id,
    createdAt,
    chatId: null,
    workdir: null,
    environmentId: null,
    targetId: null,
    kind: 'chat_created',
    payload: { title: id },
  };
}

describe('groupActivityByDay', () => {
  it('splits today and yesterday exactly at local midnight', () => {
    const groups = groupActivityByDay(
      [
        eventAt('after-midnight', local(2026, 7, 23, 0, 0, 0)),
        eventAt('before-midnight', local(2026, 7, 22, 23, 59, 59)),
      ],
      NOW
    );
    expect(groups.map((g) => g.kind)).toEqual(['today', 'yesterday']);
    expect(groups[0]?.events.map((e) => e.id)).toEqual(['after-midnight']);
    expect(groups[1]?.events.map((e) => e.id)).toEqual(['before-midnight']);
  });

  it('buckets older events by their own calendar date', () => {
    const groups = groupActivityByDay([eventAt('last-week', local(2026, 7, 16, 10, 0, 0))], NOW);
    expect(groups.map((g) => g.kind)).toEqual(['date']);
    expect(groups[0]?.key).toBe(`date-${new Date(2026, 7, 16).getTime()}`);
  });

  it('treats a future timestamp as today instead of inventing a bucket', () => {
    const groups = groupActivityByDay([eventAt('skewed', local(2026, 7, 24, 3, 0, 0))], NOW);
    expect(groups.map((g) => g.kind)).toEqual(['today']);
  });

  it('merges same-day events even when the input is not sorted by day', () => {
    const groups = groupActivityByDay(
      [
        eventAt('a', local(2026, 7, 23, 11, 0, 0)),
        eventAt('old', local(2026, 6, 1, 0, 0, 0)),
        eventAt('b', local(2026, 7, 23, 9, 0, 0)),
      ],
      NOW
    );
    expect(groups).toHaveLength(2);
    expect(groups[0]?.events.map((e) => e.id)).toEqual(['a', 'b']);
  });

  it('returns no groups for no events', () => {
    expect(groupActivityByDay([], NOW)).toEqual([]);
  });
});

describe('activityDayGroupLabel', () => {
  const groupFor = (createdAt: number) => {
    const group = groupActivityByDay([eventAt('x', createdAt)], NOW)[0];
    if (!group) throw new Error('expected a group');
    return group;
  };

  it('uses the provided labels for today and yesterday', () => {
    expect(activityDayGroupLabel(groupFor(NOW.getTime()), LABELS, 'en')).toBe('Today');
    expect(activityDayGroupLabel(groupFor(local(2026, 7, 22, 8, 0, 0)), LABELS, 'en')).toBe(
      'Yesterday'
    );
  });

  it('derives the date from Intl rather than a hand-written table', () => {
    const group = groupFor(local(2026, 6, 2, 8, 0, 0));
    expect(activityDayGroupLabel(group, LABELS, 'en')).toBe('July 2');
    expect(activityDayGroupLabel(group, LABELS, 'pt-BR')).toBe('2 de julho');
  });
});

describe('findLastSeenBoundary', () => {
  const events = [
    eventAt('newest', local(2026, 7, 23, 11, 0, 0)),
    eventAt('middle', local(2026, 7, 23, 9, 0, 0)),
    eventAt('oldest', local(2026, 7, 22, 9, 0, 0)),
  ];

  it('returns -1 with no bookmark yet', () => {
    expect(findLastSeenBoundary(events, null)).toBe(-1);
  });

  it('returns -1 when every event is newer than the bookmark', () => {
    expect(findLastSeenBoundary(events, local(2026, 7, 20, 0, 0, 0))).toBe(-1);
  });

  it('finds the first event at or before the bookmark', () => {
    expect(findLastSeenBoundary(events, local(2026, 7, 23, 10, 0, 0))).toBe(1);
  });

  it('treats an exact match as at-or-before, not strictly after', () => {
    expect(findLastSeenBoundary(events, local(2026, 7, 23, 9, 0, 0))).toBe(1);
  });

  it('returns -1 when nothing is new, rather than a divider above the first row', () => {
    expect(findLastSeenBoundary(events, local(2026, 7, 23, 11, 30, 0))).toBe(-1);
  });
});

describe('countNewSince', () => {
  const events = [
    eventAt('newest', local(2026, 7, 23, 11, 0, 0)),
    eventAt('middle', local(2026, 7, 23, 9, 0, 0)),
    eventAt('oldest', local(2026, 7, 22, 9, 0, 0)),
  ];

  it('is 0 without a bookmark, so a first visit shows no badge', () => {
    expect(countNewSince(events, null)).toBe(0);
  });

  it('counts only what landed strictly after the bookmark', () => {
    expect(countNewSince(events, local(2026, 7, 23, 10, 0, 0))).toBe(1);
  });

  it('does not count an exact match as new', () => {
    expect(countNewSince(events, local(2026, 7, 23, 11, 0, 0))).toBe(0);
  });

  it('counts everything when the bookmark predates the page', () => {
    expect(countNewSince(events, local(2026, 7, 20, 0, 0, 0))).toBe(3);
  });
});
