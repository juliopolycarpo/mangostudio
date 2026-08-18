/**
 * Outbound fetch for URLs the user chose.
 *
 * Every request the server makes on a user's behalf is an SSRF primitive: the
 * caller picks the address, and the server reaches it from inside whatever
 * network the deployment sits in. This module is the one place that shape is
 * allowed, and it is deliberately narrow — HTTPS only, every redirect hop
 * re-checked against the address policy, a byte cap enforced while the body
 * streams rather than after it lands, and a wall-clock deadline.
 *
 * ## DNS rebinding
 *
 * The address policy resolves the hostname and classifies the addresses it gets
 * back, then `fetch` resolves the same name again to open the connection. A
 * hostile resolver can answer differently the second time, and neither Bun's
 * `fetch` nor Node's global one exposes a connection hook that would let us pin
 * the address we validated. That window is therefore real and is contained
 * rather than closed:
 *
 * - the response is capped and never streamed onward, so nothing is a tunnel;
 * - callers validate the payload before storing it (an internal service's reply
 *   is not a PNG), which is what stops a rebind from planting content;
 * - failures surface as this module's own messages, so a caller cannot use the
 *   error text to read back a status line, header, or body from an address it
 *   was refused.
 *
 * A rebind can therefore cost a blind, bounded GET against an internal address
 * — not a read of one.
 */

import {
  UnsafeBaseUrlError,
  type UnsafeBaseUrlReason,
  type ValidateBaseUrlOptions,
  validateBaseUrl,
} from '../services/providers/core/base-url-policy';

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * What kind of thing went wrong, for callers that have to act differently.
 *
 * The distinction that earns this taxonomy is `network` versus everything
 * else: "this host could not reach the server" is recoverable from a local
 * cache, while "the server answered and said no" is not. Reading it back out
 * of the message worked until a URL contained the digits of a status code.
 */
export type SafeFetchErrorKind =
  /** Not a URL this module will fetch, or a redirect into one. */
  | 'invalid-url'
  /** The address policy refused the host — see {@link UnsafeBaseUrlReason}. */
  | 'address-refused'
  /** The exchange never completed: DNS, connect, timeout, or a truncated body. */
  | 'network'
  /** The caller's own signal fired. Never a fault of the remote host. */
  | 'cancelled'
  /** The server answered. Non-2xx, or a 2xx with no body. Status is in `status`. */
  | 'http'
  /** The body exceeded the caller's cap, declared or streamed. */
  | 'too-large';

export class SafeFetchError extends Error {
  readonly kind: SafeFetchErrorKind;
  /** The HTTP status, on `kind: 'http'` only. */
  readonly status?: number;

  constructor(message: string, kind: SafeFetchErrorKind = 'network', status?: number) {
    super(message);
    this.name = 'SafeFetchError';
    this.kind = kind;
    if (status !== undefined) this.status = status;
  }
}

/**
 * Whether a failure means the release could not be reached, as opposed to
 * reaching it and being told no.
 *
 * `429` and `5xx` are counted with the transport failures on purpose: a rate
 * limit or a bad gateway is the origin declining to answer *this* request, not
 * an answer about the resource. A `404` is an answer, and callers that fall
 * back to a local copy must not treat one as an excuse to.
 */
export function isUnreachableFailure(error: unknown): boolean {
  if (!(error instanceof SafeFetchError)) return false;
  if (error.kind === 'network') return true;
  if (error.kind !== 'http') return false;
  return error.status === 408 || error.status === 429 || (error.status ?? 0) >= 500;
}

export interface SafeFetchDeps {
  readonly fetch: typeof fetch;
  /**
   * Hostname resolver for the address policy. Injectable so tests exercise the
   * real policy without depending on DNS.
   */
  readonly resolveHostname?: ValidateBaseUrlOptions['resolveHostname'];
}

export interface SafeFetchOptions {
  /** Hard cap on the response body, enforced as it streams. */
  readonly maxBytes: number;
  readonly maxRedirects: number;
  /** Wall-clock deadline covering redirects and the body read. */
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface SafeFetchResult {
  readonly bytes: Uint8Array;
  /** Advertised type, for callers that cross-check it against the bytes. */
  readonly contentType: string | null;
  /** The URL that actually served the bytes, after redirects. */
  readonly url: string;
}

const defaultDeps: SafeFetchDeps = { fetch };

/**
 * Fetches a user-supplied HTTPS URL and returns the body, or throws
 * `SafeFetchError`. The result is bytes, never a live stream: a caller cannot
 * accidentally forward a response it has not measured.
 */
export async function safeFetchBytes(
  rawUrl: string,
  options: SafeFetchOptions,
  overrides: Partial<SafeFetchDeps> = {}
): Promise<SafeFetchResult> {
  const deps = { ...defaultDeps, ...overrides };
  const requestedUrl = parseHttpsUrl(rawUrl);
  assertLimits(options);

  const signal = combineSignals(options);
  const { response, resolvedUrl } = await followRedirects(deps, requestedUrl, options, signal);

  if (!response.ok) {
    await discardBody(response);
    throw new SafeFetchError(
      `Request failed with HTTP ${response.status}.`,
      'http',
      response.status
    );
  }

  return {
    bytes: await readBounded(response, options.maxBytes),
    contentType: response.headers.get('content-type'),
    url: resolvedUrl.href,
  };
}

function parseHttpsUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SafeFetchError('URL is invalid.', 'invalid-url');
  }
  if (url.protocol !== 'https:') {
    throw new SafeFetchError('URL must use HTTPS.', 'invalid-url');
  }
  return url;
}

function assertLimits(options: SafeFetchOptions): void {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1) {
    throw new SafeFetchError('Response size limit is invalid.', 'invalid-url');
  }
  if (!Number.isSafeInteger(options.maxRedirects) || options.maxRedirects < 0) {
    throw new SafeFetchError('Redirect limit is invalid.', 'invalid-url');
  }
}

/**
 * The deadline covers the whole exchange rather than each hop, so a chain of
 * slow redirects cannot multiply it.
 */
function combineSignals(options: SafeFetchOptions): AbortSignal | undefined {
  const timeout = options.timeoutMs ? AbortSignal.timeout(options.timeoutMs) : undefined;
  if (!timeout) return options.signal;
  if (!options.signal) return timeout;
  return AbortSignal.any([options.signal, timeout]);
}

/**
 * Walks the redirect chain by hand. `redirect: 'manual'` is what makes every hop
 * visible: with automatic following, only the first URL is ever checked and a
 * `302` into `169.254.169.254` is fetched before anyone can object.
 */
async function followRedirects(
  deps: SafeFetchDeps,
  requestedUrl: URL,
  options: SafeFetchOptions,
  signal: AbortSignal | undefined
): Promise<{ response: Response; resolvedUrl: URL }> {
  let currentUrl = requestedUrl;

  for (let hop = 0; ; hop += 1) {
    await assertAllowedAddress(deps, currentUrl);

    const response = await requestOnce(deps, currentUrl, options, signal);
    if (!REDIRECT_STATUSES.has(response.status)) {
      const resolvedUrl = response.url ? new URL(response.url) : currentUrl;
      if (resolvedUrl.protocol !== 'https:') {
        await discardBody(response);
        throw new SafeFetchError('Resolved to a non-HTTPS URL.', 'invalid-url');
      }
      return { response, resolvedUrl };
    }

    if (hop >= options.maxRedirects) {
      await discardBody(response);
      throw new SafeFetchError('Exceeded the redirect limit.', 'invalid-url');
    }

    currentUrl = nextRedirectTarget(response, currentUrl);
    await discardBody(response);
  }
}

/**
 * The combined signal cannot say which half fired, so the caller's own signal is
 * consulted first. A caller that cancelled deliberately should not be told its
 * request timed out — that reads as a fault in the remote host.
 */
async function requestOnce(
  deps: SafeFetchDeps,
  url: URL,
  options: SafeFetchOptions,
  signal: AbortSignal | undefined
): Promise<Response> {
  try {
    return await deps.fetch(url, { redirect: 'manual', ...(signal && { signal }) });
  } catch (error) {
    if (options.signal?.aborted) throw new SafeFetchError('Request was cancelled.', 'cancelled');
    if (signal?.aborted) throw new SafeFetchError('Request timed out.');
    const detail = error instanceof Error ? error.message : 'Unknown network error.';
    throw new SafeFetchError(`Request failed: ${detail}`);
  }
}

async function assertAllowedAddress(deps: SafeFetchDeps, url: URL): Promise<void> {
  try {
    await validateBaseUrl(
      url.href,
      deps.resolveHostname ? { resolveHostname: deps.resolveHostname } : {}
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Unknown address policy failure.';
    // A name that will not resolve is not a refusal, whatever the wording: the
    // policy never got as far as judging an address. Callers with a local
    // fallback depend on that difference, which is why it is read from the
    // error's own reason rather than from the sentence it produced.
    throw new SafeFetchError(`Host was refused: ${detail}`, addressFailureKind(error));
  }
}

function addressFailureKind(error: unknown): SafeFetchErrorKind {
  const reason: UnsafeBaseUrlReason | undefined =
    error instanceof UnsafeBaseUrlError ? error.reason : undefined;
  return reason === 'unresolvable' ? 'network' : 'address-refused';
}

function nextRedirectTarget(response: Response, currentUrl: URL): URL {
  const location = response.headers.get('location');
  if (!location) {
    throw new SafeFetchError('Redirect did not include a location.', 'invalid-url');
  }

  let nextUrl: URL;
  try {
    nextUrl = new URL(location, currentUrl);
  } catch {
    throw new SafeFetchError('Redirected to an invalid URL.', 'invalid-url');
  }
  // Checked before the hop is taken, so a downgrade is never requested at all.
  if (nextUrl.protocol !== 'https:') {
    throw new SafeFetchError('Redirected to a non-HTTPS URL.', 'invalid-url');
  }
  return nextUrl;
}

/**
 * Reads the body with the cap applied per chunk.
 *
 * `content-length` is only a hint — it is checked first because an honest
 * server lets us refuse before transferring anything, and it is not trusted
 * afterwards because a hostile one can understate or omit it.
 */
async function readBounded(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await discardBody(response);
    throw new SafeFetchError(`Response exceeds the ${maxBytes}-byte limit.`, 'too-large');
  }
  if (!response.body) {
    // The server completed the exchange. A 204, or a 200 whose body was
    // stripped, is an unusable answer — not a failure to reach the host —
    // so it must not inherit the constructor's `network` default.
    throw new SafeFetchError('Response had no body.', 'http', response.status);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new SafeFetchError(`Response exceeds the ${maxBytes}-byte limit.`, 'too-large');
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof SafeFetchError) throw error;
    throw new SafeFetchError('Response body could not be read.');
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** Releases a body we are not going to read so the socket is not left open. */
async function discardBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}
