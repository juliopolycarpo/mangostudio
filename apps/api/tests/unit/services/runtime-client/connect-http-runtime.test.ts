import { describe, expect, it } from 'bun:test';

import type { Port } from '@mangostudio/protocol';
import { rejectionOf } from '@mangostudio/protocol/testing';

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

/** A dial that opens at once and records the options the hub gave it. */
class RecordingDial {
  options: Parameters<RuntimeSessionOpeners['dial']>[1];

  readonly dial: RuntimeSessionOpeners['dial'] = (_url, options) => {
    this.options = options;
    return Promise.resolve({} as Port);
  };
}

/** A dial the SDK would abandon on its deadline: it rejects with a `TimeoutError`. */
class ExpiredDeadlineDial {
  readonly error: Error;

  constructor(error?: Error) {
    this.error =
      error ??
      Object.assign(new Error('The connection to ws://runtime.test/ timed out after 15000 ms.'), {
        name: 'TimeoutError',
      });
  }

  readonly dial: RuntimeSessionOpeners['dial'] = () => Promise.reject(this.error);
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

  it('hands the dial the budget and the caller signal, and arms no timer of its own', async () => {
    const clock = new FakeClock();
    const handshake = new RecordingHandshake();
    const dial = new RecordingDial();
    const cancel = new AbortController();
    const armed: unknown[] = [];
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
      armed.push(args[1]);
      return realSetTimeout(...args);
    }) as typeof setTimeout;
    try {
      await openRuntimeSession(
        'ws://runtime.test/',
        'token',
        { userId: 'u1', environmentId: 'lan-box' },
        cancel.signal,
        { dial: dial.dial, handshake: handshake.handshake, now: clock.now }
      );
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }

    expect({
      timeoutMs: dial.options?.timeoutMs,
      signalIsCallers: dial.options?.signal === cancel.signal,
      timersArmedByHub: armed,
    }).toEqual({
      timeoutMs: resolveRemoteHandshakeTimeoutMs('http'),
      signalIsCallers: true,
      timersArmedByHub: [],
    });
  });

  it('omits the signal when the caller has none', async () => {
    const dial = new RecordingDial();

    await openRuntimeSession(
      'ws://runtime.test/',
      'token',
      { userId: 'u1', environmentId: 'lan-box' },
      undefined,
      { dial: dial.dial, handshake: new RecordingHandshake().handshake, now: new FakeClock().now }
    );

    expect(dial.options).not.toHaveProperty('signal');
  });

  it('reports a dial that ran out of its deadline with the sentence the card shows', async () => {
    const budgetMs = resolveRemoteHandshakeTimeoutMs('http');
    const dial = new ExpiredDeadlineDial();

    const error = await rejectionOf(
      openRuntimeSession(
        'ws://runtime.test/',
        'token',
        { userId: 'u1', environmentId: 'lan-box' },
        new AbortController().signal,
        { dial: dial.dial, handshake: new RecordingHandshake().handshake, now: new FakeClock().now }
      )
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      `The runtime did not accept a WebSocket at ws://runtime.test/ within ${budgetMs}ms.`
    );
    expect((error as Error).cause).toBe(dial.error);
  });

  it('leaves a dial the caller cancelled with the reason the caller gave', async () => {
    const cancel = new AbortController();
    const reason = Object.assign(new Error('released by the manager'), { name: 'TimeoutError' });
    cancel.abort(reason);
    const dial = new ExpiredDeadlineDial(reason);

    const error = await rejectionOf(
      openRuntimeSession(
        'ws://runtime.test/',
        'token',
        { userId: 'u1', environmentId: 'lan-box' },
        cancel.signal,
        { dial: dial.dial, handshake: new RecordingHandshake().handshake, now: new FakeClock().now }
      )
    );

    expect(error).toBe(reason);
  });

  it('passes a refused dial through unchanged for the manager to wrap', async () => {
    const refused = new Error('connect ECONNREFUSED 127.0.0.1:9');
    const dial: RuntimeSessionOpeners['dial'] = () => Promise.reject(refused);

    const error = await rejectionOf(
      openRuntimeSession(
        'ws://runtime.test/',
        'token',
        { userId: 'u1', environmentId: 'lan-box' },
        undefined,
        { dial, handshake: new RecordingHandshake().handshake, now: new FakeClock().now }
      )
    );

    expect(error).toBe(refused);
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
