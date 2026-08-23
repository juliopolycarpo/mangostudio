/**
 * Open state for the palette, plus the one global chord that toggles it.
 *
 * The listener is registered once on the shell rather than per surface, and it
 * only ever claims mod+K — `preventDefault` fires on the chord and on nothing
 * else, so plain typing in the composer is untouched. Toggling rather than
 * opening is what makes the chord its own escape hatch.
 */

import { useCallback, useEffect, useState } from 'react';
import { isCommandPaletteShortcut } from '@/lib/keyboard';

export interface CommandPaletteState {
  readonly isOpen: boolean;
  readonly open: () => void;
  readonly close: () => void;
}

export function useCommandPalette(): CommandPaletteState {
  const [isOpen, setIsOpen] = useState(false);

  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => setIsOpen(false), []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // An auto-repeating chord is one press, not a stream of toggles.
      if (event.repeat || !isCommandPaletteShortcut(event)) return;
      event.preventDefault();
      setIsOpen((current) => !current);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return { isOpen, open, close };
}
