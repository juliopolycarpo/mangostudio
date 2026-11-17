/**
 * The palette's results wired to the command registry. Kept in its own module
 * so the ranking, the rows, the registry and the command sources load together,
 * the first time the palette opens, instead of with every page. The input is
 * not here: `PaletteFrame` is eager so typing is never lost to this chunk.
 */

import { PaletteResults } from './CommandPalette';
import type { PaletteFrameState } from './PaletteFrame';
import { useCommandRegistry } from './use-command-registry';

export interface ConnectedPaletteProps extends PaletteFrameState {
  readonly onClose: () => void;
}

export function ConnectedPalette({ onClose, ...frame }: ConnectedPaletteProps) {
  const { items, isLoading } = useCommandRegistry(onClose);
  return <PaletteResults {...frame} items={items} isLoading={isLoading} />;
}
