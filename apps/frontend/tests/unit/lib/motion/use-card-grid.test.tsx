/**
 * The hook exists for one reason: a hub card that mounts after the grid has
 * entered must not inherit the pre-entrance `initial`. That handover is a state
 * flip driven by `onAnimationComplete`, and the `motion/react` stub strips
 * animation props before they reach the DOM — so it is asserted on the hook's
 * own return value, not on a rendered tree.
 */

import { describe, expect, it } from 'bun:test';
import { act, renderHook } from '@testing-library/react';
import { useCardGrid } from '@/lib/motion/use-card-grid';
import { useMotionPresets } from '@/lib/motion/use-motion-presets';
import { CARD_ENTER, CARD_REST } from '@/lib/motion/variants';

describe('useCardGrid', () => {
  it('arms the entrance before the grid has played it', () => {
    const { result } = renderHook(() => useCardGrid());
    expect(result.current.initial).toBe(CARD_REST);
    expect(result.current.animate).toBe(CARD_ENTER);
  });

  it('carries the grid variants through, so the stagger still comes from one place', () => {
    const { result } = renderHook(() => ({ grid: useCardGrid(), presets: useMotionPresets() }));
    expect(result.current.grid.variants).toBe(result.current.presets.cardGrid.variants);
  });

  it('hands the settled state to late arrivals once the entrance completes', () => {
    const { result } = renderHook(() => useCardGrid());

    act(() => result.current.onAnimationComplete(CARD_ENTER));

    expect(result.current.initial).toBe(CARD_ENTER);
  });

  it('ignores the completion of any other variant', () => {
    const { result } = renderHook(() => useCardGrid());

    act(() => result.current.onAnimationComplete(CARD_REST));

    expect(result.current.initial).toBe(CARD_REST);
  });
});
