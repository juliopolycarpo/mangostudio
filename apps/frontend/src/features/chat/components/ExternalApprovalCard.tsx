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
 *
 * Once an option has been chosen the card becomes a record of it: the chosen
 * option's own label, and nothing to press. The "never removes a choice" rule is
 * about the question; an answered card is no longer asking one, and three grey
 * tiles beside a faint check would leave the reader to work out which of them
 * was the authorisation.
 */

import type { ExternalApprovalOption } from '@mangostudio/shared/external-agents';
import type { ExternalApprovalPart } from '@mangostudio/shared/types';
import { AlertTriangle, Check } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { SectionCard } from '@/components/ui/SectionCard';
import { useI18n } from '@/hooks/use-i18n';
import { ICON_MD } from '@/lib/icon-sizes';
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
  const settled = decisionSource === 'expired' || decisionSource === 'cancelled' || expired;
  // The record is only for an answer someone gave. A dead card keeps its row of
  // inert options, and so does a decision naming an option the part does not
  // carry: nothing here may claim an authorisation it cannot show.
  const answeredOption = settled
    ? undefined
    : part.options.find((option) => option.id === decision);

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
    <SectionCard
      label={headingFor(
        decisionSource ?? (expired ? 'expired' : answeredOption ? 'user' : undefined),
        labels
      )}
      className="w-full max-w-(--timeline-card-max) text-sm text-fg"
    >
      {/* Vendor text, rendered inert. */}
      <p className="whitespace-pre-wrap font-medium text-fg">{part.title}</p>
      {part.detail ? (
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-canvas p-3 font-mono text-xs text-fg-muted">
          {part.detail}
        </pre>
      ) : null}
      {part.truncated ? <p className="text-xs text-fg-muted">{labels.truncatedHint}</p> : null}

      {error ? <Callout tone="danger" title={error} /> : null}

      {answeredOption ? (
        <AnsweredOption option={answeredOption} label={optionLabel(answeredOption, labels)} />
      ) : (
        <div className="flex flex-wrap gap-2">
          {part.options.map((option) => (
            <OptionButton
              key={option.id}
              option={option}
              label={optionLabel(option, labels)}
              interactive={interactive && !submitting}
              onClick={() => void answer(option.id)}
            />
          ))}
        </div>
      )}

      {settled ? (
        <p className="text-xs text-fg-muted">
          {decisionSource === 'cancelled' ? labels.cancelledHint : labels.expiredHint}
        </p>
      ) : null}
      {decisionSource === 'auto-review' ? (
        <Callout tone="warning">{labels.autoReviewedHint}</Callout>
      ) : null}
    </SectionCard>
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
  interactive,
  onClick,
}: {
  option: ExternalApprovalOption;
  label: string;
  interactive: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      variant="secondary"
      disabled={!interactive}
      onClick={onClick}
      data-destructive={option.isDestructive ? 'true' : undefined}
    >
      {/* Weight, not removal: a destructive choice the vendor offered stays
          offered, and hiding it would leave the user unable to answer. The
          glyph carries the warning; the label stays the vendor's own words. */}
      {option.isDestructive ? (
        <AlertTriangle size={ICON_MD} className="shrink-0 text-danger" />
      ) : null}
      <span>{label}</span>
    </Button>
  );
}

/**
 * What an answered approval says: the option that was chosen, as a line of text.
 *
 * Not a button, because there is nothing left to press, and not a disabled one,
 * because a disabled tile is how this card draws an option that *cannot* be
 * chosen. The check is the contract's selection mark, in the accent text colour;
 * it is not a verdict, so a chosen "Deny" gets the same one as a chosen "Allow".
 * `isDestructive` says the option is risky, not that it was refused, so it keeps
 * the same warning glyph it wore as a button and nothing more.
 */
function AnsweredOption({ option, label }: { option: ExternalApprovalOption; label: string }) {
  return (
    <p
      data-destructive={option.isDestructive ? 'true' : undefined}
      className="flex items-center gap-2 font-medium text-fg"
    >
      <Check size={ICON_MD} className="shrink-0 text-accent-fg" />
      {option.isDestructive ? (
        <AlertTriangle size={ICON_MD} className="shrink-0 text-danger" />
      ) : null}
      <span className="min-w-0 break-words">{label}</span>
    </p>
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
