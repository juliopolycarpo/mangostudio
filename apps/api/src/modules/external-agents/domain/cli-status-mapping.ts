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
import type { ExternalAgentAuthState } from '@mangostudio/shared/external-agents';

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
  // is a signed-out machine rather than an unknowable one.
  return status.findings.some((finding) => finding.code === 'config-home-missing')
    ? 'signed-out'
    : 'unknown';
}

/** The installed version, when the scan parsed one. */
export function versionFrom(status: AgentCliStatus): string | undefined {
  return status.effective?.version;
}
