/**
 * The two shapes the sections of an environment card are made of.
 *
 * A card is a flat `surface`, so what sits inside it is divided by a hairline
 * rather than boxed: a second bordered, filled box would be a card inside a
 * card, and its fields would sit on a fill the same colour as their own.
 * `EntityPanel` is one section — a rule, an optional glyph, a title and a line
 * saying what it is for. `CommandGroup` is a run of copyable commands under a
 * short heading, the form every "do this on that machine" step takes.
 */

import type { ReactNode } from 'react';

interface EntityPanelProps {
  readonly title: string;
  readonly description?: string;
  /** A 16px glyph for what the section configures; muted, never the accent. */
  readonly icon?: ReactNode;
  /** Status beside the title — a badge, never bare colour. */
  readonly meta?: ReactNode;
  readonly testId?: string;
  readonly children: ReactNode;
}

export function EntityPanel({
  title,
  description,
  icon,
  meta,
  testId,
  children,
}: EntityPanelProps) {
  return (
    <section className="space-y-3 border-t border-stroke pt-3" data-testid={testId}>
      <header className="flex items-start gap-2">
        {icon ? <span className="mt-0.5 shrink-0 text-fg-muted">{icon}</span> : null}
        <div className="min-w-0 space-y-0.5">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="text-sm font-medium text-fg">{title}</h4>
            {meta}
          </div>
          {description ? <p className="text-xs text-fg-muted">{description}</p> : null}
        </div>
      </header>
      {children}
    </section>
  );
}

interface CommandGroupProps {
  readonly title: string;
  readonly hint?: string;
  readonly children: ReactNode;
}

export function CommandGroup({ title, hint, children }: CommandGroupProps) {
  return (
    <div className="space-y-2 border-t border-stroke pt-3">
      <p className="text-sm font-medium text-fg">{title}</p>
      {hint ? <p className="text-xs text-fg-muted">{hint}</p> : null}
      {children}
    </div>
  );
}
