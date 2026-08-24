/**
 * Mounts the palette, and nothing else, while it is open.
 *
 * The split matters: `useCommandRegistry` subscribes to environment discovery
 * and external-agent probing, and neither should be paid for by a user who
 * never presses ⌘K. Rendering the connected half only when open makes "open the
 * palette" the moment those queries start.
 */

import { AnimatePresence } from 'motion/react';
import { CommandPalette } from './CommandPalette';
import { useCommandRegistry } from './use-command-registry';

export interface CommandPaletteHostProps {
  readonly open: boolean;
  /** Stable across renders — the registry closes over it for every row. */
  readonly onClose: () => void;
}

export function CommandPaletteHost({ open, onClose }: CommandPaletteHostProps) {
  return <AnimatePresence>{open ? <ConnectedPalette onClose={onClose} /> : null}</AnimatePresence>;
}

function ConnectedPalette({ onClose }: { onClose: () => void }) {
  const { items, isLoading } = useCommandRegistry(onClose);
  return <CommandPalette items={items} isLoading={isLoading} onClose={onClose} />;
}
