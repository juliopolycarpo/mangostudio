/**
 * gzip for large JSON API responses sent to a peer that is not this machine.
 *
 * Loopback is the default deployment, and there compression only spends CPU:
 * the bytes never leave the host. A hub served with `--host` to a LAN is where
 * it pays, so the peer decides. The rules are narrow on purpose:
 *
 * - Only a plain handler value (an object or array Elysia would serialize as
 *   JSON) is touched. A `Response` — the SSE streams, the Better Auth
 *   passthrough, file bodies, anything a route already shaped — is never
 *   re-encoded, so a stream cannot be buffered here.
 * - GET only (HEAD and conditional answers keep their headers), 2xx only,
 *   nothing already carrying a `Content-Encoding`, nothing marked `no-transform`.
 * - The socket peer, never a forwarded header, decides "remote". A hub behind a
 *   reverse proxy sees the proxy's loopback address and sends identity; the
 *   proxy owns compression there.
 * - Routes that issue or echo credentials are opted out ({@link NEVER_COMPRESSED_PREFIXES}).
 *   See `docs/architecture/frontend-build.md` for the BREACH reasoning.
 *
 * gzip only: browsers send `Accept-Encoding: gzip, deflate` without `br` or
 * `zstd` to a plain-HTTP address, and Bun has no native Brotli encoder.
 * Level 1 was chosen from `scripts/bench/api-json-compression.ts`: it wins
 * end to end on any link below roughly 440 Mbit/s for a 500 KB transcript page,
 * where level 6 only breaks even below about 160 Mbit/s.
 */

import { Elysia } from 'elysia';

import { isLoopback } from '../lib/ip-address';
import { negotiateEncoding, varyOnAcceptEncoding } from '../server/accept-encoding';
import { resolveStatus } from './error-negotiation';

/** Below this the saving is a few hundred bytes and not worth a `Vary` split. */
export const COMPRESSION_MIN_BYTES = 8 * 1024;

/** Fastest zlib level: the best break-even link speed in the benchmark. */
export const COMPRESSION_GZIP_LEVEL = 1;

/**
 * Path prefixes whose responses carry or echo credentials: session tokens, API
 * keys shown once, runtime pairing tokens, OAuth authorize URLs, connector
 * secrets. Compressing a body that mixes such a value with request-chosen text
 * lets an observer infer the secret from the compressed length (BREACH).
 */
export const NEVER_COMPRESSED_PREFIXES: readonly string[] = [
  '/api/auth',
  '/api/api-keys',
  '/api/environments',
  '/api/settings/connectors',
  '/api/settings/secrets',
];

export interface ResponseCompressionOptions {
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

function isCredentialPath(pathname: string): boolean {
  return NEVER_COMPRESSED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
  );
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
function weakenEtag(headers: Record<string, unknown>): void {
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() !== 'etag') continue;
    const value = String(headers[key]);
    if (!value.startsWith('W/')) headers[key] = `W/${value}`;
  }
}

export function responseCompression(options: ResponseCompressionOptions = {}) {
  const peerAddress = options.peerAddress ?? defaultPeerAddress;
  // Unnamed on purpose: each mount may inject its own `peerAddress`, and Elysia
  // deduplicates named plugins.
  return new Elysia().mapResponse('plugin', ({ request, server, set, responseValue }) => {
    if (request.method !== 'GET') return undefined;
    if (!isPlainJsonValue(responseValue)) return undefined;
    const code = resolveStatus(responseValue, set);
    if (code !== null && (code < 200 || code >= 300)) return undefined;
    if (isCredentialPath(new URL(request.url).pathname)) return undefined;

    const peer = peerAddress(request, server as PeerSource | null);
    if (peer === undefined || isLoopback(peer)) return undefined;

    const headers = set.headers as Record<string, unknown>;
    if (headerValue(headers, 'content-encoding') !== undefined) return undefined;
    if (/\bno-transform\b/i.test(headerValue(headers, 'cache-control') ?? '')) return undefined;
    const contentType = headerValue(headers, 'content-type');
    if (contentType !== undefined && !/^application\/json\b/i.test(contentType)) return undefined;

    // Whether this response may be encoded depends on the request's header from
    // here on, so every cache must key on it, whichever way this request goes.
    varyOnAcceptEncoding(headers);
    if (negotiateEncoding(request.headers.get('accept-encoding'), ['gzip']) !== 'gzip') {
      return undefined;
    }

    let json: string;
    try {
      json = JSON.stringify(responseValue);
    } catch {
      return undefined; // Let the framework's own serializer report it.
    }
    const raw = Buffer.from(json);
    if (raw.byteLength < COMPRESSION_MIN_BYTES) return undefined;

    const packed = Bun.gzipSync(raw, { level: COMPRESSION_GZIP_LEVEL });
    weakenEtag(headers);
    return new Response(packed, {
      status: typeof set.status === 'number' ? set.status : 200,
      headers: {
        'content-type': contentType ?? 'application/json',
        'content-encoding': 'gzip',
        'content-length': String(packed.byteLength),
        vary: String(headerValue(headers, 'vary')),
        ...(headerValue(headers, 'etag') ? { etag: headerValue(headers, 'etag') as string } : {}),
      },
    });
  });
}
