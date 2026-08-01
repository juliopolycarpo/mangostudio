import { describe, expect, it } from 'bun:test';
import {
  generatePairingToken,
  hashPairingSecret,
  parsePairingToken,
  RUNTIME_PAIRING_TOKEN_PREFIX,
  runtimeDialEndpoint,
} from '../../../../src/modules/environments/domain/pairing-token';

describe('pairing token format', () => {
  it('round-trips a generated token through the parser', () => {
    const generated = generatePairingToken();
    const parsed = parsePairingToken(generated.token);

    expect(parsed).not.toBeNull();
    expect(parsed?.id).toBe(generated.id);
    expect(hashPairingSecret(parsed?.secret ?? '')).toBe(generated.tokenHash);
  });

  it('never stores the secret half in the clear', () => {
    const generated = generatePairingToken();
    const secret = generated.token.slice(
      RUNTIME_PAIRING_TOKEN_PREFIX.length + generated.id.length + 1
    );

    expect(generated.tokenHash).not.toContain(secret);
    expect(generated.tokenHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('issues a distinct selector and secret every time', () => {
    const first = generatePairingToken();
    const second = generatePairingToken();

    expect(first.id).not.toBe(second.id);
    expect(first.tokenHash).not.toBe(second.tokenHash);
  });

  it.each([
    ['an empty string', ''],
    ['a token without the prefix', 'abc.def'],
    ['a token without a separator', 'mrt_abcdef'],
    ['a token with an empty selector', 'mrt_.secret'],
    ['a token with an empty secret', 'mrt_selector.'],
    ['a token with a second separator', 'mrt_selector.sec.ret'],
  ])('refuses %s', (_label, raw) => {
    expect(parsePairingToken(raw)).toBeNull();
  });

  it('tolerates the surrounding whitespace a paste carries', () => {
    const generated = generatePairingToken();

    expect(parsePairingToken(`  ${generated.token}\n`)?.id).toBe(generated.id);
  });
});

describe('runtime dial endpoint', () => {
  it.each([
    ['https://hub.example.com', 'wss://hub.example.com/api/runtime'],
    ['http://192.168.1.10:3001', 'ws://192.168.1.10:3001/api/runtime'],
    ['https://example.com/mango/', 'wss://example.com/mango/api/runtime'],
    ['https://example.com/?ignored=1#frag', 'wss://example.com/api/runtime'],
  ])('derives %s into %s', (publicUrl, expected) => {
    expect(runtimeDialEndpoint(publicUrl)).toBe(expected);
  });

  it.each([
    ['an unset public URL', ''],
    ['whitespace', '   '],
    ['a bare host', 'hub.example.com'],
    ['a non-http scheme', 'ftp://hub.example.com'],
  ])('reports %s as unknown rather than guessing', (_label, publicUrl) => {
    expect(runtimeDialEndpoint(publicUrl)).toBeNull();
  });
});
