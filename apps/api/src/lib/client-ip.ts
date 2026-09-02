/**
 * Who the hub thinks it is talking to. Two questions share one answer here: the
 * rate limiter's "which counter does this request belong to", and the
 * local-surface guard's "is this browser at this machine's keyboard".
 *
 * Both hang on the same trade-off. The socket peer address cannot be forged by
 * a caller, but behind a reverse proxy it is always the proxy — so a deployment
 * that terminates TLS in nginx hands every request the same loopback peer.
 * Proxy headers name the real client, but any caller can write them.
 * `trustProxy` is the operator saying which of the two shapes this deployment
 * is, and it is the only thing that decides between them.
 *
 * For the guard that matters in the strict direction, not the loose one: with a
 * trusted proxy in front, the forwarded client is what stops a remote session
 * from passing a loopback check that is supposed to mean "at this keyboard".
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
