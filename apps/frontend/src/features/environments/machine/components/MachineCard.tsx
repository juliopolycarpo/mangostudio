/**
 * The frame the machine page's cards share: a flat `surface` with a hairline,
 * a `MicroLabel` heading with an optional status or control opposite it, an
 * optional headline answering "what state is it in", and the body below.
 * Six cards were each drawing this header by hand.
 *
 * // Usage: <MachineCard title={m.hub.title} headline={m.hub.running} testId="machine-hub-card">…</MachineCard>
 */

import type { ReactNode } from 'react';
import { MicroLabel } from '@/components/ui/MicroLabel';
import { cn } from '@/lib/utils';
import { FindingIcon } from '../../components/FindingList';
import { TOOL_CARD_SURFACE } from '../../components/ToolCard';

interface MachineCardProps {
  readonly title: string;
  /** The card's state in one line (`Running`, `Installed`), in section-title type. */
  readonly headline?: string;
  /** A line under the headline: what supervises it, what it is called. */
  readonly description?: string;
  /** A badge or button opposite the heading. */
  readonly action?: ReactNode;
  readonly testId: string;
  readonly children: ReactNode;
}

export function MachineCard({
  title,
  headline,
  description,
  action,
  testId,
  children,
}: MachineCardProps) {
  return (
    <section className={cn(TOOL_CARD_SURFACE, 'space-y-4 p-4 sm:p-6')} data-testid={testId}>
      <header className="space-y-1">
        <div className="flex items-center justify-between gap-3">
          <MicroLabel as="h3">{title}</MicroLabel>
          {action}
        </div>
        {headline ? <p className="text-base font-semibold text-fg">{headline}</p> : null}
        {description ? <p className="text-sm text-fg-muted">{description}</p> : null}
      </header>
      {children}
    </section>
  );
}

interface MachineFactProps {
  readonly label: string;
  readonly value: string;
  /** A glyph before the fact when what it reports is wrong or worth a second look. */
  readonly severity?: 'warn' | 'fail';
  /** The release host's own text for a failed check — kept for a hover, not shown as the sentence. */
  readonly title?: string;
}

/** One fact about the install: the name in prose, the value in mono underneath. */
export function MachineFact({ label, value, severity, title }: MachineFactProps) {
  return (
    <div className="flex items-start gap-2 text-sm">
      {severity ? <FindingIcon severity={severity} /> : null}
      <div className="min-w-0">
        <p className="text-fg-muted">{label}</p>
        <p className="break-all font-mono text-xs text-fg" title={title}>
          {value}
        </p>
      </div>
    </div>
  );
}
