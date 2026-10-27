/**
 * Initial cards capture the entrance before commit. The committed grid gives
 * later mounts its settled label, without depending on a library callback.
 * The browser test separately proves that the initial stagger still plays.
 */

import { describe, expect, it } from 'bun:test';

import { renderHook } from '@testing-library/react';

import { useCardGrid } from '@/lib/motion/use-card-grid';
import { useMotionPresets } from '@/lib/motion/use-motion-presets';
import { CARD_ENTER, CARD_REST } from '@/lib/motion/variants';

describe('useCardGrid', () => {
  it('arms initial cards before commit and settles later mounts after commit', () => {
    const renderLabels: string[] = [];
    const { result } = renderHook(() => {
      const grid = useCardGrid();
      renderLabels.push(grid.initial);
      return grid;
    });
    expect(renderLabels[0]).toBe(CARD_REST);
    expect(result.current.initial).toBe(CARD_ENTER);
    expect(result.current.animate).toBe(CARD_ENTER);
  });

  it('carries the grid variants through, so the stagger still comes from one place', () => {
    const { result } = renderHook(() => ({ grid: useCardGrid(), presets: useMotionPresets() }));
    expect(result.current.grid.variants).toBe(result.current.presets.cardGrid.variants);
  });

  it('keeps later renders settled', () => {
    const { result, rerender } = renderHook(() => useCardGrid());
    rerender();
    expect(result.current.initial).toBe(CARD_ENTER);
  });

  it('arms each newly mounted grid independently', () => {
    const firstLabels: string[] = [];
    const secondLabels: string[] = [];
    renderHook(() => firstLabels.push(useCardGrid().initial));
    renderHook(() => secondLabels.push(useCardGrid().initial));
    expect(firstLabels[0]).toBe(CARD_REST);
    expect(secondLabels[0]).toBe(CARD_REST);
    expect(firstLabels.at(-1)).toBe(CARD_ENTER);
    expect(secondLabels.at(-1)).toBe(CARD_ENTER);
  });
});
