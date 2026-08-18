/**
 * Validates outbound URLs to prevent SSRF attacks.
 * Rejects loopback, RFC1918 private, CGNAT, unique-local, link-local,
 * multicast, reserved, and other non-public unicast addresses.
 */

import { lookup } from 'node:dns/promises';
import { isPrivateOrLocal, parseIpAddress } from '../../../lib/ip-address';

// The resolver's stated family is not part of the contract: every address is
// classified by parsing its own text, so a resolver that mislabels one cannot
// steer the decision.
type ResolvedAddress = Readonly<{ address: string }>;
type HostResolver = (hostname: string) => Promise<ReadonlyArray<ResolvedAddress>>;

const BLOCKED_MESSAGE = 'URL resolves to a blocked private or loopback address.';

/**
 * Why a URL was refused.
 *
 * `unresolvable` is the odd one out and the reason this is not a boolean: it
 * says nothing about the address, only that this host could not ask. A caller
 * that has an offline answer — a previously verified cache — needs to tell that
 * apart from a policy refusal, and the message already distinguishes the two,
 * so naming it costs no information a reader of the text did not have.
 */
export type UnsafeBaseUrlReason =
  /** Not a URL, or not a scheme this policy allows. */
  | 'invalid-url'
  /** Resolved to loopback, private, unique-local, or link-local space. */
  | 'blocked-address'
  /** The hostname could not be resolved at all. */
  | 'unresolvable';

export class UnsafeBaseUrlError extends Error {
  readonly reason: UnsafeBaseUrlReason;

  constructor(message: string, reason: UnsafeBaseUrlReason = 'blocked-address') {
    super(message);
    this.name = 'UnsafeBaseUrlError';
    this.reason = reason;
  }
}

const hostnameResolutionCache = new Map<string, Promise<ReadonlyArray<ResolvedAddress>>>();

function resolveHostname(hostname: string): Promise<ReadonlyArray<ResolvedAddress>> {
  const cached = hostnameResolutionCache.get(hostname);
  if (cached) return cached;

  const pending = lookup(hostname, { all: true }).catch((error) => {
    hostnameResolutionCache.delete(hostname);
    throw error;
  });

  hostnameResolutionCache.set(hostname, pending);
  return pending;
}

export interface ValidateBaseUrlOptions {
  readonly resolveHostname?: HostResolver;
}

/**
 * Validates a base URL for outbound provider requests.
 * Rejects non-http(s) schemes and hostnames that resolve to private/loopback addresses.
 *
 * @throws {UnsafeBaseUrlError} if the URL is unsafe.
 */
export async function validateBaseUrl(
  rawUrl: string,
  options: ValidateBaseUrlOptions = {}
): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new UnsafeBaseUrlError('Invalid URL.', 'invalid-url');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new UnsafeBaseUrlError('Only http and https URLs are allowed.', 'invalid-url');
  }

  const hostname = parsed.hostname;

  // A hostname that parses as an address is judged directly; anything else is a
  // name, which is exactly what the DNS branch below is for. `new URL` has already
  // rejected every malformed literal (`http://256.1.1.1/` throws), so a dotted quad
  // reaching here is well-formed and this discriminator never sends one to DNS.
  if (parseIpAddress(hostname) !== null) {
    if (isPrivateOrLocal(hostname)) {
      throw new UnsafeBaseUrlError(BLOCKED_MESSAGE);
    }
    return;
  }

  try {
    const results = await (options.resolveHostname ?? resolveHostname)(hostname);
    // `lookup({ all: true })` rejects on NXDOMAIN rather than returning [], but
    // `options.resolveHostname` is injectable and an empty array must not count
    // as "every address is public".
    if (results.length === 0) {
      throw new UnsafeBaseUrlError(`DNS resolution failed for hostname "${hostname}".`);
    }
    for (const result of results) {
      if (isPrivateOrLocal(result.address)) {
        throw new UnsafeBaseUrlError(BLOCKED_MESSAGE);
      }
    }
  } catch (err) {
    if (err instanceof UnsafeBaseUrlError) throw err;
    throw new UnsafeBaseUrlError(
      `DNS resolution failed for hostname "${hostname}".`,
      'unresolvable'
    );
  }
}
