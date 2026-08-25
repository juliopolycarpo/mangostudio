import { ChevronDown } from 'lucide-react';
import type { ReactNode } from 'react';

interface TimelineRowProps {
  expanded: boolean;
  onToggle: () => void;
  /** Status glyph. Rendered in a fixed-width slot so the label never shifts. */
  glyph?: ReactNode;
  /** Left cluster: the tool name, its argument hint, any badges. */
  children: ReactNode;
  /** Right-aligned outcome, e.g. `12 items`. */
  summary?: string | null;
  /** Right-aligned elapsed time, e.g. `33ms`. */
  duration?: string | null;
  /**
   * False for a row with nothing to open — it keeps the chevron's width so the
   * column edges still line up, but drops the affordance and the toggle.
   */
  disclosable?: boolean;
}

/**
 * The single-line disclosure row every timeline step is built from.
 *
 * Layout is reflow-stable by construction: the glyph slot and the disclosure
 * chevron are always present at fixed widths, and the outcome is right-aligned,
 * so a call resolving from running to done repaints in place instead of
 * nudging the label sideways as its status, duration and summary arrive.
 *
 * Usage: <TimelineRow expanded={open} onToggle={toggle} summary="12 items" duration="33ms">…</TimelineRow>
 */
export function TimelineRow({
  expanded,
  onToggle,
  glyph,
  children,
  summary,
  duration,
  disclosable = true,
}: TimelineRowProps) {
  const hasMeta = Boolean(summary) || Boolean(duration);

  return (
    <button
      type="button"
      aria-expanded={disclosable ? expanded : undefined}
      onClick={onToggle}
      className={`group/row -ml-1.5 flex w-full min-h-(--timeline-row-height) items-center gap-2
                  rounded-md px-1.5 text-left text-xs transition-colors
                  duration-(--duration-quick)
                  ${disclosable ? 'cursor-pointer hover:bg-surface-container-low' : 'cursor-default'}`}
    >
      <span className="flex w-3 shrink-0 items-center justify-center">{glyph}</span>
      {children}
      {hasMeta && (
        <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-3 font-mono text-[11px] tabular-nums text-on-surface-variant/50">
          {summary && <span>{summary}</span>}
          {summary && duration && <span aria-hidden="true">·</span>}
          {duration && <span>{duration}</span>}
        </span>
      )}
      {disclosable ? (
        <ChevronDown
          size={11}
          aria-hidden="true"
          className={`shrink-0 text-on-surface-variant/40 transition-all duration-(--duration-base)
                      ${hasMeta ? '' : 'ml-auto'}
                      ${expanded ? 'rotate-180 opacity-100' : 'opacity-0 group-hover/row:opacity-100'}`}
        />
      ) : (
        <span aria-hidden="true" className={`w-[11px] shrink-0 ${hasMeta ? '' : 'ml-auto'}`} />
      )}
    </button>
  );
}
