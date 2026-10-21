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

import {
  type ExternalAgentTargetId,
  isExternalAgentTargetId,
} from '@mangostudio/shared/external-agents';
import { ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { SettingsPage } from '@/components/settings/SettingsPage';
import { SettingsRow } from '@/components/settings/SettingsRow';
import { SettingsSection } from '@/components/settings/SettingsSection';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Skeleton } from '@/components/ui/Skeleton';
import { useToast } from '@/components/ui/Toast';
import { useExternalDisclosures } from '@/features/external-agents/useExternalDisclosures';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';

export function ExternalAgentSettingsPage() {
  const { t, locale } = useI18n();
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
    <SettingsPage title={t.settings.tabs.externalAgents}>
      <SettingsSection title={labels.manageTitle} description={labels.revokeHint}>
        {/*
          Loading is its own state rather than an empty list. "You have not
          acknowledged any external agent yet" is a claim about this account, and
          making it while the answer is still in flight would tell a user their
          consents are gone every time the page opens.
        */}
        {disclosures.isLoading ? (
          <div role="status" className="px-4 py-3">
            <Skeleton className="h-8 w-full" />
            <span className="sr-only">{t.common.loading}</span>
          </div>
        ) : disclosures.records.length === 0 ? (
          <EmptyState icon={<ShieldCheck size={24} />} title={labels.manageEmpty} />
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
    </SettingsPage>
  );
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
  const { t } = useI18n();
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
