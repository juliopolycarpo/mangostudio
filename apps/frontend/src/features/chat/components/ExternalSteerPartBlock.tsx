/**
 * What the user sent into a running Codex turn, rendered inline where it
 * happened.
 *
 * Unlike every other block in this folder, the text here is the user's own —
 * not vendor prose — but it renders as plain text anyway: this sits inside a
 * vendor-authored message, and giving one part of that message markdown while
 * its siblings stay plain text would be a harder rule to keep correct than a
 * consistent one.
 *
 * `status` arrives resolved. The composer that sent this already knows
 * whether it was accepted before the part appears here at all, so there is no
 * pending state to render — only what happened.
 */

import type { ExternalSteerPart } from '@mangostudio/shared/types';
import { CornerDownRight } from 'lucide-react';
import { Callout } from '@/components/ui/Callout';
import { MicroLabel } from '@/components/ui/MicroLabel';
import { useI18n } from '@/hooks/use-i18n';
import { ICON_SM } from '@/lib/icon-sizes';

export interface ExternalSteerPartBlockProps {
  part: ExternalSteerPart;
}

export function ExternalSteerPartBlock({ part }: ExternalSteerPartBlockProps) {
  const { t } = useI18n();
  const labels = t.externalAgents.steer;
  const rejected = part.status === 'rejected';

  return (
    <div className="max-w-2xl space-y-2">
      {/* The user's own words, so it wears the user's message: a `surface`
          balloon with a hairline. Whether it landed is the callout's job. */}
      <div className="rounded-lg border border-stroke bg-surface px-3 py-2 text-sm text-fg">
        <MicroLabel as="div" className="mb-1 flex items-center gap-1.5">
          <CornerDownRight size={ICON_SM} className="shrink-0" />
          <span>{labels.sentLabel}</span>
        </MicroLabel>
        <p className="whitespace-pre-wrap break-words">{part.text}</p>
      </div>
      {rejected ? (
        <Callout
          tone="danger"
          title={`${labels.rejectedLabel}${part.reasonCode ? ` — ${labels.reason[part.reasonCode]}` : ''}`}
        />
      ) : null}
    </div>
  );
}
