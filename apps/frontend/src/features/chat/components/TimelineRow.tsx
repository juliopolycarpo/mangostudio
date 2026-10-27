import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

import { DisclosureChevron } from './DisclosureChevron';

interface TimelineRowProps {
  expanded: boolean;
  /** Omitted by a row that is not disclosable — there is nothing to toggle. */
  onToggle?: () => void;
  /** Status glyph. Rendered in a fixed-width slot so the label never shifts. */
  glyph?: ReactNode;
  /** Left cluster: the tool name, its argument hint, any badges. */
  children: ReactNode;
  /**
   * Right-aligned qualifier ahead of the outcome: how many more calls a grouped
   * row stands for, e.g. `+2 more`. Quiet mono text like the rest of the cluster,
   * not a pill of its own that takes the argument's room. Shown from `sm` up:
   * the outcome beside it already says how much the group touched, the opened
   * group lists every member, and on a phone the target is what the row is for.
   */
  count?: string | null;
  /** Right-aligned outcome, e.g. `12 items`. */
  summary?: string | null;
  /**
   * Right-aligned elapsed time, e.g. `33ms`. Shown from `sm` up: on a phone the
   * cluster competes with the argument for the row, and the time is the least
   * useful thing in it.
   */
  duration?: string | null;
  /**
   * False for a row with nothing to open — it keeps the chevron's width so the
   * column edges still line up, but drops the affordance and the toggle.
   */
  disclosable?: boolean;
}

/**
 * Shared by both shells so the two branches cannot drift apart on layout. The
 * row is the thing you press, so it takes the clickable radius.
 */
const ROW_CLASS =
  '-ml-1.5 flex min-h-(--timeline-row-height) w-full items-center gap-2 rounded-sm px-1.5 text-left text-xs transition-colors';

/**
 * The single-line disclosure row every timeline step is built from.
 *
 * Layout is reflow-stable by construction: the glyph slot and the disclosure
 * chevron are always present at fixed widths, and the outcome is right-aligned,
 * so a call resolving from running to done repaints in place instead of
 * nudging the label sideways as its status, duration and summary arrive.
 *
 * A row with nothing to open is a `<div>`, not a disabled-looking `<button>`:
 * a vendor turn that ran twenty commands would otherwise put twenty dead tab
 * stops between the reader and the next control that actually does something.
 *
 * Usage: <TimelineRow expanded={open} onToggle={toggle} summary="12 items" duration="33ms">…</TimelineRow>
 */
export function TimelineRow({
  expanded,
  onToggle,
  glyph,
  children,
  count,
  summary,
  duration,
  disclosable = true,
}: TimelineRowProps) {
  // The cluster's parts, in reading order. A part draws its own leading
  // separator, so hiding the count or the duration on a phone takes its `·` with
  // it instead of leaving one dangling. Only the outcome stays on a phone: it is
  // the one part the argument can spare the room for.
  const meta = [
    count ? { key: 'count', text: count, onPhone: false } : null,
    summary ? { key: 'summary', text: summary, onPhone: true } : null,
    duration ? { key: 'duration', text: duration, onPhone: false } : null,
  ].filter((part) => part !== null);
  const hasMeta = meta.length > 0;
  // A row whose meta is only the count or the duration has nothing left of the
  // cluster on a phone, so the cluster goes and the chevron takes over its
  // `ml-auto`.
  const hasPhoneMeta = meta.some((part) => part.onPhone);
  const content = (
    <>
      <span className="flex w-4 shrink-0 items-center justify-center">{glyph}</span>
      {children}
      {hasMeta && (
        <span
          className={cn(
            'ml-auto flex shrink-0 items-center gap-1.5 pl-3 font-mono text-micro tabular-nums text-fg-subtle',
            !hasPhoneMeta && 'max-sm:hidden'
          )}
        >
          {meta.map((part, index) => (
            <span
              key={part.key}
              className={cn('flex items-center gap-1.5', !part.onPhone && 'max-sm:hidden')}
            >
              {index > 0 && (
                <span
                  aria-hidden="true"
                  // Nothing visible precedes it on a phone when the earlier
                  // parts are the ones hidden there.
                  className={cn(
                    !meta.slice(0, index).some((earlier) => earlier.onPhone) && 'max-sm:hidden'
                  )}
                >
                  ·
                </span>
              )}
              <span>{part.text}</span>
            </span>
          ))}
        </span>
      )}
    </>
  );
  const chevronEdge = cn(!hasMeta && 'ml-auto', hasMeta && !hasPhoneMeta && 'max-sm:ml-auto');

  // The chevron's slot is held open either way — that is what keeps a row
  // resolving from running to done from nudging sideways as its status arrives.
  if (!disclosable) {
    return (
      <div className={cn(ROW_CLASS, 'cursor-default')}>
        {content}
        <span aria-hidden="true" className={cn('w-3.5 shrink-0', chevronEdge)} />
      </div>
    );
  }

  return (
    <button
      type="button"
      aria-expanded={expanded}
      onClick={onToggle}
      className={cn(ROW_CLASS, 'cursor-pointer hover:bg-fill-hover')}
    >
      {content}
      <DisclosureChevron expanded={expanded} className={chevronEdge} />
    </button>
  );
}
