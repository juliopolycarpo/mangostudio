/**
 * A vendor's mid-turn question, answered on a side channel.
 *
 * Modelled on `ElicitationCard`, which already solves the shape: a card that
 * stays interactive while the turn streams, posts to its own endpoint, and
 * reflects a status that can also arrive over the stream.
 *
 * What it must not do is edit the question. The options are the vendor's, in
 * the vendor's order, with the vendor's labels — MangoStudio never adds,
 * removes, reorders or renames a choice, because the button the user pressed has
 * to be the authorization the vendor receives. A vendor labelling something
 * "Approve for this session" is telling the user how long it lasts, and a
 * MangoStudio-supplied "Allow" would quietly widen that.
 *
 * An approval that outlived its turn renders **expired**: a dead card is honest,
 * a live control that will never resolve is not.
 */

import type { ExternalApprovalOption } from '@mangostudio/shared/external-agents';
import type { ExternalApprovalPart } from '@mangostudio/shared/types';
import { AlertTriangle, ShieldQuestion } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useI18n } from '@/hooks/use-i18n';
import { answerExternalApproval } from '@/services/external-agent-service';

export interface ExternalApprovalCardProps {
  part: ExternalApprovalPart;
  /** Absent when the message is not the live turn's, which makes the card inert. */
  chatId?: string | null;
}

/**
 * Usage: <ExternalApprovalCard part={part} chatId={chatId} />
 */
export function ExternalApprovalCard({ part, chatId = null }: ExternalApprovalCardProps) {
  const { t } = useI18n();
  const labels = t.externalAgents.approval;
  const [optimisticDecision, setOptimisticDecision] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const expired = useApprovalExpiry(part);

  // The persisted part is authoritative: a decision that reached the server wins
  // over anything this card believes about its own click.
  const decisionSource = part.decisionSource;
  const decision = part.decision ?? optimisticDecision;
  const pending = decisionSource === undefined && optimisticDecision === null;
  const interactive = pending && !expired && chatId !== null;

  const answer = async (optionId: string) => {
    if (!interactive || submitting || !chatId) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await answerExternalApproval(chatId, {
        requestId: part.requestId,
        optionId,
      });
      // A rejection is a value, not a throw: the vendor never received this
      // authorization. Recording it optimistically would show the option as
      // chosen, disable every button, and leave the user with no way to retry.
      if (result.status === 'rejected') {
        setError(labels.submitError);
        return;
      }
      setOptimisticDecision(result.optionId ?? optionId);
    } catch {
      setError(labels.submitError);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="max-w-2xl w-full space-y-3 rounded-2xl border border-outline-variant/15 bg-surface-container-low p-4 text-sm text-on-surface sm:p-5">
      <div className="flex flex-wrap items-center gap-2 text-on-surface-variant">
        <ShieldQuestion size={16} className="text-primary" />
        <span className="text-xs font-bold uppercase tracking-widest">
          {headingFor(decisionSource ?? (expired ? 'expired' : undefined), labels)}
        </span>
      </div>

      {/* Vendor text, rendered inert. */}
      <p className="whitespace-pre-wrap font-medium text-on-surface">{part.title}</p>
      {part.detail ? (
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-surface-container-high px-3 py-2 text-[11px] text-on-surface-variant">
          {part.detail}
        </pre>
      ) : null}
      {part.truncated ? (
        <p className="text-xs text-on-surface-variant/70">{labels.truncatedHint}</p>
      ) : null}

      {error ? <p className="text-xs text-error">{error}</p> : null}

      <div className="flex flex-wrap gap-2">
        {part.options.map((option) => (
          <OptionButton
            key={option.id}
            option={option}
            label={optionLabel(option, labels)}
            chosen={decision === option.id}
            interactive={interactive && !submitting}
            onClick={() => void answer(option.id)}
          />
        ))}
      </div>

      {decisionSource === 'expired' || decisionSource === 'cancelled' || expired ? (
        <p className="text-xs text-on-surface-variant/70">
          {decisionSource === 'cancelled' ? labels.cancelledHint : labels.expiredHint}
        </p>
      ) : null}
      {decisionSource === 'auto-review' ? (
        <p className="text-xs text-warning">{labels.autoReviewedHint}</p>
      ) : null}
    </div>
  );
}

/**
 * Whether this approval has outlived its own deadline.
 *
 * The server seals an abandoned approval when the turn ends, which is the
 * durable answer. But a turn can outlive an approval's expiry — the vendor stops
 * waiting and carries on — and until the turn ends nothing tells the card, so
 * its buttons would stay live long after pressing one could do anything. The
 * timer is local and advisory; `decisionSource` still wins when it arrives.
 */
function useApprovalExpiry(part: ExternalApprovalPart): boolean {
  const [expired, setExpired] = useState(() => Date.now() >= part.expiresAtMs);

  useEffect(() => {
    if (part.decisionSource !== undefined) return;
    const remaining = part.expiresAtMs - Date.now();
    if (remaining <= 0) {
      setExpired(true);
      return;
    }
    setExpired(false);
    const timer = setTimeout(() => setExpired(true), remaining);
    return () => clearTimeout(timer);
  }, [part.expiresAtMs, part.decisionSource]);

  return expired && part.decisionSource === undefined;
}

function OptionButton({
  option,
  label,
  chosen,
  interactive,
  onClick,
}: {
  option: ExternalApprovalOption;
  label: string;
  chosen: boolean;
  interactive: boolean;
  onClick: () => void;
}) {
  const tone = chosen
    ? 'border-primary/50 bg-primary/10 text-on-surface'
    : option.isDestructive
      ? 'border-error/40 text-error'
      : 'border-outline-variant/20 text-on-surface-variant';

  return (
    <button
      type="button"
      disabled={!interactive}
      onClick={onClick}
      data-destructive={option.isDestructive ? 'true' : undefined}
      className={`flex items-center gap-1.5 rounded-xl border px-3 py-2 text-sm transition-colors ${tone} ${
        interactive ? 'cursor-pointer hover:bg-surface-container-high' : 'cursor-default opacity-70'
      }`}
    >
      {/* Weight, not removal: a destructive choice the vendor offered stays
          offered, and hiding it would leave the user unable to answer. */}
      {option.isDestructive ? <AlertTriangle size={13} className="shrink-0" /> : null}
      <span>{label}</span>
    </button>
  );
}

/**
 * The vendor's own label wins.
 *
 * `labelKey` exists only for option ids MangoStudio itself recognizes, so a
 * vendor that supplied no text still gets a readable button. When the vendor
 * wrote the label, that is what the button says.
 */
function optionLabel(
  option: ExternalApprovalOption,
  labels: { option: Record<string, string> }
): string {
  if (option.rawLabel) return option.rawLabel;
  const key = option.labelKey?.split('.').at(-1);
  return (key ? labels.option[key] : undefined) ?? option.id;
}

function headingFor(
  decisionSource: ExternalApprovalPart['decisionSource'],
  labels: { title: string; answered: string; expired: string; cancelled: string }
): string {
  if (decisionSource === undefined) return labels.title;
  if (decisionSource === 'expired') return labels.expired;
  if (decisionSource === 'cancelled') return labels.cancelled;
  return labels.answered;
}
