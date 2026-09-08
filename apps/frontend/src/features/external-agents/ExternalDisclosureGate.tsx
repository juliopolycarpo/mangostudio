/**
 * The third-party notice as a send-time gate, and the only place it is answered
 * once a chat is already pointed at a vendor.
 *
 * The selector shows the same notice before activation, so this exists for the
 * cases that come *after*: an acknowledgement withdrawn from settings, or one
 * staled by a vendor that gained a capability the user never agreed to. Both
 * surface as a 403 on send, and without something here the message is accepted,
 * refused and lost to a bare error.
 *
 * Mounted once per surface that can send — the authenticated layout, and
 * first-run setup, which sends its first chat from outside that layout. It
 * renders nothing until a send is refused.
 */

import type { ExternalPermissionLevel } from '@mangostudio/shared/external-agents';
import { normalizePermissionLevel } from '@mangostudio/shared/external-agents';
import { useCallback, useEffect, useState } from 'react';
import { useToast } from '@/components/ui/Toast';
import { ExternalDisclosureDialog } from '@/features/chat/components/ExternalDisclosureDialog';
import { useI18n } from '@/hooks/use-i18n';
import {
  type ExternalDisclosureRequest,
  onExternalDisclosurePrompt,
  settleExternalDisclosure,
} from './disclosure-prompt';
import { useExternalDisclosures } from './useExternalDisclosures';

interface ExternalDisclosureGateProps {
  /**
   * What the chat would let the vendor do, so the notice can say it.
   *
   * A prop rather than a read of the app's current chat: this gate is also
   * mounted where there is no current chat at all. Omitted resolves to the
   * restrictive end, which is what an unmade choice already means everywhere
   * else.
   */
  readonly permissionLevel?: ExternalPermissionLevel | undefined;
}

export function ExternalDisclosureGate({ permissionLevel }: ExternalDisclosureGateProps = {}) {
  const { t } = useI18n();
  const { toast } = useToast();
  const disclosures = useExternalDisclosures();
  const [request, setRequest] = useState<ExternalDisclosureRequest | null>(null);
  const [isSaving, setSaving] = useState(false);

  useEffect(() => onExternalDisclosurePrompt(setRequest), []);

  const decline = useCallback(() => {
    if (isSaving) return;
    settleExternalDisclosure(false);
  }, [isSaving]);

  if (!request) return null;

  const accept = () => {
    setSaving(true);
    // Recorded first, retried second — the same order the selector uses. The
    // other way round re-sends the conversation to a third party on the
    // strength of a write that can still fail, leaving the data already sent
    // with nothing on record saying the notice was shown.
    void disclosures
      .accept(request.targetId, request.environmentId)
      .then(() => settleExternalDisclosure(true))
      .catch(() => toast(t.externalAgents.disclosure.acceptFailed, 'error'))
      .finally(() => setSaving(false));
  };

  return (
    <ExternalDisclosureDialog
      targetId={request.targetId}
      // Normalized, because the stored value is whatever a chat was last saved
      // with and an unrecognized one resolves to the restrictive level rather
      // than to a label this dialog has no string for.
      permissionLevel={normalizePermissionLevel(permissionLevel).value}
      busy={isSaving}
      onAccept={accept}
      onCancel={decline}
    />
  );
}
