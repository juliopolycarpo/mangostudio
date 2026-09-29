/**
 * The route container skips its entrance fade on the first mount only. The
 * `motion/react` stub strips animation props before they reach the DOM, so the
 * contract is asserted on the hook's return value — the exact props the
 * authenticated layout spreads onto its re-keyed `motion.div`.
 *
 * `useMotionPresets` reads `window.matchMedia` itself, so each test pins the
 * preference with a named fake rather than trusting happy-dom's default.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { renderHook } from '@testing-library/react';
import { useRouteEntrance } from '@/lib/motion/use-route-entrance';
import { motionPresets } from '@/lib/motion/variants';

const harnessMatchMedia = globalThis.matchMedia;

/** Listener registration the fake accepts and ignores: nothing ever fires. */
const ignoreListener = (): void => undefined;

/** A `matchMedia` that answers every query with a fixed `matches`, and never
 *  fires `change` — these tests do not flip the preference mid-run. */
function fakeReducedMotionPreference(matches: boolean): typeof globalThis.matchMedia {
  return ((query: string) => ({
    matches,
    media: query,
    onchange: null,
    addListener: ignoreListener,
    removeListener: ignoreListener,
    addEventListener: ignoreListener,
    removeEventListener: ignoreListener,
    dispatchEvent: () => false,
  })) as unknown as typeof globalThis.matchMedia;
}

function renderEntrance(firstPage: string, reduced = false) {
  globalThis.matchMedia = fakeReducedMotionPreference(reduced);
  return renderHook(({ page }) => useRouteEntrance(page), {
    initialProps: { page: firstPage },
  });
}

afterEach(() => {
  globalThis.matchMedia = harnessMatchMedia;
});

describe('useRouteEntrance', () => {
  it('first mount: starts settled (initial false), not from opacity 0', () => {
    const { result } = renderEntrance('chat');

    expect(result.current.initial).toBe(false);
    expect(result.current.animate).toBe(motionPresets(false).fade.animate);
  });

  it('first mount: stays settled across re-renders on the same page', () => {
    // The layout re-renders once per streamed token; none of those is a navigation.
    const { result, rerender } = renderEntrance('chat');

    rerender({ page: 'chat' });
    rerender({ page: 'chat' });

    expect(result.current.initial).toBe(false);
  });

  it('later navigation: fades in from the fade preset', () => {
    const { result, rerender } = renderEntrance('chat');

    rerender({ page: 'settings' });

    const { fade } = motionPresets(false);
    expect(result.current.initial).toBe(fade.initial);
    expect(result.current.animate).toBe(fade.animate);
    expect(result.current.transition).toBe(fade.transition);
  });

  it('later navigation: returning to the first page still fades', () => {
    const { result, rerender } = renderEntrance('chat');

    rerender({ page: 'settings' });
    rerender({ page: 'chat' });

    expect(result.current.initial).toBe(motionPresets(false).fade.initial);
  });

  it('reduced motion: first mount settled, later navigation uses the still preset', () => {
    const { result, rerender } = renderEntrance('chat', true);
    expect(result.current.initial).toBe(false);

    rerender({ page: 'gallery' });

    const still = motionPresets(true).fade;
    expect(result.current.initial).toBe(still.initial);
    expect(result.current.transition).toBe(still.transition);
    expect(result.current.transition.duration).toBe(0);
  });
});
