/**
 * Health probe for a running MangoStudio server via GET /api/health.
 */

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

  if (normalized === '0.0.0.0' || normalized === '127.0.0.1' || normalized === 'localhost') {
    return normalized === '0.0.0.0' ? '127.0.0.1' : normalized;
  }
  if (
    normalized === '::' ||
    normalized === '::1' ||
    normalized === '[::]' ||
    normalized === '[::1]'
  ) {
    return '[::1]';
  }
  if (isLoopbackIPv4(normalized)) {
    return normalized;
  }
  return null;
}

/** True for any address in the 127.0.0.0/8 loopback range. */
function isLoopbackIPv4(host: string): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return false;

  const octets = match.slice(1).map(Number);
  return octets.every((octet) => octet <= 255) && octets[0] === 127;
}
