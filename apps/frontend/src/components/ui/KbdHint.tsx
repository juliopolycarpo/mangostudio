import { CornerDownLeft } from 'lucide-react';
import type { ReactNode } from 'react';

import { ICON_SM } from '@/lib/icon-sizes';
import { cn } from '@/lib/utils';

interface KbdHintProps {
  /** The shortcut as displayed: `⌘K`, `Esc`, or a glyph drawn as an icon, like {@link ReturnKey}. */
  keys: ReactNode;
  className?: string;
}

/**
 * Keyboard shortcut chip, sized to sit inside buttons and menu rows.
 *
 * Not drawn on a coarse pointer: a phone has no Esc or Ctrl+N, and a keycap
 * there points at a key the reader does not have. The rule lives here once
 * rather than at each call site, so the palette, the sidebar and the composer
 * cannot disagree about it. `pointer-coarse:` sorts after the breakpoints, so a
 * caller's `sm:inline-flex` does not bring it back on a touch screen.
 */
export function KbdHint({ keys, className }: KbdHintProps) {
  return (
    <kbd
      className={cn(
        'inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-xs border border-stroke bg-control px-1 font-mono text-micro font-medium leading-none text-fg-muted pointer-coarse:hidden',
        className
      )}
    >
      {/* Hidden from the accessible name: the shortcut hint must not rename the
          button it sits in ("Send", not "Send ⏎"). A flex box so an icon is
          centred on the keycap rather than sitting on a text baseline. */}
      <span aria-hidden="true" className="flex items-center">
        {keys}
      </span>
    </kbd>
  );
}

/**
 * The Return key as an icon.
 *
 * The `⏎` text glyph renders about 7px wide and hairline-thin at 11px mono, so
 * a keycap holding it read as an empty rounded square — and on the accent fill
 * its `border-current` outline was heavier than the glyph inside.
 *
 * // Usage: <KbdHint keys={<ReturnKey />} />
 */
export function ReturnKey() {
  return <CornerDownLeft size={ICON_SM} />;
}
