import { describe, expect, it } from 'bun:test';
import { resolveHandshakeTimeoutMs } from '../../../../src/services/runtime-client/handshake-budget';

describe('resolveHandshakeTimeoutMs', () => {
  it('gives a Windows hub the cold-start budget', () => {
    expect(resolveHandshakeTimeoutMs('win32')).toBe(30_000);
  });

  it('keeps the shared default on linux', () => {
    expect(resolveHandshakeTimeoutMs('linux')).toBe(5_000);
  });

  it('keeps the shared default on darwin', () => {
    expect(resolveHandshakeTimeoutMs('darwin')).toBe(5_000);
  });
});
