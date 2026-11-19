/**
 * The third-party notices this user has acknowledged, and the way to take one
 * back.
 *
 * A consent nobody can withdraw is not a consent. The dialog that records these
 * appears once, at the moment the user is trying to do something else, and until
 * now the only record of it lived server-side with no surface to read it from —
 * so "which companies have I agreed to send my conversations to" had no answer
 * inside MangoStudio at all.
 *
 * Withdrawing is deliberately not a confirm-dialog: it is the safe direction.
 * The cost of an accidental withdrawal is being asked again; the cost of an
 * accidental confirmation is a conversation already sent.
 */

import type {
  ExternalAgentTargetId,
  ExternalWorkspaceTrust,
} from '@mangostudio/shared/external-agents';
import { isExternalAgentTargetId } from '@mangostudio/shared/external-agents/values';
import { FolderLock, ShieldCheck } from 'lucide-react';
import { useState } from 'react';

import { SettingsPage } from '@/components/settings/SettingsPage';
import { SettingsRow } from '@/components/settings/SettingsRow';
import { SettingsSection } from '@/components/settings/SettingsSection';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Skeleton } from '@/components/ui/Skeleton';
import { useToast } from '@/components/ui/Toast';
import { useEnvironmentEntitiesQuery } from '@/features/environments/queries';
import { useExternalDisclosures } from '@/features/external-agents/useExternalDisclosures';
import { useExternalWorkspaceTrust } from '@/features/external-agents/useExternalWorkspaceTrust';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';
import { ICON_LG } from '@/lib/icon-sizes';

export function ExternalAgentSettingsPage() {
  const { t, locale } = useI18n('settings');
  const { toast } = useToast();
  const disclosures = useExternalDisclosures();
  const labels = t.externalAgents.disclosure;
  const [revoking, setRevoking] = useState<ExternalAgentTargetId | null>(null);

  const withdraw = (targetId: ExternalAgentTargetId) => {
    setRevoking(targetId);
    void disclosures
      .revoke(targetId)
      .catch(() => toast(labels.revokeFailed, 'error'))
      .finally(() => setRevoking(null));
  };

  return (
    // Withdrawing is only explained once there is something to withdraw. The
    // sentence is the page's description: one list needs no heading of its own.
    <SettingsPage
      title={t.settings.tabs.externalAgents}
      description={disclosures.records.length > 0 ? labels.revokeHint : labels.manageDescription}
    >
      <SettingsSection>
        {/*
          Loading is its own state rather than an empty list. "You have not
          acknowledged any external agent yet" is a claim about this account, and
          making it while the answer is still in flight would tell a user their
          consents are gone every time the page opens.
        */}
        {disclosures.isLoading ? (
          <div
            // eslint-disable-next-line jsx-a11y/prefer-tag-over-role -- The status live region announces changes without implying a calculation output.
            role="status"
            className="px-4 py-3"
          >
            <Skeleton className="h-8 w-full" />
            <span className="sr-only">{t.common.loading}</span>
          </div>
        ) : disclosures.records.length === 0 ? (
          <EmptyState
            icon={<ShieldCheck size={ICON_LG} />}
            title={labels.manageEmpty}
            hint={labels.manageEmptyHint}
          />
        ) : (
          disclosures.records.map((record) => (
            <DisclosureRow
              key={record.targetId}
              targetId={record.targetId}
              acknowledgedAt={record.acknowledgedAt}
              locale={locale}
              busy={revoking === record.targetId}
              onRevoke={withdraw}
            />
          ))
        )}
      </SettingsSection>
      <WorkspaceTrustSection locale={locale} />
    </SettingsPage>
  );
}

/**
 * The folders a vendor may load configuration from, each withdrawable.
 *
 * Same stance as the notices above: withdrawing is the safe direction, so there
 * is no confirm step. The hint says what a click does beyond the row — every chat
 * on that folder is affected, and a turn already running is not stopped.
 */
function WorkspaceTrustSection({ locale }: { readonly locale: string }) {
  const { t } = useI18n('settings');
  const { toast } = useToast();
  const trust = useExternalWorkspaceTrust();
  const environments = useEnvironmentEntitiesQuery();
  const labels = t.externalAgents.workspaceTrust;
  const [revokingKey, setRevokingKey] = useState<string | null>(null);

  const withdraw = (grant: ExternalWorkspaceTrust) => {
    setRevokingKey(grantKey(grant));
    void trust
      .revoke(grant)
      .catch(() => toast(labels.revokeFailed, 'error'))
      .finally(() => setRevokingKey(null));
  };

  return (
    <SettingsSection
      title={labels.manageTitle}
      description={trust.grants.length > 0 ? labels.manageHint : labels.manageDescription}
    >
      {trust.isLoading ? (
        <div
          // eslint-disable-next-line jsx-a11y/prefer-tag-over-role -- The status live region announces changes without implying a calculation output.
          role="status"
          className="px-4 py-3"
        >
          <Skeleton className="h-8 w-full" />
          <span className="sr-only">{t.common.loading}</span>
        </div>
      ) : trust.grants.length === 0 ? (
        <EmptyState
          icon={<FolderLock size={ICON_LG} />}
          title={labels.manageEmpty}
          hint={labels.manageEmptyHint}
        />
      ) : (
        trust.grants.map((grant) => {
          const environmentName =
            environments.data?.find((candidate) => candidate.id === grant.environmentId)?.name ??
            grant.environmentId;
          const busy = revokingKey === grantKey(grant);
          return (
            <SettingsRow
              key={grantKey(grant)}
              label={<span className="break-all font-mono text-xs">{grant.workspacePath}</span>}
              hint={formatMessage(labels.grantedAt, {
                vendor: t.externalAgents.target[grant.targetId],
                environment: environmentName,
                date: formatAcknowledgedAt(grant.acceptedAt, locale),
              })}
            >
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={busy}
                onClick={() => {
                  withdraw(grant);
                }}
              >
                {busy ? labels.revoking : labels.revoke}
              </Button>
            </SettingsRow>
          );
        })
      )}
    </SettingsSection>
  );
}

/** The three-part key a grant is stored under, for React keys and the busy marker. */
function grantKey(grant: ExternalWorkspaceTrust): string {
  return JSON.stringify([grant.targetId, grant.environmentId, grant.workspacePath]);
}

interface DisclosureRowProps {
  /** As the server stored it, which is why it is a plain string here. */
  readonly targetId: string;
  readonly acknowledgedAt: number;
  readonly locale: string;
  readonly busy: boolean;
  onRevoke: (targetId: ExternalAgentTargetId) => void;
}

function DisclosureRow({ targetId, acknowledgedAt, locale, busy, onRevoke }: DisclosureRowProps) {
  const { t } = useI18n('settings');
  const labels = t.externalAgents.disclosure;
  // A row the client has no vendor name for is still a consent on record, so it
  // is shown under its stored id rather than hidden. A target this build does
  // not know about is exactly the one a user would most want to withdraw.
  const known = isExternalAgentTargetId(targetId);
  const name = known ? t.externalAgents.target[targetId] : targetId;

  return (
    <SettingsRow
      label={name}
      hint={formatMessage(labels.acknowledgedAt, {
        date: formatAcknowledgedAt(acknowledgedAt, locale),
      })}
    >
      <Button
        type="button"
        variant="secondary"
        size="sm"
        disabled={busy || !known}
        onClick={() => {
          if (known) onRevoke(targetId);
        }}
      >
        {busy ? labels.revoking : labels.revoke}
      </Button>
    </SettingsRow>
  );
}

function formatAcknowledgedAt(value: number, locale: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}
