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
  try {
    const response = await fetch(`http://${resolveHost(host)}:${port}/api/health`, {
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

/** 0.0.0.0 is a bind address, not routable as a client target — use loopback. */
function resolveHost(host: string): string {
  return host === '0.0.0.0' ? '127.0.0.1' : host;
}
