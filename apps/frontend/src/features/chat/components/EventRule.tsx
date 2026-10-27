import { CircleX } from 'lucide-react';
import type { ReactNode } from 'react';

import { ICON_SM } from '@/lib/icon-sizes';

interface EventRuleProps {
  /** `danger` adds an error glyph; the words stay in the ordinary text colour. */
  tone?: 'neutral' | 'danger';
  children: ReactNode;
}

/**
 * A full-bleed marker that cuts the transcript: a hairline either side of a
 * short sentence about what happened to the conversation itself (a handoff, a
 * compaction, a provider change) rather than to one step of a turn.
 *
 * Tone is carried by a glyph, not by colouring the words or the rule.
 *
 * // Usage: <EventRule>Chat compacted</EventRule>
 */
export function EventRule({ tone = 'neutral', children }: EventRuleProps) {
  return (
    <div className="my-1 flex items-center gap-2 py-2 text-xs text-fg-muted">
      <div className="h-px min-w-4 flex-1 bg-stroke" />
      <span className="flex min-w-0 items-center gap-1.5 text-center font-medium">
        {tone === 'danger' ? <CircleX size={ICON_SM} className="shrink-0 text-danger" /> : null}
        {children}
      </span>
      <div className="h-px min-w-4 flex-1 bg-stroke" />
    </div>
  );
}
