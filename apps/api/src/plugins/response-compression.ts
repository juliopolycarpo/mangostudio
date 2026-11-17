/**
 * gzip for the few large JSON API responses sent to a peer that is not this machine.
 *
 * Loopback is the default deployment, and there compression only spends CPU:
 * the bytes never leave the host. A hub served with `--host` to a LAN is where
 * it pays, so the peer decides. The rules are narrow on purpose:
 *
 * - An allowlist of route patterns, declared where the plugin is mounted. A new
 *   route is never compressed until someone decides it should be: a body that
 *   echoes a credential next to caller-chosen text is exposed to BREACH-style
 *   length attacks once compressed, and an opt-out list fails open for the next
 *   such route. See `docs/architecture/hub-runtime.md`.
 * - A plain handler value, or a JSON `Response` a route encoded itself (the chat
 *   list does) that declares a `Content-Length` between the two bounds below.
 *   Anything else, such as a stream without a length, SSE, files or the Better
 *   Auth passthrough, is left unread. Only a body that passed these checks is
 *   buffered, and at most {@link COMPRESSION_MAX_BYTES} of it.
 * - GET only (HEAD and conditional answers keep their headers), 2xx only,
 *   nothing already carrying a `Content-Encoding`, nothing marked `no-transform`.
 * - Between {@link COMPRESSION_MIN_BYTES} and {@link COMPRESSION_MAX_BYTES}.
 *   `Bun.gzipSync` blocks the event loop (about 4 ms per 0.5 MB), so a body over
 *   the ceiling goes out as identity rather than stalling every other request.
 * - The socket peer, never a forwarded header, decides "remote". A hub behind a
 *   reverse proxy sees the proxy's loopback address and sends identity; the
 *   proxy owns compression there.
 *
 * gzip only: browsers send `Accept-Encoding: gzip, deflate` without `br` or
 * `zstd` to a plain-HTTP address, and Bun has no native Brotli encoder.
 * Level 1 was chosen from `scripts/bench/api-json-compression.ts`: it wins
 * end to end on any link below roughly 450 to 600 Mbit/s for a 500 KB transcript page,
 * where level 6 only breaks even below about 160 Mbit/s.
 */

import { Elysia } from 'elysia';

import { isLoopback } from '../lib/ip-address';
import { negotiateEncoding, varyOnAcceptEncoding } from '../server/accept-encoding';
import { resolveStatus } from './error-negotiation';

/** Below this the saving is a few hundred bytes and not worth a `Vary` split. */
export const COMPRESSION_MIN_BYTES = 8 * 1024;

/**
 * Above this the body goes out as identity. Level 1 takes about 4 ms per
 * 0.5 MB, all of it on the event loop; 2 MiB keeps one response under roughly
 * 20 ms. A transcript page holds at most 100 messages (`PAGE_LIMIT_MAX`) and a
 * seeded 100-message page measures about 1 MB, so the ceiling is rarely reached:
 * only a page whose messages average more than about 20 KB, such as one full of
 * large tool results, goes out as identity.
 */
export const COMPRESSION_MAX_BYTES = 2 * 1024 * 1024;

/** Fastest zlib level: the best break-even link speed in the benchmark. */
export const COMPRESSION_GZIP_LEVEL = 1;

export interface ResponseCompressionOptions {
  /**
   * Route patterns (e.g. `/api/chats/:id/messages`, `:name` is one segment)
   * whose responses may be compressed. A trailing slash is ignored.
   */
  readonly routes: readonly string[];
  /**
   * The address of the socket peer, or undefined when unknown. Defaults to
   * Bun's `server.requestIP`. Unknown counts as local: refusing to compress is
   * the safe direction.
   */
  readonly peerAddress?: (request: Request, server: PeerSource | null) => string | undefined;
}

/** The slice of Bun's `Server` this plugin reads. */
export interface PeerSource {
  requestIP(request: Request): { address: string } | null;
}

const defaultPeerAddress: NonNullable<ResponseCompressionOptions['peerAddress']> = (
  request,
  server
) => server?.requestIP(request)?.address;

function stripTrailingSlash(path: string): string {
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
}

/**
 * A pattern such as `/api/chats/:id/messages` as an anchored matcher: `:name`
 * stands for one path segment. The request path is matched rather than the
 * router's pattern because Elysia leaves the pattern undefined for routes
 * declared inside a `group`.
 */
function patternMatcher(pattern: string): RegExp {
  const source = stripTrailingSlash(pattern)
    .split('/')
    .map((segment) =>
      segment.startsWith(':') ? '[^/]+' : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    )
    .join('/');
  return new RegExp(`^${source}$`);
}

function isPlainJsonValue(value: unknown): value is object {
  if (Array.isArray(value)) return true;
  if (typeof value !== 'object' || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function headerValue(headers: Record<string, unknown>, name: string): string | undefined {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== name) continue;
    if (typeof value === 'string' || typeof value === 'number') return String(value);
    if (Array.isArray(value)) return value.join(', ');
  }
  return undefined;
}

/** Weaken a strong validator: the gzip bytes are not the identity bytes it named. */
function weakenEtag(etag: string): string {
  return etag.startsWith('W/') ? etag : `W/${etag}`;
}

/**
 * The headers of the answer: everything the route's own `Response` carried
 * (repeated `Set-Cookie` included), with only the ones this plugin owns set.
 */
function outgoingHeaders(fromRoute: Response | null, contentType: string): Headers {
  const outgoing = new Headers(fromRoute?.headers);
  outgoing.set('content-type', contentType);
  return outgoing;
}

/** A finished JSON `Response`'s declared length, or undefined when absent or not a count. */
function declaredLength(response: Response): number | undefined {
  const text = response.headers.get('content-length');
  if (text === null || !/^\d+$/.test(text)) return undefined;
  return Number(text);
}

export function responseCompression(options: ResponseCompressionOptions) {
  const peerAddress = options.peerAddress ?? defaultPeerAddress;
  const matchers = options.routes.map(patternMatcher);
  // Unnamed on purpose: each mount injects its own allowlist, and Elysia
  // deduplicates named plugins.
  return new Elysia().mapResponse(
    'plugin',
    async ({ request, path, server, set, responseValue }) => {
      if (request.method !== 'GET') return undefined;
      if (!matchers.some((matcher) => matcher.test(stripTrailingSlash(path)))) return undefined;

      const fromRoute = responseValue instanceof Response ? responseValue : null;
      if (fromRoute === null && !isPlainJsonValue(responseValue)) return undefined;
      if (fromRoute !== null) {
        // A route's own `Response` is read only when it is a finished JSON body.
        const type = fromRoute.headers.get('content-type') ?? '';
        if (!/^application\/json\b/i.test(type) || fromRoute.body === null) return undefined;
        if (fromRoute.headers.has('content-encoding')) return undefined;
        if (/\bno-transform\b/i.test(fromRoute.headers.get('cache-control') ?? ''))
          return undefined;
        // Without a length inside the band the body is never read: a stream of
        // unknown size could be anything, and a large one is not worth buffering.
        const length = declaredLength(fromRoute);
        if (
          length === undefined ||
          length < COMPRESSION_MIN_BYTES ||
          length > COMPRESSION_MAX_BYTES
        )
          return undefined;
      }

      const code = fromRoute ? fromRoute.status : (resolveStatus(responseValue, set) ?? 200);
      if (code < 200 || code >= 300) return undefined;

      const peer = peerAddress(request, server as PeerSource | null);
      if (peer === undefined || isLoopback(peer)) return undefined;

      const headers = set.headers as Record<string, unknown>;
      if (fromRoute === null) {
        if (headerValue(headers, 'content-encoding') !== undefined) return undefined;
        if (/\bno-transform\b/i.test(headerValue(headers, 'cache-control') ?? '')) return undefined;
        const type = headerValue(headers, 'content-type');
        if (type !== undefined && !/^application\/json\b/i.test(type)) return undefined;
      }

      // Whether this response may be encoded depends on the request's header from
      // here on, so every cache must key on it, whichever way this request goes.
      // The route's own `Vary` (if it built a Response) joins the accumulated one.
      const routeVary = fromRoute?.headers.get('vary');
      if (routeVary) {
        headers.vary = [headerValue(headers, 'vary'), routeVary].filter(Boolean).join(', ');
      }
      varyOnAcceptEncoding(headers);
      if (negotiateEncoding(request.headers.get('accept-encoding'), ['gzip']) !== 'gzip') {
        return undefined;
      }

      let raw: Uint8Array<ArrayBuffer>;
      if (fromRoute !== null) {
        try {
          raw = new Uint8Array(await fromRoute.arrayBuffer());
        } catch (cause) {
          // The body is consumed and cannot be sent; a partial read is never
          // forwarded. Throwing lets the hub's error handler answer a 500.
          throw new Error(
            `(response-compression): expected the route's JSON body to be readable | received: ${String(cause)}`,
            { cause }
          );
        }
      } else {
        try {
          raw = new TextEncoder().encode(JSON.stringify(responseValue)) as Uint8Array<ArrayBuffer>;
        } catch {
          return undefined; // Let the framework's own serializer report it.
        }
      }

      const outgoing = outgoingHeaders(
        fromRoute,
        fromRoute?.headers.get('content-type') ?? 'application/json'
      );
      outgoing.set('vary', headerValue(headers, 'vary') as string);
      const etag = fromRoute?.headers.get('etag') ?? headerValue(headers, 'etag');
      const init = { status: code, statusText: fromRoute?.statusText ?? '', headers: outgoing };

      if (raw.byteLength < COMPRESSION_MIN_BYTES || raw.byteLength > COMPRESSION_MAX_BYTES) {
        // A plain value is left to Elysia's own serializer, so the identity
        // answer is byte for byte what it would have been; that costs a second
        // stringify, on allowlisted routes only. A route's own `Response` was
        // read (its declared length was inside the band but the body was not),
        // so it is rebuilt with the headers it carried and the true length.
        if (fromRoute === null) return undefined;
        if (etag !== undefined) outgoing.set('etag', etag);
        outgoing.set('content-length', String(raw.byteLength));
        return new Response(raw, init);
      }

      const packed = Bun.gzipSync(raw, { level: COMPRESSION_GZIP_LEVEL });
      if (etag !== undefined) outgoing.set('etag', weakenEtag(etag));
      outgoing.set('content-encoding', 'gzip');
      outgoing.set('content-length', String(packed.byteLength));
      return new Response(packed, init);
    }
  );
}
