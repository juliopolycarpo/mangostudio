/**
 * Shared browser-socket handshake: cookie session plus Origin check.
 *
 * Every WebSocket route a signed-in browser opens directly — `/api/ws` and
 * `/api/terminal/:id` — authenticates the same way and shares the same close
 * codes. A paired runtime's own `/api/runtime` socket authenticates with a
 * machine credential instead and has no use for this.
 *
 * See docs/architecture/realtime.md ("Authentication And Origins"): a
 * disallowed browser Origin closes `4403`; a missing, disallowed, or
 * `x-api-key`-carrying session closes `4401` even when the key could resolve
 * to a user.
 */

import { API_KEY_HEADER } from '@mangostudio/shared/api-keys';
import { getAuth } from '../auth';
import { getConfig } from '../lib/config';

export type BrowserSocketRejection = 'unauthorized' | 'forbidden' | 'internal' | null;

export interface BrowserSocketHandshakeResult {
  readonly userId: string | null;
  readonly rejection: BrowserSocketRejection;
}

export interface BrowserSocketHandshakeDependencies {
  readonly resolveUserId?: (headers: Headers) => Promise<string | null>;
  /** Static override for tests; production reads the live CORS + auth origins per handshake. */
  readonly allowedOrigins?: readonly string[];
  /** Called, not thrown, on a session-resolution failure — each route logs with its own tag. */
  readonly onSessionResolutionError?: (error: unknown) => void;
}

async function resolveCookieUserId(headers: Headers): Promise<string | null> {
  const session = await getAuth().api.getSession({ headers });
  return session?.user.id ?? null;
}

/** Every configured CORS origin, plus the Better Auth origin when it parses. */
function configuredAllowedOrigins(): string[] {
  const config = getConfig();
  const origins = new Set(config.corsOrigins);
  try {
    origins.add(new URL(config.auth.url).origin);
  } catch {
    // Invalid auth URLs fail Better Auth initialization; keep route setup fail-soft.
  }
  return [...origins];
}

/**
 * Builds a per-route handshake resolver.
 *
 * The origin allowlist is read fresh on every call rather than captured at
 * construction: this module is evaluated once per process, and a Set built
 * here would bind the gate to whatever config happened to be live at first
 * import — under the shared-module-graph integration lane, that is whichever
 * test file imported the route first. An injected list stays static: a caller
 * that passes one is pinning an explicit set, not asking for the configured
 * one.
 * // Usage: const handshake = createBrowserSocketHandshake();
 * //        const { userId, rejection } = await handshake(request.headers);
 */
export function createBrowserSocketHandshake(
  dependencies: BrowserSocketHandshakeDependencies = {}
): (headers: Headers) => Promise<BrowserSocketHandshakeResult> {
  const resolveUserId = dependencies.resolveUserId ?? resolveCookieUserId;
  const injectedOrigins = dependencies.allowedOrigins ? new Set(dependencies.allowedOrigins) : null;
  const isAllowedOrigin = (origin: string): boolean =>
    injectedOrigins ? injectedOrigins.has(origin) : configuredAllowedOrigins().includes(origin);

  return async (headers: Headers): Promise<BrowserSocketHandshakeResult> => {
    const origin = headers.get('origin');
    if (origin && !isAllowedOrigin(origin)) return { userId: null, rejection: 'forbidden' };
    if (headers.has(API_KEY_HEADER)) return { userId: null, rejection: 'unauthorized' };

    try {
      const userId = await resolveUserId(headers);
      return userId ? { userId, rejection: null } : { userId: null, rejection: 'unauthorized' };
    } catch (error) {
      dependencies.onSessionResolutionError?.(error);
      return { userId: null, rejection: 'internal' };
    }
  };
}
