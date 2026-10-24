import type {
  ExternalAgentRemedy,
  ExternalAgentUnavailableReason,
} from '@mangostudio/shared/external-agents';
import {
  EXTERNAL_AGENT_CAPACITY_CODE,
  isExternalAgentKindCode,
} from '@mangostudio/shared/external-agents/values';
import { Callout } from '@/components/ui/Callout';
import { ExternalRemedyLink } from '@/features/external-agents/ExternalRemedyLink';
import { externalUnavailableText } from '@/features/external-agents/external-unavailable-text';
import { SignInCommand } from '@/features/external-agents/SignInCommand';
import { useI18n } from '@/hooks/use-i18n';
import { usePlural } from '@/hooks/use-plural';
import { toolLoopRounds } from '../../lib/tool-loop-detail';

interface ErrorPartProps {
  text: string;
  /** Why an external agent could not start, when the hub knew; said in the user's words. */
  unavailableReason?: ExternalAgentUnavailableReason;
  /** What the person can do about it: a sign-in command to copy, or the install and update link. */
  remedy?: ExternalAgentRemedy;
  /** The build `version-unsupported` asks for; absent when the hub did not name one. */
  requiredVersion?: string;
  /**
   * The runtime's kind for a failed open with no reason. The session cap has copy of its own; any
   * other kind keeps `text` and is shown as plain text, so the person has something to quote.
   */
  code?: string;
  /**
   * The hub's own note on the turn's `tool_loop_exhausted` event — how far the tool loop got
   * before it stopped. It is English the hub wrote, so the card says it in the reader's words
   * (the number of rounds) and keeps the original only as the sentence's tooltip, for quoting.
   */
  detail?: string;
}

/**
 * A turn-level failure, shown verbatim so the reported cause is not reworded.
 *
 * The one exception is an external agent that could not start for a reason the product already
 * presents (signed out, not installed, outdated, consent withdrawn): it says that reason with the
 * selector's words, a sign-in remedy carries the command to run, and an install or update remedy
 * links to where the recipes live. A runtime at its session cap has no reason, so the hub names it
 * by `code` and the client says it in plain words. `text` stays the fallback for everything else.
 *
 * // Usage: <ErrorPart text={part.text} unavailableReason={part.unavailableReason} />
 */
export function ErrorPart({
  text,
  unavailableReason,
  remedy,
  requiredVersion,
  code,
  detail,
}: ErrorPartProps) {
  const { t } = useI18n();
  const plural = usePlural();
  const rounds = toolLoopRounds(detail);
  const command = remedy?.kind === 'sign-in' ? remedy.command : undefined;
  // A reason describes the agent; the session cap describes the runtime, so it is keyed by code.
  const capacity = !unavailableReason && code === EXTERNAL_AGENT_CAPACITY_CODE;
  // Only a kind of the runtime's shape, and only where no other copy already says what happened.
  const kind = !unavailableReason && !capacity && isExternalAgentKindCode(code) ? code : undefined;
  const sentence = unavailableReason
    ? externalUnavailableText(unavailableReason, t, requiredVersion)
    : capacity
      ? t.externalAgents.openFailure.capacity
      : text;
  return (
    <Callout tone="danger" className="max-w-(--timeline-card-max)">
      <div className="space-y-1.5">
        <p className="text-fg" title={detail}>
          {sentence}
        </p>
        {rounds !== null ? (
          <p>
            {plural(
              { one: t.chat.feed.toolLoopRoundsOne, other: t.chat.feed.toolLoopRoundsOther },
              rounds
            )}
          </p>
        ) : null}
        {kind ? <span className="block font-mono text-micro text-fg-subtle">{kind}</span> : null}
        {command ? <SignInCommand command={command} /> : null}
        {unavailableReason && remedy ? <ExternalRemedyLink remedy={remedy} /> : null}
      </div>
    </Callout>
  );
}
