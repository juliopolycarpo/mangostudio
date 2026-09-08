/**
 * The frame every setup step draws inside: a title, one sentence of why, the
 * step's own controls, and a quieter line for the technical detail.
 *
 * Extracted because six steps sharing a heading rhythm is what makes the flow
 * read as one thing; each step then only owns what is genuinely its own.
 */

import type { ReactNode } from 'react';

interface StepFrameProps {
  readonly title: string;
  readonly lead: string;
  /** The smaller print: the caveat, the escape hatch, the thing an expert wants. */
  readonly hint?: string;
  readonly children?: ReactNode;
}

export function StepFrame({ title, lead, hint, children }: StepFrameProps) {
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <h2 className="font-headline font-bold text-on-surface text-xl">{title}</h2>
        <p className="text-on-surface-variant text-sm leading-relaxed">{lead}</p>
      </div>
      {children}
      {hint ? <p className="text-on-surface-variant/60 text-xs leading-relaxed">{hint}</p> : null}
    </div>
  );
}
