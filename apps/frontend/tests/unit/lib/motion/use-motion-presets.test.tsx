/**
 * The hook is the one place the vocabulary meets the user's OS preference. It
 * reads `matchMedia` itself (see `use-motion-presets.ts` for why), so these
 * tests stub `window.matchMedia` directly rather than relying on the
 * `motion/react` test double.
 */

import { afterEach, describe, expect, it, jest } from 'bun:test';
import { act, renderHook } from '@testing-library/react';
import { useMotionPresets } from '@/lib/motion/use-motion-presets';
import { motionPresets } from '@/lib/motion/variants';

const harnessMatchMedia = globalThis.matchMedia;

function stubReducedMotion(initialMatches: boolean) {
  const listeners = new Set<() => void>();
  let matches = initialMatches;
  globalThis.matchMedia = jest.fn().mockImplementation((query: string) => ({
    get matches() {
      return matches;
    },
    media: query,
    onchange: null,
    addListener: jest.fn(),
    removeListener: jest.fn(),
    addEventListener: (_event: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_event: string, listener: () => void) => listeners.delete(listener),
    dispatchEvent: jest.fn(),
  })) as unknown as typeof globalThis.matchMedia;

  return {
    flip(next: boolean) {
      matches = next;
      for (const listener of listeners) listener();
    },
  };
}

afterEach(() => {
  globalThis.matchMedia = harnessMatchMedia;
});

describe('useMotionPresets', () => {
  it('resolves to the still presets when the OS prefers reduced motion', () => {
    stubReducedMotion(true);
    const { result } = renderHook(() => useMotionPresets());
    expect(result.current).toBe(motionPresets(true));
  });

  it('returns the same object across renders, so motion props stay stable', () => {
    stubReducedMotion(false);
    const { result, rerender } = renderHook(() => useMotionPresets());
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });

  it('switches presets when the OS preference flips while mounted', () => {
    const query = stubReducedMotion(false);
    const { result } = renderHook(() => useMotionPresets());
    expect(result.current).toBe(motionPresets(false));

    act(() => query.flip(true));
    expect(result.current).toBe(motionPresets(true));
  });
});
