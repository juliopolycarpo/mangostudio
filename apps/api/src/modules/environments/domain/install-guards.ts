import type { InstallGuard, InstallGuardReason } from '@mangostudio/shared/environments';

/**
 * What the hub knows about its own surface. These checks are all about the
 * machine this process runs on: whether the browser talking to it is sitting at
 * the same keyboard, and whether installing anything here would write into a
 * container that is about to be thrown away.
 */
export interface InstallGuardContext {
  readonly serverHost: string;
  readonly clientIp: string | undefined;
  readonly installsEnabled: boolean;
  readonly standalone: boolean;
  readonly container: boolean;
}

/**
 * The same question about someone else's machine. Nothing the hub can measure
 * locally says anything about it, so the only inputs are the global switch,
 * a per-environment opt-in that somebody had to turn on deliberately, and —
 * when known — whether that machine's consent still grants shell (installs
 * spawn a command).
 */
export interface RemoteInstallGuardContext {
  readonly installsEnabled: boolean;
  readonly allowInstalls: boolean;
  /**
   * Whether the connected runtime advertises shell. Unknown (disconnected, or
   * an older peer without the flag) defaults to allowed so the trust toggle
   * remains the only gate until consent is visible.
   */
  readonly runtimeShellAllowed?: boolean;
}

function normalizeAddress(value: string): string {
  const trimmed = value.trim().toLowerCase();
  const withoutBrackets =
    trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : trimmed;
  const withoutZone = withoutBrackets.split('%', 1)[0] ?? withoutBrackets;
  return withoutZone.endsWith('.') ? withoutZone.slice(0, -1) : withoutZone;
}

export function isLoopbackAddress(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = normalizeAddress(value);
  if (normalized === 'localhost' || normalized === '::1') return true;
  if (normalized.startsWith('::ffff:')) {
    return isLoopbackAddress(normalized.slice('::ffff:'.length));
  }

  const octets = normalized.split('.');
  if (octets.length !== 4 || octets.some((octet) => !/^\d{1,3}$/.test(octet))) {
    return false;
  }
  if (octets.some((octet) => Number(octet) > 255)) return false;
  return Number(octets[0]) === 127;
}

export function evaluateInstallGuard(context: InstallGuardContext): InstallGuard {
  const reasons: InstallGuardReason[] = [];

  if (context.container) reasons.push('container');
  if (!context.standalone && !isLoopbackAddress(context.serverHost)) {
    reasons.push('server-not-loopback');
  }
  if (!isLoopbackAddress(context.clientIp)) reasons.push('client-not-loopback');
  if (!context.installsEnabled) reasons.push('disabled');

  return {
    allowed: reasons.length === 0,
    reasons,
  };
}

/**
 * The guard for an environment that is not the hub's own machine.
 *
 * The loopback checks are deliberately absent rather than reused. They ask
 * "is the person driving this hub sitting at the machine that would be
 * written to", and for a remote environment the answer is no by construction —
 * applying them would refuse every remote install for a reason that names the
 * wrong machine. What replaces them is an explicit per-environment opt-in, and
 * a container is now the *runtime's* business to report, because the
 * containerized side may be the far one.
 */
export function evaluateRemoteInstallGuard(context: RemoteInstallGuardContext): InstallGuard {
  const reasons: InstallGuardReason[] = [];

  if (!context.allowInstalls) reasons.push('environment-not-trusted');
  if (!context.installsEnabled) reasons.push('disabled');
  if (context.runtimeShellAllowed === false) reasons.push('runtime-denied');

  return {
    allowed: reasons.length === 0,
    reasons,
  };
}
