import type {
  ExternalAgentDescriptor,
  ExternalAgentUnavailableReason,
} from '@mangostudio/shared/external-agents';
import { Callout } from '@/components/ui/Callout';
import { ExternalRemedyLink } from '@/features/external-agents/ExternalRemedyLink';
import { externalUnavailableText } from '@/features/external-agents/external-unavailable-text';
import { SignInCommand } from '@/features/external-agents/SignInCommand';
import { useI18n } from '@/hooks/use-i18n';

interface ExternalRunnerBlockedCalloutProps {
  /** The chat's runner as discovery last described it; absent while discovery has not answered. */
  descriptor: ExternalAgentDescriptor | undefined;
}

/**
 * Why a descriptor cannot host a turn when it does not say so itself.
 *
 * A signed-out or uninstalled agent is refused by `externalAgentSelectable`
 * whether or not the runtime also attached a reason to it, and the notice should
 * name the cause either way rather than fall back to a sentence about nothing in
 * particular.
 */
function reasonFor(
  descriptor: ExternalAgentDescriptor
): ExternalAgentUnavailableReason | undefined {
  if (descriptor.unavailableReason) return descriptor.unavailableReason;
  if (!descriptor.installed) return 'not-installed';
  if (descriptor.authState === 'signed-out') return 'signed-out';
  return undefined;
}

/**
 * The notice above a composer whose runner cannot take a turn.
 *
 * "Install it", "sign in", "wake that machine" and "wait for discovery" are four
 * different things to do, and a composer that goes quiet without saying which
 * leaves the user clicking Send at nothing. So the title is the selector's own
 * sentence for the reason — one source for the words, with `{version}` filled in
 * — and the way out is the control the header's runner selector already draws:
 * the vendor's sign-in command to copy, or the link to where the install and
 * update recipes live. Neither runs anything; both are for the user to act on.
 *
 * A reason with no control to offer (a machine another person administers, a
 * notice that has to be read first) says only what is wrong. The one thing left
 * to suggest, when the agent may simply not be reachable yet, is another runner.
 *
 * // Usage: <ExternalRunnerBlockedCallout descriptor={externalDescriptor} />
 */
export function ExternalRunnerBlockedCallout({ descriptor }: ExternalRunnerBlockedCalloutProps) {
  const { t } = useI18n();
  const reason = descriptor ? reasonFor(descriptor) : undefined;
  const remedy = descriptor?.remedy;

  const loginCommand =
    reason === 'signed-out'
      ? (descriptor?.loginCommand ?? (remedy?.kind === 'sign-in' ? remedy.command : undefined))
      : undefined;
  const hasRemedyLink = remedy?.kind === 'install' || remedy?.kind === 'update';
  // `disclosure-required` is its own instruction: the title already says to read
  // the notice, and suggesting another runner would point away from the fix.
  const suggestsAnotherRunner = !loginCommand && !hasRemedyLink && reason !== 'disclosure-required';
  // One child or none: `Callout` draws its body wrapper for any truthy
  // `children`, and an array of two nulls is truthy.
  const body = loginCommand ? (
    <SignInCommand command={loginCommand} className="max-w-xs" />
  ) : suggestsAnotherRunner ? (
    t.externalAgents.selector.unavailableTryElsewhere
  ) : null;

  return (
    <Callout
      tone="warning"
      role="status"
      className="mb-2"
      title={
        reason
          ? externalUnavailableText(reason, t, descriptor?.requiredVersion)
          : t.externalAgents.selector.unavailableHere
      }
      action={hasRemedyLink && remedy ? <ExternalRemedyLink remedy={remedy} /> : undefined}
    >
      {body}
    </Callout>
  );
}
