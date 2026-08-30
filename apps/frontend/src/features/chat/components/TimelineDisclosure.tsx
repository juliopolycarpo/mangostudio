import { AnimatePresence, motion } from 'motion/react';
import type { ReactNode } from 'react';
import { useMotionPresets } from '@/lib/motion/use-motion-presets';

/**
 * The surface a timeline row opens onto. Exported for the one body that needs
 * the panel without the animation.
 *
 * Carries no `overflow`: the animated panel clips, but a body that scrolls its
 * own detail must not, and two overflow utilities on one element resolve by
 * stylesheet order rather than by the order they are written in.
 */
export const TIMELINE_PANEL_CLASS =
  'mt-1.5 rounded-lg border border-outline-variant/15 bg-surface-container-lowest/60';

interface TimelineDisclosureProps {
  open: boolean;
  children: ReactNode;
  /**
   * Replaces the panel surface. A group expands onto a nested rail rather than
   * onto a card, and a rail is not a panel.
   */
  className?: string;
}

/**
 * The body a timeline row discloses: one height animation, one panel surface.
 *
 * Shared so a tool call, a group and a thought cannot open at three different
 * speeds — they sit on the same rail, and the durations had already drifted
 * apart once.
 *
 * Usage: <TimelineDisclosure open={expanded}><Body /></TimelineDisclosure>
 */
export function TimelineDisclosure({
  open,
  children,
  className = `${TIMELINE_PANEL_CLASS} overflow-hidden`,
}: TimelineDisclosureProps) {
  const { collapse } = useMotionPresets();
  return (
    <AnimatePresence initial={false}>
      {open && (
        <motion.div key="timeline-body" {...collapse} className={className}>
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
