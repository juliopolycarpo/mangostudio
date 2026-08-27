/**
 * The clock behind every "updated 2 minutes ago" label.
 *
 * The interesting arms are the two that are not "it ticks": a `null` interval
 * must leave no timer behind, and re-enabling one must not hand the caller the
 * timestamp it captured at mount — a panel that was refreshing for a minute
 * would otherwise resume from a stale anchor.
 */

import { describe, expect, it } from 'bun:test';
import { renderHook } from '../../support/harness/render';
import { advanceTimersByTimeAsync, useFakeTimers } from '../../support/harness/timers';

const { useNow } = await import('../../../src/hooks/use-now');

describe('useNow', () => {
  it('re-reads the clock on every interval', async () => {
    useFakeTimers();
    const { result } = renderHook(() => useNow(30_000));
    const first = result.current;

    await advanceTimersByTimeAsync(30_000);

    expect(result.current).toBeGreaterThanOrEqual(first + 30_000);
  });

  it('does not tick while the interval is null', async () => {
    useFakeTimers();
    const { result } = renderHook(() => useNow(null));
    const first = result.current;

    await advanceTimersByTimeAsync(120_000);

    expect(result.current).toBe(first);
  });

  it('catches up immediately when the interval is re-enabled', async () => {
    useFakeTimers();
    const { result, rerender } = renderHook(
      ({ intervalMs }: { intervalMs: number | null }) => useNow(intervalMs),
      { initialProps: { intervalMs: null as number | null } }
    );
    const first = result.current;

    await advanceTimersByTimeAsync(120_000);
    rerender({ intervalMs: 30_000 });

    expect(result.current).toBeGreaterThanOrEqual(first + 120_000);
  });
});
