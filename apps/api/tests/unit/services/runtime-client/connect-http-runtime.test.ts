import { describe, expect, it } from 'bun:test';
import type { Port } from '@mangostudio/protocol';
import {
  openRuntimeSession,
  type RuntimeSessionOpeners,
} from '../../../../src/services/runtime-client/connect-http-runtime';
import { resolveRemoteHandshakeTimeoutMs } from '../../../../src/services/runtime-client/handshake-budget';
import type {
  OpenHubSessionOptions,
  ProtocolHubSession,
} from '../../../../src/services/runtime-client/hub-session';

const DIAL_MS = 4_000;

/** A monotonic clock the fake dial advances by hand. */
class FakeClock {
  nowMs = 1_000;
  readonly now = (): number => this.nowMs;
}

/** A dial that opens after `DIAL_MS` on the fake clock. */
class SlowFakeDial {
  constructor(private readonly clock: FakeClock) {}

  readonly dial: RuntimeSessionOpeners['dial'] = () => {
    this.clock.nowMs += DIAL_MS;
    return Promise.resolve({} as Port);
  };
}

/** A handshake that records the options it was opened with. */
class RecordingHandshake {
  options: OpenHubSessionOptions | undefined;
  readonly session = {} as ProtocolHubSession;

  readonly handshake: RuntimeSessionOpeners['handshake'] = (_port, options) => {
    this.options = options;
    return Promise.resolve(this.session);
  };
}

describe('openRuntimeSession', () => {
  it('gives the hello only the budget the dial left', async () => {
    const clock = new FakeClock();
    const dial = new SlowFakeDial(clock);
    const handshake = new RecordingHandshake();
    const cancel = new AbortController();

    const session = await openRuntimeSession(
      'ws://runtime.test/',
      'token',
      { userId: 'u1', environmentId: 'lan-box' },
      cancel.signal,
      { dial: dial.dial, handshake: handshake.handshake, now: clock.now }
    );

    const budgetMs = resolveRemoteHandshakeTimeoutMs('http');
    const expected = { handshakeTimeoutMs: budgetMs - DIAL_MS, signal: cancel.signal };
    expect({
      handshakeTimeoutMs: handshake.options?.handshakeTimeoutMs,
      signal: handshake.options?.signal,
    }).toEqual(expected);
    expect(session).toBe(handshake.session);
  });

  it('still arms a hello timer when the dial used the whole budget', async () => {
    const clock = new FakeClock();
    const handshake = new RecordingHandshake();
    const budgetMs = resolveRemoteHandshakeTimeoutMs('http');
    const dial: RuntimeSessionOpeners['dial'] = () => {
      clock.nowMs += budgetMs + 50;
      return Promise.resolve({} as Port);
    };

    await openRuntimeSession(
      'ws://runtime.test/',
      'token',
      { userId: 'u1', environmentId: 'lan-box' },
      undefined,
      { dial, handshake: handshake.handshake, now: clock.now }
    );

    expect(handshake.options?.handshakeTimeoutMs).toBe(1);
  });
});
