/**
 * `POST /api/control/shutdown`: the CLI asks this hub to stop through the same graceful path a
 * SIGTERM takes. It exists for Windows, where `mangostudio stop` has no catchable signal to send.
 *
 * Two independent checks stand in front of it, and a request must pass both:
 *
 * 1. The caller is a direct loopback peer. The socket address decides, never a forwarded header,
 *    and a request that carries any proxy header is refused: behind nginx or Caddy the peer is
 *    always the proxy on loopback, so the peer alone would let a remote browser through.
 * 2. The caller holds the control token from the state file (`lib/hub-control.ts`).
 *
 * No session or API key is involved; the token is the credential. Without an issued token (a hub
 * run without a state file) every request is refused.
 */

import { ApiErrorResponseSchema, ERROR_CODES } from '@mangostudio/shared/errors';
import { HubShutdownResponseSchema } from '@mangostudio/shared/machine';
import { Elysia, status } from 'elysia';

import {
  currentHubControlToken,
  HUB_CONTROL_TOKEN_HEADER,
  hubControlTokenMatches,
} from '../lib/hub-control';
import { isLoopback } from '../lib/ip-address';
import { requestShutdown } from '../server/shutdown-request';

/** Headers a reverse proxy adds. Any of them means the socket peer is not the real caller. */
const PROXY_HEADERS = [
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'forwarded',
  'x-real-ip',
  'cf-connecting-ip',
] as const;

export interface HubControlDeps {
  /** The token a caller must present; `undefined` refuses every request. */
  readonly token: () => string | undefined;
  /** Starts the graceful stop. Called after the response is on its way. */
  readonly shutdown: () => void;
  /** The socket peer's address, for a test that cannot dial from elsewhere. */
  readonly peerAddress?: (request: Request, server: PeerLookup | null) => string | undefined;
}

/** The slice of Bun's server this route reads. */
interface PeerLookup {
  requestIP(request: Request): { address: string } | null;
}

function socketPeer(request: Request, server: PeerLookup | null): string | undefined {
  return server?.requestIP(request)?.address;
}

/** True when the request came straight from this machine, with no proxy in between. */
function isDirectLoopbackCall(request: Request, peer: string | undefined): boolean {
  if (peer === undefined || !isLoopback(peer)) return false;
  return PROXY_HEADERS.every((name) => !request.headers.has(name));
}

/**
 * Build the control routes.
 * // Usage: app.use(createHubControlRoutes({ token: currentHubControlToken, shutdown: requestShutdown }))
 */
export function createHubControlRoutes(deps: HubControlDeps) {
  const peerOf = deps.peerAddress ?? socketPeer;
  return new Elysia().post(
    '/control/shutdown',
    {
      // Internal: a person never calls it, so it stays out of the published API document.
      detail: { hide: true },
      response: {
        202: HubShutdownResponseSchema,
        401: ApiErrorResponseSchema,
        403: ApiErrorResponseSchema,
      },
    },
    ({ request, server, set }) => {
      if (!isDirectLoopbackCall(request, peerOf(request, server as PeerLookup | null))) {
        return status(403, {
          error: 'Shutdown is only accepted from this machine.',
          code: ERROR_CODES.PERMISSION_DENIED,
        });
      }
      if (!hubControlTokenMatches(request.headers.get(HUB_CONTROL_TOKEN_HEADER), deps.token())) {
        return status(401, {
          error: 'Missing or invalid control token.',
          code: ERROR_CODES.UNAUTHORIZED,
        });
      }
      // After the response, so the caller is not left holding a socket the stop closes.
      setTimeout(deps.shutdown, 0);
      set.status = 202;
      return { status: 'stopping' as const };
    }
  );
}

export const hubControlRoutes = createHubControlRoutes({
  token: currentHubControlToken,
  shutdown: () => requestShutdown(),
});
