/**
 * Mounts the palette, and nothing else, while it is open.
 *
 * The split matters: `useCommandRegistry` subscribes to environment discovery
 * and external-agent probing, and neither should be paid for by a user who
 * never presses ⌘K. Rendering the connected half only when open makes "open the
 * palette" the moment those queries start. The connected half is also a lazy
 * chunk (`ConnectedPalette`), fetched on the first open or when the chord's
 * modifier key goes down.
 */

import { AnimatePresence } from 'motion/react';

import { createLazyOverlay } from '@/components/layout/LazyOverlay';

import type { ConnectedPaletteProps } from './ConnectedPalette';
import { PaletteFrame } from './PaletteFrame';

const connectedPalette = createLazyOverlay<ConnectedPaletteProps>(() =>
  import('./ConnectedPalette').then((module) => ({ default: module.ConnectedPalette }))
);

/** Starts fetching the palette's chunk; safe to call any number of times. */
export const preloadCommandPalette = connectedPalette.preload;

export interface CommandPaletteHostProps {
  readonly open: boolean;
  /** Stable across renders — the registry closes over it for every row. */
  readonly onClose: () => void;
}

export function CommandPaletteHost({ open, onClose }: CommandPaletteHostProps) {
  return (
    <AnimatePresence>
      {open ? (
        // The frame is eager: it owns the input from the first commit, so keys
        // typed while the results chunk is still in flight land here, not in the
        // page behind. Only the results are lazy.
        <PaletteFrame onClose={onClose}>
          {(frame) => (
            <connectedPalette.Overlay {...frame} onClose={onClose} onLoadFailed={onClose} />
          )}
        </PaletteFrame>
      ) : null}
    </AnimatePresence>
  );
}
