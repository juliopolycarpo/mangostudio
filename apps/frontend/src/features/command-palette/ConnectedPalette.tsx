/**
 * The palette wired to its command registry. Kept in its own module so the
 * palette, the registry and the command sources load together, the first time
 * the palette opens, instead of with every page.
 */

import { CommandPalette } from './CommandPalette';
import { useCommandRegistry } from './use-command-registry';

export interface ConnectedPaletteProps {
  readonly onClose: () => void;
}

export function ConnectedPalette({ onClose }: ConnectedPaletteProps) {
  const { items, isLoading } = useCommandRegistry(onClose);
  return <CommandPalette items={items} isLoading={isLoading} onClose={onClose} />;
}
