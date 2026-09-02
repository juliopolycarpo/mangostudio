/**
 * Two questions, one set of headers: which counter a request belongs to, and
 * whether the caller is at this machine's keyboard. The second one may never
 * answer "loopback" on evidence a caller could have written.
 *
 * Every guard case is run in both deployments — no proxy, and a trusted proxy —
 * because the two disagree about what the socket peer is worth, and a bug that
 * only shows up in one of them has twice been shipped from a suite that only
 * covered the other.
 */

import { describe, expect, it } from 'bun:test';
import {
  extractClientIp,
  type GuardIpPolicy,
  resolveGuardClientIp,
  UNVERIFIED_CLIENT_IP,
} from '../../../src/lib/client-ip';

function headers(entries: Record<string, string> = {}): Headers {
  return new Headers(entries);
}

/** No proxy in front: the socket peer is the only thing worth reading. */
const DIRECT: GuardIpPolicy = { trustProxy: false, allowDirectLoopback: true };
/** A trusted proxy, shipping default: an unforwarded peer still counts. */
const PROXIED: GuardIpPolicy = { trustProxy: true, allowDirectLoopback: true };
/** A trusted proxy the operator has told us not to trust the peer behind. */
const PROXIED_STRICT: GuardIpPolicy = { trustProxy: true, allowDirectLoopback: false };

describe('extractClientIp', () => {
  it('keeps the socket peer when no proxy is trusted', () => {
    expect(extractClientIp(headers({ 'x-forwarded-for': '9.9.9.9' }), '127.0.0.1', false)).toBe(
      '127.0.0.1'
    );
  });

  it('keys the limiter on the origin client, the first forwarded hop', () => {
    expect(
      extractClientIp(headers({ 'x-forwarded-for': '203.0.113.5, 127.0.0.1' }), '127.0.0.1', true)
    ).toBe('203.0.113.5');
  });
});

describe('resolveGuardClientIp without a trusted proxy', () => {
  it('keeps the socket peer', () => {
    expect(
      resolveGuardClientIp(headers({ 'x-forwarded-for': '127.0.0.1' }), '203.0.113.5', DIRECT)
    ).toBe('203.0.113.5');
  });

  // The setting only ever decides what an *unforwarded* request is worth behind
  // a proxy. Reading it here would let a config change move a guard on a machine
  // that has no proxy at all.
  it('ignores allowDirectLoopback, which is not its question', () => {
    const strictDirect: GuardIpPolicy = { trustProxy: false, allowDirectLoopback: false };
    expect(resolveGuardClientIp(headers(), '127.0.0.1', strictDirect)).toBe('127.0.0.1');
    expect(resolveGuardClientIp(headers(), '127.0.0.1', DIRECT)).toBe('127.0.0.1');
  });

  it('answers unknown when there is no peer to read', () => {
    expect(resolveGuardClientIp(headers(), undefined, DIRECT)).toBe('unknown');
  });
});

describe('resolveGuardClientIp behind a trusted proxy', () => {
  it('reads the hop the proxy appended, not the one the caller claimed', () => {
    expect(
      resolveGuardClientIp(headers({ 'x-forwarded-for': '127.0.0.1, 203.0.113.5' }), '127.0.0.1', {
        ...PROXIED,
      })
    ).toBe('203.0.113.5');
  });

  // The appended hop is evidence either way, so the setting cannot reach it.
  it('reads the appended hop whatever allowDirectLoopback says', () => {
    const forwarded = headers({ 'x-forwarded-for': '127.0.0.1, 203.0.113.5' });
    expect(resolveGuardClientIp(forwarded, '127.0.0.1', PROXIED_STRICT)).toBe('203.0.113.5');
  });

  it('takes the loopback peer when the proxy appended nothing', () => {
    expect(resolveGuardClientIp(headers(), '127.0.0.1', PROXIED)).toBe('127.0.0.1');
  });

  it('takes the peer when the appended hop is blank', () => {
    expect(
      resolveGuardClientIp(headers({ 'x-forwarded-for': '127.0.0.1, ' }), '127.0.0.1', PROXIED)
    ).toBe('127.0.0.1');
  });

  // Falling back does not promote anyone: a peer that is not loopback still
  // fails the guard, it just fails it for the reason that names the address.
  it('does not turn a remote peer into a local caller', () => {
    expect(resolveGuardClientIp(headers(), '203.0.113.5', PROXIED)).toBe('203.0.113.5');
  });

  it('refuses the proxy’s own address when the fallback is off', () => {
    expect(resolveGuardClientIp(headers(), '127.0.0.1', PROXIED_STRICT)).toBe(UNVERIFIED_CLIENT_IP);
  });

  it('refuses a blank appended hop when the fallback is off', () => {
    expect(
      resolveGuardClientIp(headers({ 'x-forwarded-for': '127.0.0.1, ' }), '127.0.0.1', {
        ...PROXIED_STRICT,
      })
    ).toBe(UNVERIFIED_CLIENT_IP);
  });

  // `unknown` and `unverified` both refuse, but they refuse differently: one
  // says nothing answered, the other says the operator asked us not to accept
  // what did. Keeping them apart is what lets the page name the setting.
  it('separates an unestablished address from a missing one', () => {
    expect(resolveGuardClientIp(headers(), undefined, PROXIED)).toBe('unknown');
    expect(resolveGuardClientIp(headers(), undefined, PROXIED_STRICT)).toBe(UNVERIFIED_CLIENT_IP);
  });
});
