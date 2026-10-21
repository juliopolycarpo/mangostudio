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
import { Callout } from '@/components/ui/Callout';
import { useI18n } from '@/hooks/use-i18n';

export interface ExternalNoticeBlockProps {
  part: ExternalNoticePart;
}

/** The vendor's severity picks the callout's tone; an `error` notice is still only a notice. */
const TONE = {
  info: 'info',
  warning: 'warning',
  error: 'danger',
} as const satisfies Record<ExternalNoticePart['severity'], 'info' | 'warning' | 'danger'>;

export function ExternalNoticeBlock({ part }: ExternalNoticeBlockProps) {
  const { t } = useI18n();
  const label = t.externalAgents.notice[part.severity];

  return (
    <Callout
      role="status"
      data-severity={part.severity}
      tone={TONE[part.severity]}
      className="max-w-(--timeline-card-max)"
      title={
        <>
          {/* The glyph and fill carry the severity visually; the word is for
              the reader who gets neither. */}
          <span className="sr-only">{label}: </span>
          <span className="whitespace-pre-wrap break-words">{part.title}</span>
        </>
      }
    >
      {part.description ? (
        <p className="whitespace-pre-wrap break-words">{part.description}</p>
      ) : null}
    </Callout>
  );
}
