import { type HTMLMotionProps, motion } from 'motion/react';
import { type RefObject, useLayoutEffect, useRef, useState } from 'react';
import { useMotionPresets } from '@/lib/motion/use-motion-presets';
import { cn } from '@/lib/utils';

interface ComposerPopoverProps extends Omit<HTMLMotionProps<'div'>, 'ref'> {
  /**
   * The control that opened the panel. The panel keeps its left edge level with
   * it (clamped so it never overhangs the composer) and nothing else: the
   * vertical position belongs to the composer, not to the control.
   */
  readonly anchor?: RefObject<HTMLElement | null>;
  /** Fade and rise in, the way `ChipSelect`'s panel does. A palette that follows typing stays still. */
  readonly animated?: boolean;
}

/**
 * The surface every popover over the composer wears: `.dropdown-panel` (solid
 * `surface-raised`, a hairline, `shadow-popover`) rising from the composer.
 *
 * **Anchored to the composer's top edge, not to the control that opened it.**
 * The panel's positioned ancestor is `.composer-shell`, so its bottom edge sits
 * one 8px gap above the shell whichever chip opened it. Anchored to its own chip
 * instead, a status-line menu docked onto the shell's border (the chip is 7px
 * under it) while a tool-row menu covered the status line and the draft it sits
 * under: three relationships for one gesture. The wrapper around the trigger
 * therefore must not be `relative`.
 *
 * `overflow`, padding and spacing stay with the call site: a list wants `p-1`, a
 * form wants `p-3`, and `.dropdown-panel` lives in the components layer, so a
 * utility such as `overflow-y-auto` wins over its `overflow: hidden`.
 *
 * // Usage: <ComposerPopover anchor={triggerRef} className="max-h-96 space-y-3 overflow-y-auto p-3">…</ComposerPopover>
 */
export function ComposerPopover({
  anchor,
  animated = false,
  className,
  style,
  ...props
}: ComposerPopoverProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [left, setLeft] = useState<number | undefined>(undefined);
  const { popoverAbove } = useMotionPresets();

  // Before paint, so the panel never shows at the shell's edge for a frame.
  useLayoutEffect(() => {
    const panel = panelRef.current;
    const trigger = anchor?.current;
    const shell = panel?.offsetParent;
    if (!panel || !trigger || !(shell instanceof HTMLElement)) return;
    const wanted =
      trigger.getBoundingClientRect().left - shell.getBoundingClientRect().left - shell.clientLeft;
    setLeft(Math.max(0, Math.min(wanted, shell.clientWidth - panel.offsetWidth)));
  }, [anchor]);

  return (
    <motion.div
      ref={panelRef}
      {...(animated ? popoverAbove : {})}
      className={cn('dropdown-panel absolute bottom-full left-0 mb-2 w-80 max-w-full', className)}
      style={left === undefined ? style : { ...style, left }}
      {...props}
    />
  );
}
