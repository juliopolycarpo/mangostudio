/**
 * The frame every setup step draws inside: a title, one sentence of why, the
 * step's own controls, and a quieter line for the technical detail.
 *
 * Extracted because six steps sharing a heading rhythm is what makes the flow
 * read as one thing; each step then only owns what is genuinely its own. The
 * title is the screen's one `text-headline`: the wizard's own heading above it
 * is a page title, and this is the greeting for the step in front of the person.
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
        <h2 className="text-headline font-semibold text-fg">{title}</h2>
        <p className="text-sm text-fg-muted">{lead}</p>
      </div>
      {children}
      {hint ? <p className="text-xs text-fg-muted">{hint}</p> : null}
    </div>
  );
}
