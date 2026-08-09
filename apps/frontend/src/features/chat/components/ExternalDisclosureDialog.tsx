/**
 * What the user is agreeing to before a vendor first runs a turn here.
 *
 * Not a nag. Handing a conversation to a third-party CLI means another company's
 * software runs on the user's machine, under its own terms, billed to its own
 * account, and — at some permission levels — edits files and runs commands
 * without asking again. Saying that once, plainly, is the point.
 *
 * The acknowledgement records which vendor, which disclosure version and when,
 * plus what the adapter claimed it could do. A later version or a materially
 * different capability set asks again; see `needsExternalDisclosure`.
 */

import type { ExternalAgentDescriptor } from '@mangostudio/shared/external-agents';
import { AlertTriangle, ExternalLink } from 'lucide-react';
import { useI18n } from '@/hooks/use-i18n';

export interface ExternalDisclosureDialogProps {
  descriptor: ExternalAgentDescriptor;
  /** True when this is a review rather than a first activation. */
  reviewOnly?: boolean;
  onAccept: () => void;
  onCancel: () => void;
}

export function ExternalDisclosureDialog({
  descriptor,
  reviewOnly = false,
  onAccept,
  onCancel,
}: ExternalDisclosureDialogProps) {
  const { t } = useI18n();
  const labels = t.externalAgents.disclosure;
  const vendor = t.externalAgents.target[descriptor.targetId];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={labels.title.replace('{vendor}', vendor)}
        className="w-full max-w-lg space-y-4 rounded-2xl border border-outline-variant/15 bg-surface-container-low p-5 text-sm text-on-surface shadow-2xl"
      >
        <h2 className="text-base font-semibold">{labels.title.replace('{vendor}', vendor)}</h2>

        <ul className="space-y-2 text-xs leading-relaxed text-on-surface-variant">
          <li>{labels.thirdParty.replace('{vendor}', vendor)}</li>
          <li>{labels.dataFlow.replace('{vendor}', vendor)}</li>
          <li>{labels.billing.replace('{vendor}', vendor)}</li>
          <li>{labels.ownership.replace('{vendor}', vendor)}</li>
        </ul>

        <p className="flex items-start gap-2 rounded-xl border border-warning/30 bg-warning/10 px-3 py-2 text-xs leading-relaxed text-warning">
          <AlertTriangle size={14} className="mt-px shrink-0" />
          {labels.autoExecution.replace('{vendor}', vendor)}
        </p>

        <p className="flex items-center gap-1.5 text-[11px] text-on-surface-variant/70">
          <ExternalLink size={12} className="shrink-0" />
          {labels.termsHint.replace('{vendor}', vendor)}
        </p>

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="cursor-pointer rounded-xl border border-outline-variant/20 px-3 py-2 text-sm text-on-surface-variant transition-colors hover:bg-surface-container-high"
          >
            {reviewOnly ? labels.close : labels.cancel}
          </button>
          {reviewOnly ? null : (
            <button
              type="button"
              onClick={onAccept}
              className="cursor-pointer rounded-xl bg-primary px-4 py-2 text-sm font-medium text-on-primary transition-opacity hover:opacity-90"
            >
              {labels.accept}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
