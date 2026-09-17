/**
 * Address facts both ends of the hub/runtime boundary read.
 *
 * A runtime decides from one whether its serve socket is exposed to the
 * network; the hub decides from the same one whether a URL may carry
 * credentials in plaintext. It is the same question, and two spellings of "is
 * this loopback" would eventually answer it differently.
 */

/**
 * Recognizes localhost and the conventional IPv4/IPv6 loopback spellings.
 *
 * Deliberately excludes other 127/8 and IPv4-mapped IPv6 forms. This is a
 * conservative allowlist shared by the runtime's listening warning and the
 * hub's credential transport checks, not a complete IP address classifier.
 * Widening it requires reviewing both callers' policies. The MCP transport
 * guard separately accepts canonical 127/8 in its private-network check.
 *
 * @example
 * isLoopbackHostname('[::1]'); // true
 */
export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return (
    normalized === '127.0.0.1' ||
    normalized === 'localhost' ||
    normalized === '::1' ||
    normalized === '0:0:0:0:0:0:0:1'
  );
}
