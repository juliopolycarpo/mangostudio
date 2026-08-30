/**
 * The hook is the one place the vocabulary meets the user's OS preference.
 * Under the harness `useReducedMotion()` is pinned to `true`, so this asserts
 * the branch a component test would actually get — and that the hook hands back
 * the shared constant rather than rebuilding presets per render.
 */

import { describe, expect, it } from 'bun:test';
import { renderHook } from '@testing-library/react';
import { useMotionPresets } from '@/lib/motion/use-motion-presets';
import { motionPresets } from '@/lib/motion/variants';

describe('useMotionPresets', () => {
  it('resolves to the still presets under the harness reduced-motion stub', () => {
    const { result } = renderHook(() => useMotionPresets());
    expect(result.current).toBe(motionPresets(true));
  });

  it('returns the same object across renders, so motion props stay stable', () => {
    const { result, rerender } = renderHook(() => useMotionPresets());
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });
});
