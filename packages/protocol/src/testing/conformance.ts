import { expect, it } from 'bun:test';
import { CLOSE_CODES } from '../close';
import { DEFAULT_MAX_FRAME_BYTES } from '../codec/ndjson';
import { RESERVED_ERROR_CODES, RemoteError } from '../errors';
import type { EventFrame } from '../schemas/frames';
import type { RequestHandler, Session, SessionOptions } from '../session';
import { rejectionOf } from './rejection';

/** Two sessions wired through the transport under test. */
export interface ConformancePair {
  readonly a: Session;
  readonly b: Session;
  /** Severs the connection the way a crash or a cut network would. */
  drop(): void | Promise<void>;
  close(): void | Promise<void>;
  /**
   * Writes raw bytes on side `a`'s transport as if the far peer sent them,
   * for byte-oriented transports. Enables the schema-invalid hello case.
   */
  injectRaw?(line: string): void | Promise<void>;
}

export interface ConformanceFixture {
  /** Connects two sessions; the suite supplies handlers and peer identities. */
  connect(aOptions: SessionOptions, bOptions: SessionOptions): Promise<ConformancePair>;
  /** True when frames are split across messages, so interleaving is observable. */
  readonly chunked?: boolean;
  /**
   * Connects only side `a` to a transport whose far end is raw bytes, so a
   * hello nobody can read reaches the port. Optional.
   */
  connectRaw?(
    aOptions: SessionOptions
  ): Promise<{ readonly a: Session; write(line: string): void; close(): void | Promise<void> }>;
}

export const CONFORMANCE_A: SessionOptions['peer'] = {
  name: 'conformance-a',
  version: 'a.0',
  role: 'hub',
};
export const CONFORMANCE_B: SessionOptions['peer'] = {
  name: 'conformance-b',
  version: 'b.0',
  role: 'runtime',
};

/** Echoes its params back so a test can prove what crossed the wire. */
export const echo: RequestHandler = (params) => params;

/** Produces a result of a requested byte size, to exercise limits and chunking. */
export const bulk: RequestHandler = (params) => {
  const { bytes } = params as { bytes: number };
  return { blob: 'x'.repeat(bytes) };
};

/** Never settles until it is cancelled, so `cancel` has something to abort. */
export const forever: RequestHandler = (_params, context) =>
  new Promise((_resolve, reject) => {
    context.signal.addEventListener(
      'abort',
      () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
      { once: true }
    );
  });

/** Fails with a chosen wire code. */
export const refuse: RequestHandler = (params) => {
  const { code, message } = params as { code: string; message: string };
  throw new RemoteError(code, message, { echoed: true });
};

export const CONFORMANCE_HANDLERS: Readonly<Record<string, RequestHandler>> = {
  'test.echo': echo,
  'test.bulk': bulk,
  'test.forever': forever,
  'test.refuse': refuse,
};

const BULK_TIMEOUT_MS = 30_000;

function options(
  peer: SessionOptions['peer'],
  extra: Partial<SessionOptions> = {}
): SessionOptions {
  return { peer, handlers: CONFORMANCE_HANDLERS, livenessIntervalMs: false, ...extra };
}

/**
 * Registers the cases every transport has to pass. Call it inside a
 * `describe` naming the transport so a failure says which one broke.
 *
 * @example
 * describe('in-process', () => {
 *   itBehavesLikeAMangoTransport({ connect: async (a, b) => connectInProcess(a, b) });
 * });
 */
export function itBehavesLikeAMangoTransport(fixture: ConformanceFixture): void {
  async function withPair(
    run: (pair: ConformancePair) => Promise<void>,
    aExtra: Partial<SessionOptions> = {},
    bExtra: Partial<SessionOptions> = {}
  ): Promise<void> {
    const pair = await fixture.connect(
      options(CONFORMANCE_A, aExtra),
      options(CONFORMANCE_B, bExtra)
    );
    try {
      await run(pair);
    } finally {
      await pair.close();
    }
  }

  it('completes the handshake in both directions and exposes the peers', async () => {
    await withPair(async ({ a, b }) => {
      const [fromA, fromB] = await Promise.all([a.ready, b.ready]);
      expect(fromA.peer).toEqual(CONFORMANCE_B);
      expect(fromB.peer).toEqual(CONFORMANCE_A);
      expect(fromA.effectiveMinor).toBe(fromB.effectiveMinor);
      expect(a.state).toBe('ready');
      expect(b.state).toBe('ready');
    });
  });

  it('negotiates the effective minor downward', async () => {
    await withPair(
      async ({ a, b }) => {
        const [fromA, fromB] = await Promise.all([a.ready, b.ready]);
        expect(fromA.effectiveMinor).toBe(1);
        expect(fromB.effectiveMinor).toBe(1);
        expect(fromA.protocol).toEqual({ major: 1, minor: 1 });
        expect(fromB.protocol).toEqual({ major: 1, minor: 3 });
      },
      { protocol: { major: 1, minor: 3 } },
      { protocol: { major: 1, minor: 1 } }
    );
  });

  it('refuses a different major with 4426 on both sides', async () => {
    const pair = await fixture.connect(
      options(CONFORMANCE_A, { protocol: { major: 2, minor: 0 } }),
      options(CONFORMANCE_B)
    );
    try {
      expect(await rejectionOf(pair.a.ready)).toMatchObject({
        code: RESERVED_ERROR_CODES.PROTOCOL_MISMATCH,
      });
      expect(await rejectionOf(pair.b.ready)).toMatchObject({
        code: RESERVED_ERROR_CODES.PROTOCOL_MISMATCH,
      });
      await settled();
      expect(pair.a.closure?.code).toBe(CLOSE_CODES.PROTOCOL_MISMATCH);
      expect(pair.b.closure?.code).toBe(CLOSE_CODES.PROTOCOL_MISMATCH);
      expect(pair.a.closure?.fatal).toBe(true);
    } finally {
      await pair.close();
    }
  });

  it('round-trips a request and its result in both directions', async () => {
    await withPair(async ({ a, b }) => {
      const params = { nested: { list: [1, 2, 3], text: 'héllo · ünicode · 🥭' } };
      expect(await a.request('test.echo', params)).toEqual(params);
      expect(await b.request('test.echo', { from: 'b' })).toEqual({ from: 'b' });
    });
  });

  it('serves concurrent requests in both directions', async () => {
    await withPair(async ({ a, b }) => {
      const results = await Promise.all([
        a.request('test.echo', 1),
        b.request('test.echo', 2),
        a.request('test.echo', 3),
        b.request('test.echo', 4),
      ]);
      expect(results).toEqual([1, 2, 3, 4]);
    });
  });

  it('reports an unsupported method without ending the session', async () => {
    await withPair(async ({ a }) => {
      expect(await rejectionOf(a.request('test.absent', {}))).toMatchObject({
        code: RESERVED_ERROR_CODES.METHOD_UNSUPPORTED,
      });
      expect(await a.request('test.echo', { ok: true })).toEqual({ ok: true });
    });
  });

  it('carries a handler-chosen error code and its details', async () => {
    await withPair(async ({ a }) => {
      expect(
        await rejectionOf(a.request('test.refuse', { code: 'APP_REFUSED', message: 'no' }))
      ).toMatchObject({
        code: 'APP_REFUSED',
        message: 'no',
        details: { echoed: true },
      });
    });
  });

  it('refuses a request past the in-flight ceiling and stays open', async () => {
    await withPair(
      async ({ a }) => {
        const controller = new AbortController();
        const held = a.request('test.forever', {}, { signal: controller.signal });
        await settled();

        const refused = await rejectionOf(a.request('test.echo', { queued: true }));
        expect(refused).toMatchObject({
          code: RESERVED_ERROR_CODES.UNAVAILABLE,
          details: { kind: 'in_flight_limit', limit: 1 },
        });

        // Retryable, not fatal: the slot frees when the held request settles
        // and the very same call goes through.
        controller.abort();
        await rejectionOf(held);
        await settled();
        expect(await a.request('test.echo', { queued: true })).toEqual({ queued: true });
      },
      {},
      { maxInFlight: 1 }
    );
  });

  it('refuses a reserved rpc. method before it reaches the wire', async () => {
    await withPair(async ({ a }) => {
      // Undefined at every minor, so it never reaches the peer at all.
      expect(await rejectionOf(a.request('rpc.nowhere', {}))).toMatchObject({
        code: RESERVED_ERROR_CODES.INVALID_REQUEST,
      });
    });
  });

  it('refuses rpc.discover below the minor that defines it', async () => {
    await withPair(
      async ({ a }) => {
        const remote = await a.ready;
        expect(remote.effectiveMinor).toBe(0);
        // A 1.0 peer cannot have meant this method, so the requester never
        // sends it: the refusal is local and names the minor it needed.
        expect(await rejectionOf(a.request('rpc.discover', {}))).toMatchObject({
          code: RESERVED_ERROR_CODES.INVALID_REQUEST,
          details: { effectiveMinor: 0 },
        });
        expect(await a.request('test.echo', { alive: true })).toEqual({ alive: true });
      },
      {},
      { protocol: { major: 1, minor: 0 } }
    );
  });

  it('delivers an event stream and its end marker in order', async () => {
    await withPair(async ({ a, b }) => {
      const received: { seq: number; payload: unknown; end?: true }[] = [];
      const detach = a.onEvent((event: EventFrame) => {
        if (event.streamId !== 'stream-1') return;
        received.push({
          seq: event.seq,
          payload: event.payload,
          ...(event.end ? { end: true as const } : {}),
        });
      });
      b.emit({ topic: 'test.stream', streamId: 'stream-1', payload: { line: 'first' } });
      b.emit({ topic: 'test.stream', streamId: 'stream-1', payload: { line: 'second' } });
      b.emit({ topic: 'test.stream', streamId: 'stream-1', payload: { line: 'last' }, end: true });
      // One round trip after the last emit guarantees every event landed.
      await a.request('test.echo', {});
      detach();
      expect(received).toEqual([
        { seq: 0, payload: { line: 'first' } },
        { seq: 1, payload: { line: 'second' } },
        { seq: 2, payload: { line: 'last' }, end: true },
      ]);
      // The stream key was released: the next event on it starts at zero.
      const restart: number[] = [];
      const detachRestart = a.onEvent((event) => {
        if (event.streamId === 'stream-1') restart.push(event.seq);
      });
      b.emit({ topic: 'test.stream', streamId: 'stream-1', payload: null });
      await a.request('test.echo', {});
      detachRestart();
      expect(restart).toEqual([0]);
    });
  });

  it('numbers events per topic when no stream id is given', async () => {
    await withPair(async ({ a, b }) => {
      const sequences: number[] = [];
      const detach = b.onEvent((event) => {
        if (event.topic === 'test.heartbeat') sequences.push(event.seq);
      });
      a.emit({ topic: 'test.heartbeat', payload: { at: 1 } });
      a.emit({ topic: 'test.heartbeat', payload: { at: 2 } });
      await b.request('test.echo', {});
      detach();
      expect(sequences).toEqual([0, 1]);
    });
  });

  it('delivers the events a handler emits before its response', async () => {
    // Past what a receiver handles in one wake: a burst that small lands with
    // the answer in one batch and hides a reorder, since the receiver delivers
    // the whole batch before the requester runs.
    const emitted = 256;
    const announce: RequestHandler = (_params, context) => {
      for (let line = 0; line < emitted; line += 1) {
        context.session.emit({ topic: 'test.announce', payload: { line } });
      }
      return { emitted };
    };
    await withPair(
      async ({ a }) => {
        const received: number[] = [];
        const detach = a.onEvent((event) => {
          if (event.topic === 'test.announce') received.push(event.seq);
        });
        // No round trip after the answer: §6.2 puts every event the handler
        // emitted before it returned ahead of the answer, so they are all in
        // by the time the request settles.
        expect(await a.request('test.announce', {})).toEqual({ emitted });
        detach();
        expect(received).toEqual(Array.from({ length: emitted }, (_, seq) => seq));
      },
      {},
      { handlers: { ...CONFORMANCE_HANDLERS, 'test.announce': announce } }
    );
  });

  it('refuses one stream key past the local ceiling', async () => {
    await withPair(
      async ({ a, b }) => {
        // emit() is a no-op before the handshake completes, so a `true` here
        // would otherwise be proving nothing about the ceiling.
        await Promise.all([a.ready, b.ready]);
        expect(a.emit({ topic: 'test.stream', streamId: 's-1', payload: null })).toBe(true);
        expect(a.emit({ topic: 'test.stream', streamId: 's-2', payload: null })).toBe(true);
        // Local, so nothing reaches the peer: a sender at this ceiling has
        // leaked stream ids, which is a defect in the sender.
        expect(() => a.emit({ topic: 'test.stream', streamId: 's-3', payload: null })).toThrow(
          RemoteError
        );

        a.emit({ topic: 'test.stream', streamId: 's-1', payload: null, end: true });
        expect(a.emit({ topic: 'test.stream', streamId: 's-3', payload: null })).toBe(true);
      },
      { maxStreamKeys: 2 }
    );
  });

  it('answers a protocol ping with a pong in both directions', async () => {
    await withPair(async ({ a, b }) => {
      const aPong = new Promise<void>((resolve) => {
        const detach = a.onPong(() => {
          detach();
          resolve();
        });
      });
      const bPong = new Promise<void>((resolve) => {
        const detach = b.onPong(() => {
          detach();
          resolve();
        });
      });
      a.ping();
      b.ping();
      await Promise.all([aPong, bPong]);
    });
  });

  it('cancels an in-flight request and reports it as cancelled', async () => {
    await withPair(async ({ a }) => {
      const controller = new AbortController();
      const pending = a.request('test.forever', {}, { signal: controller.signal });
      await settled();
      controller.abort();
      expect(await rejectionOf(pending)).toMatchObject({ code: RESERVED_ERROR_CODES.CANCELLED });
    });
  });

  it('times out a request locally and ignores the late answer', async () => {
    await withPair(async ({ a }) => {
      expect(await rejectionOf(a.request('test.forever', {}, { timeoutMs: 50 }))).toMatchObject({
        code: RESERVED_ERROR_CODES.TIMEOUT,
      });
      expect(await a.request('test.echo', { still: 'alive' })).toEqual({ still: 'alive' });
    });
  });

  it('fails in-flight requests with UNAVAILABLE when the connection drops', async () => {
    await withPair(async (pair) => {
      const pending = pair.a.request('test.forever', {});
      await settled();
      await pair.drop();
      expect(await rejectionOf(pending)).toMatchObject({ code: RESERVED_ERROR_CODES.UNAVAILABLE });
      await settled();
      expect(pair.a.state).toBe('closed');
    });
  });

  it('propagates a close reason code to the peer', async () => {
    await withPair(async ({ a, b }) => {
      await Promise.all([a.ready, b.ready]);
      const closed = new Promise((resolve) => a.onClose(resolve));
      b.close(CLOSE_CODES.SUPERSEDED, 'superseded by a newer connection');
      expect(await closed).toMatchObject({ code: CLOSE_CODES.SUPERSEDED, fatal: true });
      expect(b.closure).toMatchObject({ code: CLOSE_CODES.SUPERSEDED });
    });
  });

  it('refuses a result past the frame limit without ending the session', async () => {
    await withPair(async ({ a }) => {
      expect(
        await rejectionOf(
          a.request(
            'test.bulk',
            { bytes: DEFAULT_MAX_FRAME_BYTES + 1 },
            { timeoutMs: BULK_TIMEOUT_MS }
          )
        )
      ).toMatchObject({ code: RESERVED_ERROR_CODES.FRAME_TOO_LARGE });
      expect(await a.request('test.echo', { ok: true })).toEqual({ ok: true });
    });
  });

  it('honours the lower announced frame limit when sending', async () => {
    await withPair(
      async ({ a }) => {
        expect(await rejectionOf(a.request('test.bulk', { bytes: 8192 }))).toMatchObject({
          code: RESERVED_ERROR_CODES.FRAME_TOO_LARGE,
        });
        expect(await a.request('test.bulk', { bytes: 1024 })).toMatchObject({
          blob: 'x'.repeat(1024),
        });
      },
      { maxFrameBytes: 4096 }
    );
  });

  if (fixture.chunked) {
    it('keeps two concurrent oversized results from interleaving', async () => {
      await withPair(async ({ a }) => {
        const size = 512 * 1024;
        const [first, second] = await Promise.all([
          a.request('test.bulk', { bytes: size }, { timeoutMs: BULK_TIMEOUT_MS }),
          a.request('test.bulk', { bytes: size + 1 }, { timeoutMs: BULK_TIMEOUT_MS }),
        ]);
        expect((first as { blob: string }).blob).toHaveLength(size);
        expect((second as { blob: string }).blob).toHaveLength(size + 1);
      });
    });
  }

  if (fixture.connectRaw) {
    const connectRaw = fixture.connectRaw.bind(fixture);
    it('closes with 4426 when the peer sends a hello it cannot read', async () => {
      const raw = await connectRaw(options(CONFORMANCE_A));
      try {
        raw.write(
          '{"type":"hello","protocolVersion":"1.0.1","runtimeVersion":"0.1.1","manifest":{}}\n'
        );
        expect(await rejectionOf(raw.a.ready)).toMatchObject({
          code: RESERVED_ERROR_CODES.PROTOCOL_MISMATCH,
        });
        await settled();
        expect(raw.a.closure?.code).toBe(CLOSE_CODES.PROTOCOL_MISMATCH);
        expect(raw.a.closure?.fatal).toBe(true);
      } finally {
        await raw.close();
      }
    });

    it('ignores unknown envelope members', async () => {
      const raw = await connectRaw(options(CONFORMANCE_A));
      try {
        raw.write(
          '{"type":"hello","protocol":{"major":1,"minor":0},"peer":{"name":"raw","version":"0","role":"tool"},"capabilities":{},"x-vendor":{"trace":1},"future":true}\n'
        );
        const remote = await raw.a.ready;
        expect(remote.peer.name).toBe('raw');
        const pong = new Promise<void>((resolve) => raw.a.onPong(() => resolve()));
        raw.write('{"type":"pong","x-at":1}\n');
        await pong;
      } finally {
        await raw.close();
      }
    });
  }
}

/** Lets queued microtasks and a macrotask run so cross-port deliveries land. */
function settled(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 5));
}
