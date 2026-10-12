import type {
  ExternalAgentRemedy,
  ExternalAgentUnavailableReason,
} from '@mangostudio/shared/external-agents';
import { ExternalRemedyLink } from '@/features/external-agents/ExternalRemedyLink';
import { externalUnavailableText } from '@/features/external-agents/external-unavailable-text';
import { SignInCommand } from '@/features/external-agents/SignInCommand';
import { useI18n } from '@/hooks/use-i18n';

interface ErrorPartProps {
  text: string;
  /** Why an external agent could not start, when the hub knew; said in the user's words. */
  unavailableReason?: ExternalAgentUnavailableReason;
  /** What the person can do about it: a sign-in command to copy, or the install and update link. */
  remedy?: ExternalAgentRemedy;
  /** The build `version-unsupported` asks for; absent when the hub did not name one. */
  requiredVersion?: string;
}

/**
 * A turn-level failure, shown verbatim so the reported cause is not reworded.
 *
 * The one exception is an external agent that could not start for a reason the product already
 * presents (signed out, not installed, outdated, consent withdrawn): it says that reason with the
 * selector's words, a sign-in remedy carries the command to run, and an install or update remedy
 * links to where the recipes live. `text` stays the fallback for everything else.
 *
 * // Usage: <ErrorPart text={part.text} unavailableReason={part.unavailableReason} />
 */
export function ErrorPart({ text, unavailableReason, remedy, requiredVersion }: ErrorPartProps) {
  const { t } = useI18n();
  const command = remedy?.kind === 'sign-in' ? remedy.command : undefined;
  return (
    <div className="max-w-2xl space-y-1.5 rounded-xl border border-error/20 bg-error/10 p-4 font-body text-sm text-error">
      <p>
        {unavailableReason ? externalUnavailableText(unavailableReason, t, requiredVersion) : text}
      </p>
      {command ? <SignInCommand command={command} /> : null}
      {unavailableReason && remedy ? <ExternalRemedyLink remedy={remedy} /> : null}
    </div>
  );
}
