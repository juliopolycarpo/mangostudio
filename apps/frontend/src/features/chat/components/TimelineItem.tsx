import type { ReactNode } from 'react';

/**
 * Node colour. Mirrors the lifecycle of whatever the entry represents rather
 * than the entry's own kind, so a reader scanning only the rail still sees
 * where a turn went wrong.
 */
export type TimelineTone = 'neutral' | 'muted' | 'active' | 'success' | 'error';

type TimelineVariant = 'row' | 'block' | 'divider' | 'bubble';

interface TimelineItemProps {
  children: ReactNode;
  tone?: TimelineTone;
  /**
   * `row` is a single-line step (a tool call, a thought); `block` is prose or a
   * card; `divider` is a full-bleed marker that cuts the rail instead of
   * hanging off it; `bubble` cuts the rail the same way a divider does but
   * keeps block spacing, so what the turn *said* sits off the rail of what it
   * *did*.
   */
  variant?: TimelineVariant;
}

const TONE_CLASS: Record<TimelineTone, string> = {
  neutral: '',
  muted: 'chat-timeline-item--muted',
  active: 'chat-timeline-item--active',
  success: 'chat-timeline-item--success',
  error: 'chat-timeline-item--error',
};

const VARIANT_CLASS: Record<TimelineVariant, string> = {
  row: '',
  block: 'chat-timeline-item--block',
  divider: 'chat-timeline-item--divider',
  bubble: 'chat-timeline-item--bubble',
};

/**
 * One entry on an assistant turn's timeline: the rail segment, its node dot,
 * and the indented content beside them.
 *
 * The rail is CSS-only (see `.chat-timeline-item` in `index.css`) so nothing
 * here has to know how many entries precede or follow it — a virtualized row
 * that mounts alone still draws a correct rail.
 *
 * Usage: <TimelineItem tone="success"><ToolRow /></TimelineItem>
 */
export function TimelineItem({ children, tone = 'neutral', variant = 'row' }: TimelineItemProps) {
  return (
    <div className={`chat-timeline-item ${VARIANT_CLASS[variant]} ${TONE_CLASS[tone]}`.trimEnd()}>
      {children}
    </div>
  );
}
