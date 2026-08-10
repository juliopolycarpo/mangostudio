/**
 * The workspace-trust disclosure, and the only place it is answered.
 *
 * Choosing a folder for a chat says where files live. It does not say that a
 * third-party CLI may read that folder's rules, project configuration and MCP
 * server definitions and act on them — those are instructions authored by
 * whoever wrote the repository. Cursor's ACP session loads them with no flag to
 * turn it off, so the decision is made once per workspace, explicitly, and named
 * for what it actually is.
 *
 * Mounted once in the authenticated layout. It renders nothing until a send is
 * refused, which is the moment the canonical path is known — the server spells
 * it, because only the machine running the vendor can.
 */

import { AlertTriangle } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useToast } from '@/components/ui/Toast';
import { useI18n } from '@/hooks/use-i18n';
import { trustExternalWorkspace } from '@/services/external-agent-service';
import {
  type ExternalWorkspaceTrustRequest,
  onExternalWorkspaceTrustPrompt,
  settleExternalWorkspaceTrust,
} from './workspace-trust-prompt';

export function ExternalWorkspaceTrustGate() {
  const { t } = useI18n();
  const { toast } = useToast();
  const [request, setRequest] = useState<ExternalWorkspaceTrustRequest | null>(null);
  const [isSaving, setSaving] = useState(false);
  const labels = t.externalAgents.workspaceTrust;

  useEffect(() => onExternalWorkspaceTrustPrompt(setRequest), []);

  const decline = useCallback(() => {
    if (isSaving) return;
    settleExternalWorkspaceTrust(false);
  }, [isSaving]);

  if (!request) return null;

  const accept = () => {
    setSaving(true);
    // Recorded first, retried second. The other order runs a vendor against a
    // workspace on the strength of a write that can still fail, leaving nothing
    // on record saying the user was ever asked.
    void trustExternalWorkspace(request.chatId)
      .then(() => settleExternalWorkspaceTrust(true))
      .catch(() => toast(labels.saveFailed, 'error'))
      .finally(() => setSaving(false));
  };

  return (
    <TrustDialog
      workspacePath={request.workspacePath}
      busy={isSaving}
      onAccept={accept}
      onCancel={decline}
    />
  );
}

interface TrustDialogProps {
  readonly workspacePath: string;
  readonly busy: boolean;
  onAccept: () => void;
  onCancel: () => void;
}

function TrustDialog({ workspacePath, busy, onAccept, onCancel }: TrustDialogProps) {
  const { t } = useI18n();
  const labels = t.externalAgents.workspaceTrust;
  const dialogRef = useFocusTrap(onCancel);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        aria-label={labels.title}
        className="w-full max-w-lg space-y-4 rounded-2xl border border-outline-variant/15 bg-surface-container-low p-5 text-sm text-on-surface shadow-2xl outline-none"
      >
        <h2 className="text-base font-semibold">{labels.title}</h2>

        <p className="break-all rounded-xl bg-surface-container-lowest px-3 py-2 font-mono text-xs text-on-surface-variant">
          {workspacePath}
        </p>

        <ul className="space-y-2 text-xs leading-relaxed text-on-surface-variant">
          <li>{labels.rules}</li>
          <li>{labels.mcp}</li>
          <li>{labels.scope}</li>
        </ul>

        <p className="flex items-start gap-2 rounded-xl border border-warning/30 bg-warning/10 px-3 py-2 text-xs leading-relaxed text-warning">
          <AlertTriangle size={14} className="mt-px shrink-0" />
          {labels.warning}
        </p>

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="cursor-pointer rounded-xl border border-outline-variant/20 px-3 py-2 text-sm text-on-surface-variant transition-colors hover:bg-surface-container-high disabled:cursor-default disabled:opacity-50"
          >
            {labels.cancel}
          </button>
          <button
            type="button"
            onClick={onAccept}
            disabled={busy}
            className="cursor-pointer rounded-xl bg-primary px-4 py-2 text-sm font-medium text-on-primary transition-opacity hover:opacity-90 disabled:cursor-default disabled:opacity-50"
          >
            {busy ? labels.saving : labels.accept}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Keyboard behaviour `aria-modal` does not supply.
 *
 * The attribute tells a screen reader the rest of the page is inert; it does
 * not move focus, keep Tab inside, or close on Escape. Without this a keyboard
 * user tabs straight past the dialog into the composer behind it — which is the
 * control this notice exists to gate.
 */
function useFocusTrap(onEscape: () => void) {
  const [dialog, setDialog] = useState<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!dialog) return;
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
  }, [dialog, onEscape]);

  return setDialog;
}
