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
import { useState } from 'react';
import { Card } from '@/components/ui/Card';
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
    <Card padded={false} className="space-y-4 p-5">
      <div className="space-y-1">
        <h2 className="text-base font-semibold text-fg">{labels.manageTitle}</h2>
        <p className="text-xs leading-relaxed text-fg-muted">{labels.revokeHint}</p>
      </div>

      {/*
        Loading is its own state rather than an empty list. "You have not
        acknowledged any external agent yet" is a claim about this account, and
        making it while the answer is still in flight would tell a user their
        consents are gone every time the page opens.
      */}
      {disclosures.isLoading ? null : disclosures.records.length === 0 ? (
        <p className="text-sm text-fg-muted">{labels.manageEmpty}</p>
      ) : (
        <ul className="divide-y divide-stroke">
          {disclosures.records.map((record) => (
            <DisclosureRow
              key={record.targetId}
              targetId={record.targetId}
              acknowledgedAt={record.acknowledgedAt}
              locale={locale}
              busy={revoking === record.targetId}
              onRevoke={withdraw}
            />
          ))}
        </ul>
      )}
    </Card>
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
    <li className="flex items-center gap-3 py-3">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-fg">{name}</p>
        <p className="text-xs text-fg-muted">
          {formatMessage(labels.acknowledgedAt, {
            date: formatAcknowledgedAt(acknowledgedAt, locale),
          })}
        </p>
      </div>
      <button
        type="button"
        disabled={busy || !known}
        onClick={() => {
          if (known) onRevoke(targetId);
        }}
        className="shrink-0 cursor-pointer rounded-xl border border-stroke px-3 py-1.5 text-xs text-fg-muted transition-colors hover:bg-fill-hover disabled:cursor-default disabled:opacity-50"
      >
        {busy ? labels.revoking : labels.revoke}
      </button>
    </li>
  );
}

function formatAcknowledgedAt(value: number, locale: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}
