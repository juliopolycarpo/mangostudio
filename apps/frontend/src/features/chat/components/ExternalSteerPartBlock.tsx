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
import { useI18n } from '@/hooks/use-i18n';

export interface ExternalSteerPartBlockProps {
  part: ExternalSteerPart;
}

export function ExternalSteerPartBlock({ part }: ExternalSteerPartBlockProps) {
  const { t } = useI18n();
  const labels = t.externalAgents.steer;
  const rejected = part.status === 'rejected';

  return (
    <div
      className={`max-w-2xl rounded-xl border px-3 py-2 text-sm ${
        rejected
          ? 'border-error/30 bg-error/5 text-on-surface-variant'
          : 'border-primary/25 bg-primary/5 text-on-surface'
      }`}
    >
      <div className="mb-1 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">
        <CornerDownRight size={12} className="shrink-0" />
        <span>{labels.sentLabel}</span>
      </div>
      <p className="whitespace-pre-wrap break-words">{part.text}</p>
      {rejected ? (
        <p className="mt-1.5 text-xs text-error">
          {labels.rejectedLabel}
          {part.reasonCode ? ` — ${labels.reason[part.reasonCode]}` : ''}
        </p>
      ) : null}
    </div>
  );
}
