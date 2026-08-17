/**
 * The cheap pass: what the existing environment scanner can honestly say.
 *
 * `probeAgentClis` already runs for the Environments UI, is already cached, and
 * looks for the binary and its credential-adjacent files. That is enough to
 * decide whether a target is worth escalating to the adapter, and enough to
 * answer at all when the adapter cannot be reached — but it is a fallback, not
 * the truth. The authoritative answer comes from the CLI's own status command,
 * run by the runtime, and it replaces everything below when it arrives.
 *
 * Pure functions only: given a status, produce a verdict. Nothing here reaches
 * a runtime, a database or a clock.
 */

import type { AgentCliStatus } from '@mangostudio/shared/environments';
// Detection is a separate entrypoint from the `environments` barrel on purpose
// (it reaches for `node:path`); this module is hub-side, so it may import it.
import { AGENT_CLI_DEFINITIONS } from '@mangostudio/shared/environments/detection';
import type { ExternalAgentAuthState } from '@mangostudio/shared/external-agents';

/**
 * Targets whose credentials can live outside the config home.
 *
 * Read off the CLI definitions rather than listed here, so a target that gains
 * or loses a keychain store changes this in one place. `unknownWhenMissing` is
 * exactly the definition's way of saying "an absent credential file proves
 * nothing about this target".
 */
const KEYCHAIN_BACKED_TARGET_IDS: ReadonlySet<string> = new Set(
  AGENT_CLI_DEFINITIONS.filter(
    (definition) =>
      definition.kind === 'cli' &&
      definition.auth.kind === 'file' &&
      definition.auth.unknownWhenMissing
  ).map((definition) => definition.targetId)
);

/** A CLI the scanner could not find is not installed, whatever else it saw. */
export function isInstalled(status: AgentCliStatus): boolean {
  return (
    status.effective !== undefined &&
    !status.findings.some((finding) => finding.code === 'cli-not-installed')
  );
}

/**
 * Sign-in state as far as file presence can tell.
 *
 * `unknown` is a real answer and is kept as one: Claude may hold its
 * credentials in an OS keychain, so a missing file proves nothing, and telling
 * a signed-in user they are signed out is worse than admitting uncertainty.
 */
export function authStateFrom(status: AgentCliStatus): ExternalAgentAuthState {
  switch (status.authSignal) {
    case 'file-present':
    case 'config-key-present':
    case 'session':
      return status.authenticated ? 'signed-in' : 'signed-out';
    case 'file-absent':
    case 'config-key-absent':
      return 'signed-out';
    default:
      break;
  }

  // A config home that is not there means nothing has been written yet, which
  // is a signed-out machine rather than an unknowable one — but only where the
  // config home is where the credential would be. For a keychain-backed target
  // the credential outlives the directory, so the absent config home says
  // nothing the absent credential file did not already say, and `unknown` from
  // the scan stays `unknown` rather than becoming a login prompt for someone
  // who is already signed in.
  if (KEYCHAIN_BACKED_TARGET_IDS.has(status.targetId)) return 'unknown';

  return status.findings.some((finding) => finding.code === 'config-home-missing')
    ? 'signed-out'
    : 'unknown';
}

/** The installed version, when the scan parsed one. */
export function versionFrom(status: AgentCliStatus): string | undefined {
  return status.effective?.version ?? undefined;
}
