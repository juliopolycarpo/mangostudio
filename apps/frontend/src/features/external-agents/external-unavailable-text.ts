import type {
  ExternalAgentRemedy,
  ExternalAgentUnavailableReason,
} from '@mangostudio/shared/external-agents';
import type { Messages } from '@mangostudio/shared/i18n';

/**
 * The sentence for an unavailable reason, with `{version}` filled in.
 *
 * `version-unsupported` is the one reason whose copy names a build, and not
 * every caller has one to name: the selector reads the adapter's pin off the
 * descriptor, while a send refusal carries only the reason. Both go through
 * here so a missing version degrades to the same readable fallback instead of
 * printing a literal placeholder.
 *
 * @example
 * externalUnavailableText('version-unsupported', t, descriptor.requiredVersion);
 */
export function externalUnavailableText(
  reason: ExternalAgentUnavailableReason,
  t: Messages,
  requiredVersion?: string
): string {
  const version = requiredVersion ?? t.externalAgents.selector.unknownVersion;
  // A function, not the string: a version is data, and `String.replace` reads `$&` in a string.
  return t.externalAgents.unavailable[reason].replace('{version}', () => version);
}

/**
 * One line for a surface that has no room for a card: the reason in the selector's words, then the
 * thing to do about it (the sign-in command, or the install or update action's name).
 *
 * The remedy is the hub's, never text out of the vendor's error, and nothing here runs it. A remedy
 * that is only a link elsewhere, or has no action, leaves the sentence alone.
 *
 * @example
 * externalRefusalLine({ unavailableReason: 'signed-out', remedy: { kind: 'sign-in', command: 'codex login' } }, t);
 * // 'Installed, but signed out: codex login'
 */
export function externalRefusalLine(
  refusal: {
    readonly unavailableReason: ExternalAgentUnavailableReason;
    readonly remedy?: ExternalAgentRemedy | undefined;
    readonly requiredVersion?: string | undefined;
  },
  t: Messages
): string {
  const sentence = externalUnavailableText(refusal.unavailableReason, t, refusal.requiredVersion);
  const remedy = refusal.remedy;
  if (remedy?.kind === 'sign-in' && remedy.command) return `${sentence}: ${remedy.command}`;
  if (remedy?.kind === 'install' || remedy?.kind === 'update') {
    return `${sentence}: ${t.externalAgents.remedy[remedy.kind]}`;
  }
  return sentence;
}
