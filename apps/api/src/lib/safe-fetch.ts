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
  type ValidateBaseUrlOptions,
  validateBaseUrl,
} from '../services/providers/core/base-url-policy';

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export class SafeFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SafeFetchError';
  }
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
    throw new SafeFetchError(`Request failed with HTTP ${response.status}.`);
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
    throw new SafeFetchError('URL is invalid.');
  }
  if (url.protocol !== 'https:') {
    throw new SafeFetchError('URL must use HTTPS.');
  }
  return url;
}

function assertLimits(options: SafeFetchOptions): void {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1) {
    throw new SafeFetchError('Response size limit is invalid.');
  }
  if (!Number.isSafeInteger(options.maxRedirects) || options.maxRedirects < 0) {
    throw new SafeFetchError('Redirect limit is invalid.');
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
        throw new SafeFetchError('Resolved to a non-HTTPS URL.');
      }
      return { response, resolvedUrl };
    }

    if (hop >= options.maxRedirects) {
      await discardBody(response);
      throw new SafeFetchError('Exceeded the redirect limit.');
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
    if (options.signal?.aborted) throw new SafeFetchError('Request was cancelled.');
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
    throw new SafeFetchError(`Host was refused: ${detail}`);
  }
}

function nextRedirectTarget(response: Response, currentUrl: URL): URL {
  const location = response.headers.get('location');
  if (!location) {
    throw new SafeFetchError('Redirect did not include a location.');
  }

  let nextUrl: URL;
  try {
    nextUrl = new URL(location, currentUrl);
  } catch {
    throw new SafeFetchError('Redirected to an invalid URL.');
  }
  // Checked before the hop is taken, so a downgrade is never requested at all.
  if (nextUrl.protocol !== 'https:') {
    throw new SafeFetchError('Redirected to a non-HTTPS URL.');
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
    throw new SafeFetchError(`Response exceeds the ${maxBytes}-byte limit.`);
  }
  if (!response.body) {
    throw new SafeFetchError('Response had no body.');
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
        throw new SafeFetchError(`Response exceeds the ${maxBytes}-byte limit.`);
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
