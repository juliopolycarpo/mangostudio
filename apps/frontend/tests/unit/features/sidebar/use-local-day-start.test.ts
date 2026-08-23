/**
 * The sidebar's day clock. The bug it exists to prevent only shows up in a
 * shell that stays mounted, so the assertion that matters is the *second*
 * midnight: one wake is a fix for one night, re-arming is the fix.
 */

import { afterEach, describe, expect, it, jest } from 'bun:test';
import { useLocalDayStart } from '@/features/sidebar/hooks/use-local-day-start';
import { startOfLocalDay } from '@/features/sidebar/lib/group-chats';
import { renderHook } from '../../../support/harness/render';
import {
  advanceTimersByTimeAsync,
  restoreRealTimers,
  useFakeTimers,
} from '../../../support/harness/timers';

const HOUR_MS = 3_600_000;
/** Sunday 2026-08-23, midday local time. */
const NOON = new Date(2026, 7, 23, 12, 0, 0).getTime();

afterEach(async () => {
  await restoreRealTimers();
});

describe('useLocalDayStart', () => {
  it('starts on today, then re-reads the day at each midnight it stays up for', async () => {
    useFakeTimers();
    jest.setSystemTime(NOON);

    const { result } = renderHook(() => useLocalDayStart());
    expect(result.current).toBe(startOfLocalDay(NOON).getTime());

    await advanceTimersByTimeAsync(12 * HOUR_MS);
    expect(new Date(result.current).getDate()).toBe(24);

    // The re-arm: a single `setTimeout` fixes one night and then leaves the
    // sidebar exactly as stale as it was before.
    await advanceTimersByTimeAsync(24 * HOUR_MS);
    expect(new Date(result.current).getDate()).toBe(25);
  });

  it('does not re-render before midnight arrives', async () => {
    useFakeTimers();
    jest.setSystemTime(NOON);

    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useLocalDayStart();
    });
    const initialRenders = renders;

    await advanceTimersByTimeAsync(11 * HOUR_MS + 59 * 60_000);
    expect(renders).toBe(initialRenders);
    expect(new Date(result.current).getDate()).toBe(23);
  });
});
