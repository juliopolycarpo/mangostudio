/**
 * Date bucketing for the session list: Today / Yesterday / This week, then one
 * bucket per calendar month. Bucketing is done in *local* time — the question
 * a group label answers is "when did I touch this", and that question is asked
 * in the user's own day, not UTC's.
 */

import type { Chat } from '@mangostudio/shared';

export type ChatGroup =
  | { kind: 'today' | 'yesterday' | 'thisWeek'; key: string; chats: Chat[] }
  | { kind: 'month'; key: string; monthStartMs: number; chats: Chat[] };

const DAY_MS = 86_400_000;

function startOfLocalDay(ms: number): Date {
  const date = new Date(ms);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/**
 * Buckets chats by `updatedAt`, preserving the input's order inside each
 * group. Groups come out newest-first when the input is sorted newest-first
 * (the chat list is). Future timestamps land in Today rather than inventing a
 * "later" bucket for a skewed clock.
 */
export function groupChatsByDate(chats: readonly Chat[], now: Date): ChatGroup[] {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const groups = new Map<string, ChatGroup>();

  for (const chat of chats) {
    const day = startOfLocalDay(chat.updatedAt);
    // Both ends are local midnights, so rounding absorbs the DST hour.
    const dayDiff = Math.round((today.getTime() - day.getTime()) / DAY_MS);

    let group: ChatGroup;
    if (dayDiff <= 0) {
      group = { kind: 'today', key: 'today', chats: [] };
    } else if (dayDiff === 1) {
      group = { kind: 'yesterday', key: 'yesterday', chats: [] };
    } else if (dayDiff < 7) {
      group = { kind: 'thisWeek', key: 'thisWeek', chats: [] };
    } else {
      const monthStart = new Date(day.getFullYear(), day.getMonth(), 1);
      group = {
        kind: 'month',
        key: `month-${monthStart.getFullYear()}-${monthStart.getMonth()}`,
        monthStartMs: monthStart.getTime(),
        chats: [],
      };
    }

    const existing = groups.get(group.key);
    if (existing) {
      existing.chats.push(chat);
    } else {
      group.chats.push(chat);
      groups.set(group.key, group);
    }
  }

  return [...groups.values()];
}

/**
 * The label a group renders under. Month names come from the active locale via
 * `Intl.DateTimeFormat` — never a hand-written month table — and a month from
 * another year says which year it was.
 */
export function chatGroupLabel(
  group: ChatGroup,
  labels: { today: string; yesterday: string; thisWeek: string },
  locale: string,
  now: Date
): string {
  if (group.kind !== 'month') return labels[group.kind];
  const month = new Date(group.monthStartMs);
  const options: Intl.DateTimeFormatOptions =
    month.getFullYear() === now.getFullYear()
      ? { month: 'long' }
      : { month: 'long', year: 'numeric' };
  return new Intl.DateTimeFormat(locale, options).format(month);
}
