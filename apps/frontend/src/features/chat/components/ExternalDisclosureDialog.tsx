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

import type {
  ExternalAgentTargetId,
  ExternalPermissionLevel,
} from '@mangostudio/shared/external-agents';
import { externalAgentVendor } from '@mangostudio/shared/external-agents';
import { ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { Dialog } from '@/components/ui/Dialog';
import { useI18n } from '@/hooks/use-i18n';
import { ICON_SM } from '@/lib/icon-sizes';

export interface ExternalDisclosureDialogProps {
  /**
   * The vendor, rather than its descriptor.
   *
   * Nothing here reads a capability, a version or an account — the notice is
   * about the company, not about what its CLI reported this minute. Taking the
   * id means the send-time gate can raise the same dialog from a 403 that names
   * only the target and the machine, without first finding a descriptor that a
   * revoked acknowledgement may already have changed.
   */
  targetId: ExternalAgentTargetId;
  /** The level this chat is set to, when one is known. Shown, never chosen here. */
  permissionLevel?: ExternalPermissionLevel;
  /** True when this is a review rather than a first activation. */
  reviewOnly?: boolean;
  /** True while the acknowledgement is being stored, which gates the vendor. */
  busy?: boolean;
  onAccept: () => void;
  onCancel: () => void;
}

export function ExternalDisclosureDialog({
  targetId,
  permissionLevel,
  reviewOnly = false,
  busy = false,
  onAccept,
  onCancel,
}: ExternalDisclosureDialogProps) {
  const { t } = useI18n();
  const labels = t.externalAgents.disclosure;
  const vendor = t.externalAgents.target[targetId];
  const links = externalAgentVendor(targetId);

  return (
    <Dialog
      title={labels.title.replace('{vendor}', vendor)}
      onClose={onCancel}
      closeDisabled={busy}
      footer={
        <>
          <Button type="button" variant="secondary" onClick={onCancel} disabled={busy}>
            {reviewOnly ? labels.close : labels.cancel}
          </Button>
          {reviewOnly ? null : (
            <Button type="button" onClick={onAccept} loading={busy}>
              {busy ? labels.accepting : labels.accept}
            </Button>
          )}
        </>
      }
    >
      <ul className="space-y-2 text-sm text-fg-muted">
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
        {targetId === 'claude' ? <li>{labels.inheritedConfigurationClaude}</li> : null}
      </ul>

      <Callout tone="warning">{labels.autoExecution.replace('{vendor}', vendor)}</Callout>

      {/*
        The callout above says the level decides how much runs unattended.
        Naming the level the chat is actually on turns that from a general
        caution into something the user can check before agreeing.
      */}
      {permissionLevel ? (
        <p className="text-xs text-fg-muted">
          {labels.permissionNow.replace(
            '{level}',
            t.externalAgents.permission.levelName[permissionLevel]
          )}
        </p>
      ) : null}

      {/*
        Linked, never summarized. Paraphrasing another company's terms would be
        MangoStudio making a claim about obligations that are not its to state.
      */}
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <a
          href={links.termsUrl}
          target="_blank"
          rel="noreferrer noopener"
          className="inline-flex items-center gap-1 text-accent-fg underline underline-offset-2"
        >
          {labels.terms.replace('{vendor}', vendor)}
          <ExternalLink size={ICON_SM} className="shrink-0" aria-hidden="true" />
        </a>
        <a
          href={links.privacyUrl}
          target="_blank"
          rel="noreferrer noopener"
          className="inline-flex items-center gap-1 text-accent-fg underline underline-offset-2"
        >
          {labels.privacy.replace('{vendor}', vendor)}
          <ExternalLink size={ICON_SM} className="shrink-0" aria-hidden="true" />
        </a>
      </p>
    </Dialog>
  );
}
