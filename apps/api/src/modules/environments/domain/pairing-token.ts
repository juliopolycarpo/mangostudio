/**
 * Pairing token format for runtimes that dial the hub.
 *
 * A token is a selector and a verifier: `mrt_<id>.<secret>`. The hub stores the
 * id in the clear and only the SHA-256 of the secret, so verifying a presented
 * token is one indexed lookup by id followed by a constant-time comparison of
 * digests — never a scan that compares against every stored hash in turn.
 *
 * This is deliberately not Better Auth's apiKey plugin: with
 * `enableSessionForAPIKeys` a verified key resolves into a user session, and a
 * machine credential that mints a user session is a different security object
 * from one that authorizes exactly one environment's socket.
 */

import { randomBytes } from 'node:crypto';
import { computeHash } from '../../../utils/hash';

/** Marks the string in a paste or a bug report for what it is. */
export const RUNTIME_PAIRING_TOKEN_PREFIX = 'mrt_';

const SELECTOR_BYTES = 16;
const SECRET_BYTES = 32;

export interface GeneratedPairingToken {
  /** Public half, stored in the clear and used to find the row. */
  readonly id: string;
  /** Secret half; the caller sees it once and the hub keeps only its digest. */
  readonly token: string;
  readonly tokenHash: string;
}

export interface ParsedPairingToken {
  readonly id: string;
  readonly secret: string;
}

export function hashPairingSecret(secret: string): string {
  return computeHash(secret);
}

export function generatePairingToken(): GeneratedPairingToken {
  const id = randomBytes(SELECTOR_BYTES).toString('base64url');
  const secret = randomBytes(SECRET_BYTES).toString('base64url');
  return {
    id,
    token: `${RUNTIME_PAIRING_TOKEN_PREFIX}${id}.${secret}`,
    tokenHash: hashPairingSecret(secret),
  };
}

/** Splits a presented token. Returns null for anything not shaped like one. */
export function parsePairingToken(raw: string): ParsedPairingToken | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith(RUNTIME_PAIRING_TOKEN_PREFIX)) return null;

  const body = trimmed.slice(RUNTIME_PAIRING_TOKEN_PREFIX.length);
  const separator = body.indexOf('.');
  if (separator <= 0 || separator === body.length - 1) return null;

  const id = body.slice(0, separator);
  const secret = body.slice(separator + 1);
  // A second separator means the string was never produced here; refuse it
  // rather than silently pairing on a prefix of somebody's secret.
  if (secret.includes('.')) return null;
  return { id, secret };
}

/**
 * The `ws(s)://…/api/runtime` address a runtime dials, derived from the hub's
 * configured public URL. Null when that is unset or unusable — the request's
 * own Host header would be a guess, and one the caller controls.
 */
export function runtimeDialEndpoint(publicUrl: string): string | null {
  const trimmed = publicUrl.trim();
  if (!trimmed) return null;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  // A hub mounted under a path prefix by a reverse proxy keeps that prefix;
  // `new URL('api/runtime', base)` would drop the last segment instead.
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/api/runtime`;
  url.search = '';
  url.hash = '';
  return url.toString();
}
