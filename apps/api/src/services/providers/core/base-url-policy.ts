/**
 * Validates outbound URLs to prevent SSRF attacks.
 * Rejects loopback, RFC1918 private, CGNAT, unique-local, and link-local addresses.
 */

import { lookup } from 'node:dns/promises';
import { isPrivateOrLocal } from '../../../lib/ip-address';

type AddressFamily = 4 | 6;
type ResolvedAddress = Readonly<{ address: string; family: AddressFamily }>;
type HostResolver = (hostname: string) => Promise<ReadonlyArray<ResolvedAddress>>;

export class UnsafeBaseUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeBaseUrlError';
  }
}

const hostnameResolutionCache = new Map<string, Promise<ReadonlyArray<ResolvedAddress>>>();

function resolveHostname(hostname: string): Promise<ReadonlyArray<ResolvedAddress>> {
  const cached = hostnameResolutionCache.get(hostname);
  if (cached) return cached;

  const pending = lookup(hostname, { all: true })
    .then((results) =>
      results.map((result) => ({
        address: result.address,
        family: result.family as AddressFamily,
      }))
    )
    .catch((error) => {
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
    throw new UnsafeBaseUrlError('Invalid URL.');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new UnsafeBaseUrlError('Only http and https URLs are allowed.');
  }

  const hostname = parsed.hostname;

  // Direct IPv4 literal check
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) {
    if (isPrivateOrLocal(hostname)) {
      throw new UnsafeBaseUrlError('URL resolves to a blocked private or loopback address.');
    }
    return;
  }

  // Direct IPv6 literal check (brackets kept by URL parser)
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    const bare = hostname.slice(1, -1);
    if (isPrivateOrLocal(bare)) {
      throw new UnsafeBaseUrlError('URL resolves to a blocked private or loopback address.');
    }
    return;
  }

  // DNS resolution check — classification runs on the resolved address text
  // itself (parsed by isPrivateOrLocal), not on the resolver's stated family.
  try {
    const results = await (options.resolveHostname ?? resolveHostname)(hostname);
    for (const result of results) {
      if (isPrivateOrLocal(result.address)) {
        throw new UnsafeBaseUrlError('URL resolves to a blocked private or loopback address.');
      }
    }
  } catch (err) {
    if (err instanceof UnsafeBaseUrlError) throw err;
    throw new UnsafeBaseUrlError(`DNS resolution failed for hostname "${hostname}".`);
  }
}
