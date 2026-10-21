import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { ICON_SM } from '@/lib/icon-sizes';

interface TurnMetaRowProps {
  /** The glyph that says how the turn ended; drawn at `ICON_SM` in the row's own colour. */
  icon: LucideIcon;
  children: ReactNode;
}

/**
 * The line that closes a turn: how long it took and how it ended.
 *
 * One anatomy for every turn kind — a MangoStudio text turn, an image turn and
 * an external agent's turn all end on it — so the reader finds the same fact in
 * the same place, one indent in from the rail like every other block of a turn.
 * Quiet metadata: `fg-subtle`, mono at `text-micro`, the glyph in the same
 * colour, because the words carry the outcome and a status colour here would
 * be louder than the turn above it.
 *
 * Usage: <TurnMetaRow icon={Sparkles}>Responded in 12.8s</TurnMetaRow>
 */
export function TurnMetaRow({ icon: Icon, children }: TurnMetaRowProps) {
  return (
    <div className="flex w-fit max-w-2xl items-center gap-1.5 pl-4 font-mono text-micro text-fg-subtle">
      <Icon size={ICON_SM} aria-hidden="true" className="shrink-0" />
      {children}
    </div>
  );
}
