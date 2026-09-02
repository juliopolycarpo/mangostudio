/**
 * Health probe for a running MangoStudio server via GET /api/health.
 */

import type { HubHealth } from '@mangostudio/shared/machine';
import { formatHostForUrl, isLoopback } from '../lib/ip-address';

const DEFAULT_TIMEOUT_MS = 1000;

/** True when the server answers /api/health with 200 {status:'ok'}. */
// Usage: await probeHealth('localhost', 3001);
export async function probeHealth(
  host: string,
  port: number,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<boolean> {
  const target = resolveLocalTarget(host);
  // This command checks *this* MangoStudio instance. The host comes from a local
  // runtime-state file, so fail closed rather than issue a request to an
  // arbitrary, possibly attacker-controlled host (CodeQL js/file-access-to-http).
  if (target === null) {
    return false;
  }

  try {
    const response = await fetch(`http://${target}:${port}/api/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      return false;
    }
    const body = (await response.json()) as { status?: string };
    return body.status === 'ok';
  } catch {
    return false;
  }
}

/**
 * The health check as a gate on an instance a caller has already found alive in
 * the state file. True when the endpoint answered — and true, without asking,
 * for a host {@link canProbeHealth} refuses: there the state file is the only
 * evidence available, it is written once the port is bound, and waiting for a
 * probe that can never succeed would fail a server that is running.
 * // Usage: if (await confirmsHealthy(state.host, state.port)) return state;
 */
export async function confirmsHealthy(
  host: string,
  port: number,
  timeoutMs?: number
): Promise<boolean> {
  if (!canProbeHealth(host)) return true;
  return await probeHealth(host, port, timeoutMs);
}

/** The two probes {@link probeHubHealth} reads, so a caller can inject them. */
export interface HubHealthProbes {
  readonly probeHealth: (host: string, port: number) => Promise<boolean>;
  readonly canProbeHealth: (host: string) => boolean;
}

/**
 * The health check as a *report* on an instance, for callers that describe a hub
 * rather than wait for one. The counterpart to {@link confirmsHealthy}: where a
 * waiter treats an unprobable host as healthy so it stops waiting, a reporter
 * says `unprobed`, because calling it `unreachable` would draw a healthy server
 * as broken.
 * // Usage: await probeHubHealth(state.host, state.port) // → 'ok'
 */
export async function probeHubHealth(
  host: string,
  port: number,
  probes: HubHealthProbes = { probeHealth, canProbeHealth }
): Promise<HubHealth> {
  if (!probes.canProbeHealth(host)) return 'unprobed';
  return (await probes.probeHealth(host, port)) ? 'ok' : 'unreachable';
}

/**
 * Whether {@link probeHealth} can say anything about this host. It is false for
 * a bind to one explicit non-loopback address: the server is listening on that
 * interface alone, so loopback would not answer, and the probe will not fetch
 * the address itself. A caller must report that as unknown rather than as a
 * server that failed to answer.
 * // Usage: canProbeHealth('192.168.1.20') // → false
 */
export function canProbeHealth(host: string): boolean {
  return resolveLocalTarget(host) !== null;
}

/**
 * Maps a server-state host to a safe loopback fetch target, or `null` when the
 * host is not local. Bind-all addresses (`0.0.0.0`, `::`) are not routable as
 * client targets, so they map to loopback.
 */
function resolveLocalTarget(host: string): string | null {
  const target = formatHostForUrl(host);

  if (target === '0.0.0.0') return '127.0.0.1';
  if (target === '[::]') return '[::1]';
  return isLoopback(host) ? target : null;
}
