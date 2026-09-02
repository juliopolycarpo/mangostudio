/**
 * Who the hub thinks it is talking to. Two questions start from the same
 * headers and end in different places: the rate limiter's "which counter does
 * this request belong to", and the local-surface guard's "is this browser at
 * this machine's keyboard".
 *
 * The socket peer cannot be forged, but behind a reverse proxy it is always the
 * proxy — a deployment that terminates TLS in nginx hands every request the
 * same loopback peer. `trustProxy` is the operator saying a proxy is there, and
 * it is the only thing that lets a header outrank the peer.
 *
 * Which header, and which hop, is where the two part company. `X-Forwarded-For`
 * is a list, and only its **last** entry is written by the proxy: nginx's
 * `$proxy_add_x_forwarded_for` and Caddy's `reverse_proxy` both *append* the
 * address they saw to whatever the caller sent. The first entry is therefore
 * the caller's own claim. The limiter wants that first entry anyway — it is the
 * origin client, which is what a counter should be keyed on. The guard must not
 * touch it: a remote browser that sends `X-Forwarded-For: 127.0.0.1` would
 * otherwise be handed this machine's restart button.
 */

/** Upper bound on a plausible IP token (IPv6 + zone id ≈ 50 chars); reject longer. */
const MAX_CLIENT_IP_LENGTH = 64;

/**
 * Trimmed IP candidate, or null when it is empty or implausibly long. Bounds the
 * store-key size so a hostile forwarded header cannot push megabyte-long keys
 * into memory. // Usage: sanitizeClientIp(' 1.2.3.4 ') // → "1.2.3.4"
 */
function sanitizeClientIp(value: string | undefined | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_CLIENT_IP_LENGTH) return null;
  return trimmed;
}

/**
 * Extract the client IP, honoring proxy headers only when explicitly trusted.
 * `ip` is the peer socket address (the unspoofable default); proxy headers
 * override it only when `trustProxy` is set. Every source is run through
 * `sanitizeClientIp`, so a blank leading X-Forwarded-For hop (e.g. ",9.9.9.9")
 * or an oversized value falls through to the next source instead of yielding an
 * empty/huge key that would bypass or bloat the limiter.
 *
 * Returns `'unknown'` when no source yields a usable address. That is not a
 * loopback address, so a caller the hub cannot identify is not one the guard
 * places at its own keyboard.
 *
 * Takes `headers` and `ip` as discrete arguments rather than the request or the
 * whole Elysia context on purpose. Elysia statically analyzes hook source to
 * decide what to materialize: handing a hook the full context (or the bare
 * `request`) makes it treat the body as "maybe used" and eagerly parse it,
 * which consumes the stream before the Better Auth passthrough can read it
 * (`ERR_BODY_ALREADY_USED`) — and also drops the `set` mutations made later in
 * the request. Referencing only the `headers` sub-object sidesteps both.
 *
 * // Usage: extractClientIp(headers, server?.requestIP(request)?.address, trustProxy)
 */
export function extractClientIp(
  headers: Headers,
  ip: string | undefined,
  trustProxy: boolean
): string {
  if (!trustProxy) return sanitizeClientIp(ip) ?? 'unknown';

  const forwarded = sanitizeClientIp(headers.get('x-forwarded-for')?.split(',')[0]);
  if (forwarded) return forwarded;

  const proxyIp =
    sanitizeClientIp(headers.get('cf-connecting-ip')) ?? sanitizeClientIp(headers.get('x-real-ip'));
  return proxyIp ?? sanitizeClientIp(ip) ?? 'unknown';
}

/**
 * The address the local-surface guard judges — the one deciding whether a
 * caller may install a runtime, restart this hub, or read its raw log.
 *
 * Behind a trusted proxy that is the **last** `X-Forwarded-For` hop, because
 * that is the one the proxy appended and no caller can write. The other
 * candidates are all forgeable in one of the two documented deployments: a
 * client-sent `CF-Connecting-IP` passes through nginx untouched, a client-sent
 * `X-Real-IP` passes through Caddy, and the first `X-Forwarded-For` hop is
 * whatever the caller put there.
 *
 * Without a trusted proxy the socket peer stands, exactly as before — a header
 * cannot promote a remote caller then either.
 *
 * // Usage: resolveGuardClientIp(headers, server?.requestIP(request)?.address, trustProxy)
 */
export function resolveGuardClientIp(
  headers: Headers,
  peerIp: string | undefined,
  trustProxy: boolean
): string {
  if (!trustProxy) return sanitizeClientIp(peerIp) ?? 'unknown';

  const appended = sanitizeClientIp(headers.get('x-forwarded-for')?.split(',').at(-1));
  return appended ?? sanitizeClientIp(peerIp) ?? 'unknown';
}
