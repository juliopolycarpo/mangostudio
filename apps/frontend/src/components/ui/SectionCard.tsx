import { motion } from 'motion/react';
import type { ReactNode } from 'react';
import { useMotionPresets } from '@/lib/motion/use-motion-presets';
import { cn } from '@/lib/utils';
import { MicroLabel } from './MicroLabel';
import { StatusDot, type StatusDotTone } from './StatusDot';

interface SectionCardProps {
  /** Mono uppercase heading — `WORKSPACE`, `AGENTS`, `SKILLS — 1 DIVERGENCE`. */
  label: string;
  /** Presence dot beside the label. Omit for a card that reports no state. */
  tone?: StatusDotTone;
  /** A control that belongs to the header rather than the body (refresh, link). */
  action?: ReactNode;
  className?: string;
  children: ReactNode;
}

/**
 * Panel with a mono micro-label header, used by the workspace hub and anything
 * else that groups a few facts under one heading.
 *
 * The label is a real heading so the hub reads as a list of sections rather
 * than a wall of divs; nesting level is left to the call site's document
 * outline by keeping it an `h3` under the hub's own `h1`/`h2`.
 *
 * It carries the card variants but never drives them: with no `initial` or
 * `animate` of its own it stays a passive participant, so a card outside a
 * staggered grid — a settings pane, the studio page — mounts plain, exactly as
 * it does today. Inside one, the grid drives it through context.
 */
export function SectionCard({ label, tone, action, className, children }: SectionCardProps) {
  const { cardItem } = useMotionPresets();
  return (
    <motion.section
      variants={cardItem}
      className={cn(
        'flex min-w-0 flex-col gap-3 rounded-xl border border-outline-variant/15 bg-surface-container-low/60 p-4',
        className
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <MicroLabel as="h3" className="flex min-w-0 items-center gap-1.5">
          {tone ? <StatusDot tone={tone} /> : null}
          <span className="truncate">{label}</span>
        </MicroLabel>
        {action}
      </div>
      {children}
    </motion.section>
  );
}
