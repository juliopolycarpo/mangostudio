/**
 * Health probe for a running MangoStudio server via GET /api/health.
 */

import { isLoopback } from '../lib/ip-address';

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
 * Maps a server-state host to a safe loopback fetch target, or `null` when the
 * host is not local. Bind-all addresses (`0.0.0.0`, `::`) are not routable as
 * client targets, so they map to loopback.
 */
function resolveLocalTarget(host: string): string | null {
  const normalized = host.trim().toLowerCase();

  if (normalized === '0.0.0.0') return '127.0.0.1';
  if (normalized === '::' || normalized === '[::]') return '[::1]';
  if (!isLoopback(normalized)) return null;

  // isLoopback recognizes bracketed, `::ffff:`-mapped and trailing-dot forms that
  // this function never saw before; re-bracket anything IPv6-shaped so the fetch
  // URL below stays valid (`http://::1:PORT` would otherwise collide with the
  // port separator).
  const bracketless =
    normalized.startsWith('[') && normalized.endsWith(']') ? normalized.slice(1, -1) : normalized;
  return bracketless.includes(':') ? `[${bracketless}]` : bracketless;
}
