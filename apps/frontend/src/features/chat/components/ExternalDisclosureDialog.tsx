/**
 * What the user is agreeing to before a vendor first runs a turn here.
 *
 * Not a nag. Handing a conversation to a third-party CLI means another company's
 * software runs on the user's machine, under its own terms, billed to its own
 * account, and — at some permission levels — edits files and runs commands
 * without asking again. Saying that once, plainly, is the point.
 *
 * The acknowledgement is recorded server-side, per vendor, and is a
 * precondition the turn-start path enforces rather than a preference this dialog
 * remembers. A later text version, a vendor that gained a capability, or an
 * account whose effective permission default changed all ask again — see
 * `external-disclosure-gate.ts` for what makes an acknowledgement stale.
 */

import type { ExternalAgentDescriptor } from '@mangostudio/shared/external-agents';
import { externalAgentVendor } from '@mangostudio/shared/external-agents';
import { AlertTriangle, ExternalLink } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { useI18n } from '@/hooks/use-i18n';

export interface ExternalDisclosureDialogProps {
  descriptor: ExternalAgentDescriptor;
  /** True when this is a review rather than a first activation. */
  reviewOnly?: boolean;
  /** True while the acknowledgement is being stored, which gates the vendor. */
  busy?: boolean;
  onAccept: () => void;
  onCancel: () => void;
}

export function ExternalDisclosureDialog({
  descriptor,
  reviewOnly = false,
  busy = false,
  onAccept,
  onCancel,
}: ExternalDisclosureDialogProps) {
  const { t } = useI18n();
  const labels = t.externalAgents.disclosure;
  const vendor = t.externalAgents.target[descriptor.targetId];
  const links = externalAgentVendor(descriptor.targetId);
  const dialogRef = useFocusTrap(onCancel);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        aria-label={labels.title.replace('{vendor}', vendor)}
        className="w-full max-w-lg space-y-4 rounded-2xl border border-outline-variant/15 bg-surface-container-low p-5 text-sm text-on-surface shadow-2xl outline-none"
      >
        <h2 className="text-base font-semibold">{labels.title.replace('{vendor}', vendor)}</h2>

        <ul className="space-y-2 text-xs leading-relaxed text-on-surface-variant">
          <li>{labels.thirdParty.replace('{vendor}', vendor)}</li>
          <li>{labels.dataFlow.replace('{vendor}', vendor)}</li>
          <li>{labels.billing.replace('{vendor}', vendor)}</li>
          <li>{labels.ownership.replace('{vendor}', vendor)}</li>
          {/*
            Claude only. It runs the machine's own hooks, skills, plugins and MCP
            servers inside the turn — the one exposure a user cannot see from
            anywhere in MangoStudio. Codex and Cursor read project files too, but
            what each of them loads has not been characterized, and naming the
            wrong sources for a vendor is worse than staying quiet.
          */}
          {descriptor.targetId === 'claude' ? <li>{labels.inheritedConfigurationClaude}</li> : null}
        </ul>

        <p className="flex items-start gap-2 rounded-xl border border-warning/30 bg-warning/10 px-3 py-2 text-xs leading-relaxed text-warning">
          <AlertTriangle size={14} className="mt-px shrink-0" />
          {labels.autoExecution.replace('{vendor}', vendor)}
        </p>

        {/*
          Linked, never summarized. Paraphrasing another company's terms would be
          MangoStudio making a claim about obligations that are not its to state.
        */}
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-on-surface-variant/70">
          <ExternalLink size={12} className="shrink-0" />
          <a
            href={links.termsUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="underline underline-offset-2 hover:text-on-surface"
          >
            {labels.terms.replace('{vendor}', vendor)}
          </a>
          <a
            href={links.privacyUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="underline underline-offset-2 hover:text-on-surface"
          >
            {labels.privacy.replace('{vendor}', vendor)}
          </a>
        </p>

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="cursor-pointer rounded-xl border border-outline-variant/20 px-3 py-2 text-sm text-on-surface-variant transition-colors hover:bg-surface-container-high disabled:cursor-default disabled:opacity-50"
          >
            {reviewOnly ? labels.close : labels.cancel}
          </button>
          {reviewOnly ? null : (
            <button
              type="button"
              onClick={onAccept}
              disabled={busy}
              className="cursor-pointer rounded-xl bg-primary px-4 py-2 text-sm font-medium text-on-primary transition-opacity hover:opacity-90 disabled:cursor-default disabled:opacity-50"
            >
              {busy ? labels.accepting : labels.accept}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Keyboard behaviour `aria-modal` does not supply.
 *
 * The attribute tells a screen reader the rest of the page is inert; it does not
 * move focus, keep Tab inside, or close on Escape. Without this a keyboard user
 * lands on whatever was focused before, tabs straight past the dialog into the
 * page behind it, and can reach the very selector this notice is gating. There
 * is no shared modal primitive to reuse, so it lives here until there is.
 */
function useFocusTrap(onEscape: () => void) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    // Restored on close, so dismissing the dialog puts the user back where they
    // were rather than at the top of the document.
    const previouslyFocused = document.activeElement as HTMLElement | null;
    dialog.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onEscape();
        return;
      }
      if (event.key !== 'Tab') return;

      const focusable = [...dialog.querySelectorAll<HTMLElement>('button:not([disabled])')];
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;

      const active = document.activeElement;
      if (event.shiftKey && (active === first || active === dialog)) {
        event.preventDefault();
        last.focus();
        return;
      }
      if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      previouslyFocused?.focus?.();
    };
  }, [onEscape]);

  return ref;
}
