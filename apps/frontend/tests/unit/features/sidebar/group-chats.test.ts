/**
 * Bucket edges for the sidebar's date grouping. Every case injects its own
 * clock — local-midnight boundaries are exactly where an uncontrolled
 * `Date.now()` makes a test lie twice a day.
 */

import { describe, expect, it } from 'bun:test';
import type { Chat } from '@mangostudio/shared';
import { chatGroupLabel, groupChatsByDate } from '@/features/sidebar/lib/group-chats';

const LABELS = { today: 'Today', yesterday: 'Yesterday', thisWeek: 'This week' };

/** Sunday 2026-08-23, midday local time. */
const NOW = new Date(2026, 7, 23, 12, 0, 0);

function chatAt(id: string, updatedAt: number): Chat {
  return {
    id,
    title: id,
    updatedAt,
    workdir: null,
    runner: { kind: 'mangostudio', agentId: 'default' },
  } as unknown as Chat;
}

function local(...args: [number, number, number, number?, number?, number?]): number {
  return new Date(...args).getTime();
}

describe('groupChatsByDate', () => {
  it('splits today and yesterday exactly at local midnight', () => {
    const groups = groupChatsByDate(
      [
        chatAt('after-midnight', local(2026, 7, 23, 0, 0, 0)),
        chatAt('before-midnight', local(2026, 7, 22, 23, 59, 59)),
      ],
      NOW
    );
    expect(groups.map((g) => g.kind)).toEqual(['today', 'yesterday']);
    expect(groups[0]?.chats.map((c) => c.id)).toEqual(['after-midnight']);
    expect(groups[1]?.chats.map((c) => c.id)).toEqual(['before-midnight']);
  });

  it('keeps this-week to the last six days and hands day seven to its month', () => {
    const groups = groupChatsByDate(
      [
        chatAt('two-days', local(2026, 7, 21, 23, 59, 0)),
        chatAt('six-days', local(2026, 7, 17, 0, 0, 0)),
        chatAt('seven-days', local(2026, 7, 16, 23, 59, 0)),
      ],
      NOW
    );
    expect(groups.map((g) => g.kind)).toEqual(['thisWeek', 'month']);
    expect(groups[0]?.chats.map((c) => c.id)).toEqual(['two-days', 'six-days']);
    expect(groups[1]?.chats.map((c) => c.id)).toEqual(['seven-days']);
  });

  it('buckets older chats by their own calendar month and year', () => {
    const groups = groupChatsByDate(
      [
        chatAt('july', local(2026, 6, 31, 10, 0, 0)),
        chatAt('december', local(2025, 11, 1, 10, 0, 0)),
      ],
      NOW
    );
    expect(groups.map((g) => g.key)).toEqual(['month-2026-6', 'month-2025-11']);
  });

  it('treats a future timestamp as today instead of inventing a bucket', () => {
    const groups = groupChatsByDate([chatAt('skewed', local(2026, 7, 24, 3, 0, 0))], NOW);
    expect(groups.map((g) => g.kind)).toEqual(['today']);
  });

  it('merges same-bucket chats even when the input is not sorted', () => {
    const groups = groupChatsByDate(
      [
        chatAt('a', local(2026, 7, 23, 11, 0, 0)),
        chatAt('old', local(2026, 5, 1, 0, 0, 0)),
        chatAt('b', local(2026, 7, 23, 9, 0, 0)),
      ],
      NOW
    );
    expect(groups).toHaveLength(2);
    expect(groups[0]?.chats.map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('returns no groups for no chats', () => {
    expect(groupChatsByDate([], NOW)).toEqual([]);
  });
});

describe('chatGroupLabel', () => {
  const groupFor = (updatedAt: number) => {
    const group = groupChatsByDate([chatAt('x', updatedAt)], NOW)[0];
    if (!group) throw new Error('expected a group');
    return group;
  };

  it('uses the provided labels for the relative buckets', () => {
    expect(chatGroupLabel(groupFor(NOW.getTime()), LABELS, 'en', NOW)).toBe('Today');
    expect(chatGroupLabel(groupFor(local(2026, 7, 22, 8, 0, 0)), LABELS, 'en', NOW)).toBe(
      'Yesterday'
    );
    expect(chatGroupLabel(groupFor(local(2026, 7, 20, 8, 0, 0)), LABELS, 'en', NOW)).toBe(
      'This week'
    );
  });

  it('derives month names from the locale, not a table', () => {
    const july = groupFor(local(2026, 6, 2, 8, 0, 0));
    expect(chatGroupLabel(july, LABELS, 'en', NOW)).toBe('July');
    expect(chatGroupLabel(july, LABELS, 'pt-BR', NOW)).toBe('julho');
  });

  it('names the year for a month outside the current one', () => {
    const december = groupFor(local(2025, 11, 24, 8, 0, 0));
    expect(chatGroupLabel(december, LABELS, 'en', NOW)).toContain('December');
    expect(chatGroupLabel(december, LABELS, 'en', NOW)).toContain('2025');
  });
});
