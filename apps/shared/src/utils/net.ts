/**
 * Address facts both ends of the hub/runtime boundary read.
 *
 * A runtime decides from one whether its serve socket is exposed to the
 * network; the hub decides from the same one whether a URL may carry
 * credentials in plaintext. It is the same question, and two spellings of "is
 * this loopback" would eventually answer it differently.
 */

/**
 * True for addresses that never leave this machine.
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
