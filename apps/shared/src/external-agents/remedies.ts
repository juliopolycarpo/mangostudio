/**
 * What would fix an agent that cannot run.
 *
 * A greyed row that says *why* is already better than a greyed row that says
 * nothing, and it is still not an answer: "signed out" and "version
 * unsupported" are diagnoses, and the person reading them wants the next step.
 * A remedy is that step, named as a thing MangoStudio can offer rather than as
 * prose — so the interface can render it as a control instead of asking the
 * user to go and find one.
 *
 * **A closed set, mapped from a closed set.** `EXTERNAL_AGENT_REMEDIES` is
 * `satisfies Record<ExternalAgentUnavailableReason, …>`, so a reason added
 * later cannot ship without someone deciding what to do about it. That is the
 * whole reason the mapping is data here rather than a `switch` at each render
 * site: three call sites each falling through to "no action" is how a new
 * reason silently becomes a dead end.
 *
 * The mapping is deliberately *not* the adapter's job. An adapter states facts
 * about the binary in front of it; what those facts mean for a user is a
 * product decision, and it is made once, here — see `unavailableReasonFor`,
 * which draws the same line.
 *
 * Browser-safe: pure data, no Node builtins.
 */

import type {
  ExternalAgentRemedy,
  ExternalAgentRemedyKind,
  ExternalAgentUnavailableReason,
} from './schemas';

/**
 * The code a turn ends with when the agent refused a prompt because the vendor account is signed
 * out (the External Agents SDK's `mango_agent_acp::error::AUTH_REQUIRED_CODE`).
 *
 * A Rust test in the runtime compares this literal with the SDK's constant, so an SDK rename fails
 * CI instead of silently turning a sign-in prompt back into a raw vendor error.
 */
export const EXTERNAL_AUTH_REQUIRED_ERROR_CODE = 'acp-auth-required';

/**
 * The reason → remedy table.
 *
 * `environment-unreachable` and `isolation-unproven` are `contact-admin`
 * rather than `none`, and the difference is worth stating: both are properties
 * of the *machine*, not of the agent, and the person who can change them is
 * usually not the person reading the row. Saying so is more useful than an
 * empty space, even though MangoStudio can offer no button for either.
 */
export const EXTERNAL_AGENT_REMEDIES = {
  'not-installed': 'install',
  'signed-out': 'sign-in',
  'version-unsupported': 'update',
  // The runtime is the thing that lacks the adapter, so upgrading the *agent*
  // would not help. Nothing on this screen fixes it.
  'runtime-unsupported': 'none',
  'runtime-denied': 'contact-admin',
  'environment-unreachable': 'contact-admin',
  'isolation-unproven': 'contact-admin',
  'disclosure-required': 'accept-disclosure',
  'installed-but-unusable': 'contact-admin',
} as const satisfies Record<ExternalAgentUnavailableReason, ExternalAgentRemedyKind>;

/**
 * What to offer for a turn that ended in `error`, or `undefined` when no remedy is known.
 *
 * Only the signed-out ending has one, and it is the same remedy the pre-send check offers for
 * `signed-out` ({@link externalRemedyFor}), with the same command: the caller passes the target's
 * own login command, never text taken from the vendor's error.
 *
 * @example
 * externalRemedyForError({ code: 'acp-auth-required' }, { loginCommand: 'cursor-agent login' });
 * // { kind: 'sign-in', command: 'cursor-agent login' }
 */
export function externalRemedyForError(
  error: { readonly code: string },
  options: { readonly loginCommand?: string } = {}
): ExternalAgentRemedy | undefined {
  if (error.code !== EXTERNAL_AUTH_REQUIRED_ERROR_CODE) return undefined;
  return externalRemedyFor('signed-out', options);
}

/**
 * What to offer for a reason, or `undefined` when the target is fine.
 *
 * @example
 * externalRemedyFor('version-unsupported'); // { kind: 'update' }
 */
export function externalRemedyFor(
  reason: ExternalAgentUnavailableReason | undefined,
  options: { readonly loginCommand?: string } = {}
): ExternalAgentRemedy | undefined {
  if (!reason) return undefined;
  const kind = EXTERNAL_AGENT_REMEDIES[reason];
  return {
    kind,
    ...(kind === 'sign-in' && options.loginCommand ? { command: options.loginCommand } : {}),
  };
}
