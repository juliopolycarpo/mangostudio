import { describe, expect, it } from 'bun:test';
import {
  type RemoteHandshakeTransport,
  resolveHandshakeTimeoutMs,
  resolveRemoteHandshakeTimeoutMs,
} from '../../../../src/services/runtime-client/handshake-budget';

const PLATFORMS: readonly NodeJS.Platform[] = ['linux', 'darwin', 'win32'];
const REMOTE_TRANSPORTS: readonly RemoteHandshakeTransport[] = ['ssh', 'container', 'http'];

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

describe('resolveRemoteHandshakeTimeoutMs', () => {
  // #1054: every remote transport spawns or dials from the hub first and then
  // does strictly more work than a local child, so it may never get less time.
  for (const platform of PLATFORMS) {
    for (const transport of REMOTE_TRANSPORTS) {
      it(`gives ${transport} on ${platform} at least the local budget`, () => {
        const local = resolveHandshakeTimeoutMs(platform);
        const remote = resolveRemoteHandshakeTimeoutMs(transport, platform);
        expect(
          remote >= local,
          `expected ${transport} budget on ${platform} >= local ${local}ms | received: ${remote}ms`
        ).toBe(true);
      });
    }
  }

  it('leaves the flat remote numbers alone where the local budget is lower', () => {
    expect({
      ssh: resolveRemoteHandshakeTimeoutMs('ssh', 'linux'),
      container: resolveRemoteHandshakeTimeoutMs('container', 'darwin'),
      http: resolveRemoteHandshakeTimeoutMs('http', 'linux'),
    }).toEqual({ ssh: 20_000, container: 20_000, http: 15_000 });
  });

  it('lifts every remote budget to the Windows local floor', () => {
    expect(
      REMOTE_TRANSPORTS.map((transport) => resolveRemoteHandshakeTimeoutMs(transport, 'win32'))
    ).toEqual([30_000, 30_000, 30_000]);
  });
});
