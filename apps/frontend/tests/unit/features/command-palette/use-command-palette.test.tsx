/**
 * The global chord's wiring: it toggles, it repeats once, and it claims nothing
 * it did not handle — the composer has to keep receiving every other keystroke.
 */

import { describe, expect, it } from 'bun:test';
import { act } from '@testing-library/react';
import { useCommandPalette } from '../../../../src/features/command-palette/use-command-palette';
import { renderHook } from '../../../support/harness/render';

function dispatchChord(overrides: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key: 'k',
    ctrlKey: true,
    cancelable: true,
    bubbles: true,
    ...overrides,
  });
  act(() => {
    window.dispatchEvent(event);
  });
  return event;
}

describe('useCommandPalette', () => {
  it('starts closed and toggles on the chord', () => {
    const { result } = renderHook(() => useCommandPalette());
    expect(result.current.isOpen).toBe(false);

    dispatchChord();
    expect(result.current.isOpen).toBe(true);

    // The same chord is the way back out — no second binding to remember.
    dispatchChord();
    expect(result.current.isOpen).toBe(false);
  });

  it('claims the chord and nothing else', () => {
    renderHook(() => useCommandPalette());
    expect(dispatchChord().defaultPrevented).toBe(true);
    expect(dispatchChord({ key: 'j' }).defaultPrevented).toBe(false);
    expect(dispatchChord({ ctrlKey: false, metaKey: false }).defaultPrevented).toBe(false);
  });

  it('treats a held key as one press rather than a flicker', () => {
    const { result } = renderHook(() => useCommandPalette());
    dispatchChord();
    dispatchChord({ repeat: true });
    dispatchChord({ repeat: true });
    expect(result.current.isOpen).toBe(true);
  });

  it('opens and closes from the header affordance too', () => {
    const { result } = renderHook(() => useCommandPalette());
    act(() => result.current.open());
    expect(result.current.isOpen).toBe(true);
    act(() => result.current.close());
    expect(result.current.isOpen).toBe(false);
  });

  it('stops listening once the shell unmounts', () => {
    const { result, unmount } = renderHook(() => useCommandPalette());
    unmount();
    expect(dispatchChord().defaultPrevented).toBe(false);
    expect(result.current.isOpen).toBe(false);
  });
});
