/**
 * Today's local midnight, re-read when the next one arrives.
 *
 * The sidebar buckets chats into Today / Yesterday / This week, which is a
 * comparison against the current day — and a shell left open overnight has
 * nothing that re-reads the clock, so yesterday's chats would keep sitting under
 * "Today" until the chat list, the search box or the locale happened to change.
 *
 * A millisecond value rather than a `Date`, because it is a memo dependency:
 * a fresh `Date` every render would be a fresh identity every render, and the
 * grouping it feeds is memoized precisely to avoid that.
 */

import { useEffect, useState } from 'react';
import { nextLocalMidnight, startOfLocalDay } from '../lib/group-chats';

export function useLocalDayStart(): number {
  // The counter is what re-arms, not the value it produces: a timer that fires a
  // hair early reads the same midnight back, and an effect keyed on the value
  // alone would then stay disarmed for the rest of the day — the exact bug this
  // hook exists to prevent.
  const [wakes, setWakes] = useState(0);
  const dayStartMs = startOfLocalDay(Date.now()).getTime();

  useEffect(() => {
    const timer = setTimeout(
      () => setWakes((count) => count + 1),
      Math.max(0, nextLocalMidnight(dayStartMs) - Date.now())
    );
    return () => clearTimeout(timer);
  }, [dayStartMs, wakes]);

  return dayStartMs;
}
