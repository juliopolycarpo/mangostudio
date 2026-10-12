import type { ExternalAgentUnavailableReason } from '@mangostudio/shared/external-agents';
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
