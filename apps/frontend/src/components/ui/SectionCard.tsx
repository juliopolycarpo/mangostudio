import type { ReactNode } from 'react';
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
 */
export function SectionCard({ label, tone, action, className, children }: SectionCardProps) {
  return (
    <section
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
    </section>
  );
}
