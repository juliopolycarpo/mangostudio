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
      {open ? <connectedPalette.Overlay onClose={onClose} onLoadFailed={onClose} /> : null}
    </AnimatePresence>
  );
}
