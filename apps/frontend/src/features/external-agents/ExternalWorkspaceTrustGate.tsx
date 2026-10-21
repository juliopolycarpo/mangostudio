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

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { Dialog } from '@/components/ui/Dialog';
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
    void trustExternalWorkspace(request.chatId, {
      // The scope this dialog displayed, sent back so the server can refuse a
      // grant for a chat that changed while it was open.
      workspacePath: request.workspacePath,
      targetId: request.targetId,
      environmentId: request.environmentId,
    })
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

  return (
    <Dialog
      title={labels.title}
      onClose={onCancel}
      closeDisabled={busy}
      footer={
        <>
          <Button variant="secondary" onClick={onCancel} disabled={busy}>
            {labels.cancel}
          </Button>
          <Button variant="primary" onClick={onAccept} loading={busy}>
            {busy ? labels.saving : labels.accept}
          </Button>
        </>
      }
    >
      <p className="break-all rounded-md border border-stroke bg-canvas px-3 py-2 font-mono text-xs text-fg">
        {workspacePath}
      </p>

      <ul className="space-y-2 text-sm text-fg-muted">
        <li>{labels.rules}</li>
        <li>{labels.mcp}</li>
        <li>{labels.scope}</li>
      </ul>

      <Callout tone="warning">{labels.warning}</Callout>
    </Dialog>
  );
}
