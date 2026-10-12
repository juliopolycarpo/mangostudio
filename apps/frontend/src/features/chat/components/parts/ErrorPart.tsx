import type {
  ExternalAgentRemedy,
  ExternalAgentUnavailableReason,
} from '@mangostudio/shared/external-agents';
import { externalUnavailableText } from '@/features/external-agents/external-unavailable-text';
import { SignInCommand } from '@/features/external-agents/SignInCommand';
import { useI18n } from '@/hooks/use-i18n';

interface ErrorPartProps {
  text: string;
  /** Why an external agent could not start, when the hub knew; said in the user's words. */
  unavailableReason?: ExternalAgentUnavailableReason;
  /** A signed-out agent's sign-in command, shown to run and copy. */
  remedy?: ExternalAgentRemedy;
}

/**
 * A turn-level failure, shown verbatim so the reported cause is not reworded.
 *
 * The one exception is an external agent that could not start for a reason the product already
 * presents (signed out, consent withdrawn): it says that reason with the selector's words, and a
 * sign-in remedy carries the command to run. `text` stays the fallback for everything else.
 *
 * // Usage: <ErrorPart text={part.text} unavailableReason={part.unavailableReason} />
 */
export function ErrorPart({ text, unavailableReason, remedy }: ErrorPartProps) {
  const { t } = useI18n();
  const command = remedy?.kind === 'sign-in' ? remedy.command : undefined;
  return (
    <div className="max-w-2xl space-y-1.5 rounded-xl border border-error/20 bg-error/10 p-4 font-body text-sm text-error">
      <p>{unavailableReason ? externalUnavailableText(unavailableReason, t) : text}</p>
      {command ? <SignInCommand command={command} /> : null}
    </div>
  );
}
