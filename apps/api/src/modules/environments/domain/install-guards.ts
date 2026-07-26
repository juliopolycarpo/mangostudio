import type { InstallGuard, InstallGuardReason } from '@mangostudio/shared/environments';

export interface InstallGuardContext {
  readonly serverHost: string;
  readonly clientIp: string | undefined;
  readonly installsEnabled: boolean;
  readonly standalone: boolean;
  readonly container: boolean;
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
