/**
 * PKCE (RFC 7636) helpers shared by all OAuth connector flows.
 */

export interface PkcePair {
  verifier: string;
  challenge: string;
}

function base64UrlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

/** Creates a high-entropy code verifier and its S256 challenge. */
export async function createPkcePair(): Promise<PkcePair> {
  const verifier = base64UrlEncode(crypto.getRandomValues(new Uint8Array(64)));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge: base64UrlEncode(new Uint8Array(digest)) };
}

/** Creates an unguessable `state` value binding the callback to its session. */
export function createOAuthState(): string {
  return crypto.randomUUID();
}
