import { ChevronDown } from 'lucide-react';

import { ICON_SM } from '@/lib/icon-sizes';
import { cn } from '@/lib/utils';

interface DisclosureChevronProps {
  /** Whether the thing it discloses is open. Open points up, closed points down. */
  expanded: boolean;
  /** Placement, e.g. `ml-auto`. */
  className?: string;
}

/**
 * The one disclosure mark in the transcript: a trailing `ChevronDown` that turns
 * 180deg when its section opens.
 *
 * It replaces four idioms that had drifted apart across the feed — a chevron
 * revealed on hover (tool rows), one that stayed and flipped (image card), a
 * leading right-pointing one that turned down (subagent card) and an up/down
 * swap (todo panel). A reader learns the mark once only if it is the same mark,
 * on the same side, turning the same way — and always on show: a row that hides
 * its chevron until the pointer arrives gives no sign at rest that it opens. Turning a glyph rather than swapping
 * two also lets the turn animate.
 *
 * Decorative: the control it sits in carries `aria-expanded`, which is what
 * assistive technology reads.
 *
 * // Usage: <DisclosureChevron expanded={open} className="ml-auto" />
 */
export function DisclosureChevron({ expanded, className }: DisclosureChevronProps) {
  return (
    <ChevronDown
      size={ICON_SM}
      aria-hidden="true"
      className={cn(
        'shrink-0 text-fg-subtle transition-transform duration-(--duration-base)',
        expanded && 'rotate-180',
        className
      )}
    />
  );
}
