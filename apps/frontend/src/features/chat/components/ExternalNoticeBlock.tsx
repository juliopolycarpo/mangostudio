/**
 * A notice the vendor wanted the person to see, rendered where it happened.
 *
 * Display only. The title and description are the vendor's own words, already bounded and
 * stripped of control characters at the runtime boundary, and they render as plain text here:
 * no markdown, no links, nothing a notice can ask the reader or the app to do. The severity is
 * the vendor's hint about prominence; an `error` notice does not mean the turn failed, so it
 * borrows the error tone and none of the turn's failure treatment.
 *
 * Usage: <ExternalNoticeBlock part={part} />
 */

import type { ExternalNoticePart } from '@mangostudio/shared/types';
import { useI18n } from '@/hooks/use-i18n';

export interface ExternalNoticeBlockProps {
  part: ExternalNoticePart;
}

const TONE: Record<ExternalNoticePart['severity'], string> = {
  info: 'border-stroke bg-surface text-fg-muted',
  warning: 'border-warning bg-warning-subtle text-warning',
  error: 'border-danger bg-danger-subtle text-danger',
};

export function ExternalNoticeBlock({ part }: ExternalNoticeBlockProps) {
  const { t } = useI18n();
  const label = t.externalAgents.notice[part.severity];

  return (
    <div
      role="status"
      data-severity={part.severity}
      className={`max-w-2xl rounded-xl border px-3 py-2 text-xs leading-relaxed ${TONE[part.severity]}`}
    >
      <span className="mr-1.5 text-[10px] font-bold uppercase tracking-widest">{label}</span>
      <span className="whitespace-pre-wrap break-words font-medium">{part.title}</span>
      {part.description ? (
        <p className="mt-1 whitespace-pre-wrap break-words opacity-80">{part.description}</p>
      ) : null}
    </div>
  );
}
