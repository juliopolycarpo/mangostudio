import { describe, expect, it } from 'bun:test';
import { CLOSE_CODES } from '../src/close';
import { CodecError, RESERVED_ERROR_CODES, RemoteError } from '../src/errors';
import type { Port, PortClosure } from '../src/port';
import type { Frame, HelloFrame } from '../src/schemas/frames';
import { Session, type SessionOptions } from '../src/session';
import { createInProcessPortPair } from '../src/transports/in-process';
import { PROTOCOL_MINOR } from '../src/version';

const HUB: SessionOptions['peer'] = { name: 'hub', version: '1.0.0', role: 'hub' };
const RUNTIME: SessionOptions['peer'] = { name: 'runtime', version: '1.0.0', role: 'runtime' };

const rawHello = (): HelloFrame => ({
  type: 'hello',
  protocol: { major: 1, minor: 0 },
  peer: RUNTIME,
  capabilities: {},
});

/** The fake keeps its listeners for the test's lifetime; nothing to detach. */
function detachNothing(): void {
  // Intentionally empty.
}

/** A port whose closure a test dictates, for paths no in-process pair can reach. */
class FakePort implements Port {
  readonly sent: Frame[] = [];
  #closed?: (closure: PortClosure) => void;

  send(frame: Frame): void {
    this.sent.push(frame);
  }

  onFrame(): () => void {
    return detachNothing;
  }

  onClosed(listener: (closure: PortClosure) => void): () => void {
    this.#closed = listener;
    return detachNothing;
  }

  close(): void {
    // Owner-initiated close is not what these tests observe.
  }

  report(closure: PortClosure): void {
    this.#closed?.(closure);
  }
}

/** Wraps a real port and throws instead of sending when `shouldFail` matches. */
class FailingSendPort implements Port {
  readonly #inner: Port;
  readonly #shouldFail: (frame: Frame) => boolean;

  constructor(inner: Port, shouldFail: (frame: Frame) => boolean) {
    this.#inner = inner;
    this.#shouldFail = shouldFail;
  }

  send(frame: Frame): void {
    if (this.#shouldFail(frame)) throw new Error('the transport refused this frame');
    this.#inner.send(frame);
  }

  onFrame(listener: (frame: Frame) => void): () => void {
    return this.#inner.onFrame(listener);
  }

  onClosed(listener: (closure: PortClosure) => void): () => void {
    return this.#inner.onClosed(listener);
  }

  close(code: number, reason?: string): void {
    this.#inner.close(code, reason);
  }
}

/** Collects every frame a raw port receives so a test can inspect the wire. */
class FrameRecorder {
  readonly frames: Frame[] = [];
  readonly #waiters: ((frame: Frame) => void)[] = [];

  constructor(port: Port) {
    port.onFrame((frame) => {
      this.frames.push(frame);
      for (const waiter of this.#waiters.splice(0)) waiter(frame);
    });
  }

  next(): Promise<Frame> {
    return new Promise((resolve) => this.#waiters.push(resolve));
  }

  async until(predicate: (frame: Frame) => boolean): Promise<Frame> {
    const found = this.frames.find(predicate);
    if (found) return found;
    for (;;) {
      const frame = await this.next();
      if (predicate(frame)) return frame;
    }
  }
}

function pair(options: Partial<SessionOptions> = {}) {
  const ports = createInProcessPortPair();
  const hub = new Session(ports.a, { peer: HUB, livenessIntervalMs: false, ...options });
  const runtime = new Session(ports.b, {
    peer: RUNTIME,
    livenessIntervalMs: false,
    handlers: { 'test.echo': (params) => params },
  });
  return { ports, hub, runtime };
}

function tick(ms = 5): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('Session handshake', () => {
  it('resolves ready on both sides with the peer announcement', async () => {
    const { hub, runtime } = pair({ capabilities: { audit: true } });
    const [fromHub, fromRuntime] = await Promise.all([hub.ready, runtime.ready]);
    expect(fromHub.peer).toEqual(RUNTIME);
    expect(fromRuntime.peer).toEqual(HUB);
    expect(fromRuntime.capabilities).toEqual({ audit: true });
    expect(hub.remote.effectiveMinor).toBe(PROTOCOL_MINOR);
    hub.close();
  });

  it('throws from remote before the handshake completes', () => {
    const ports = createInProcessPortPair();
    const session = new Session(ports.a, { peer: HUB, livenessIntervalMs: false });
    expect(() => session.remote).toThrow(RemoteError);
    session.close();
  });

  it('times out when the peer never says hello', async () => {
    const ports = createInProcessPortPair();
    const session = new Session(ports.a, {
      peer: HUB,
      handshakeTimeoutMs: 20,
      livenessIntervalMs: false,
    });
    await expect(session.ready).rejects.toMatchObject({ code: RESERVED_ERROR_CODES.UNAVAILABLE });
    expect(session.closure).toMatchObject({
      code: CLOSE_CODES.PROTOCOL_ERROR,
      reason: 'handshake timeout',
    });
  });

  it('never reuses a request id within a session', async () => {
    const ports = createInProcessPortPair();
    const recorder = new FrameRecorder(ports.b);
    const hub = new Session(ports.a, { peer: HUB, livenessIntervalMs: false });
    const runtime = new Session(ports.b, {
      peer: RUNTIME,
      livenessIntervalMs: false,
      handlers: { 'test.echo': (params) => params },
    });
    await Promise.all([hub.ready, runtime.ready]);

    // §6.1 binds the requester, not the responder: each request settles before
    // the next goes out, so nothing but a fresh id can keep them distinct.
    for (let index = 0; index < 4; index += 1) await hub.request('test.echo', index);

    const ids = recorder.frames.filter((frame) => frame.type === 'req').map((frame) => frame.id);
    expect(ids).toHaveLength(4);
    expect(new Set(ids).size).toBe(ids.length);
    hub.close();
  });

  it('answers a request that arrives before the handshake with UNAVAILABLE', async () => {
    const ports = createInProcessPortPair();
    const recorder = new FrameRecorder(ports.b);
    const session = new Session(ports.a, { peer: HUB, livenessIntervalMs: false });
    ports.b.send({ type: 'req', id: 'early', method: 'test.echo', params: {} });
    const answer = await recorder.until((frame) => frame.type === 'err');
    expect(answer).toMatchObject({
      type: 'err',
      id: 'early',
      error: { code: RESERVED_ERROR_CODES.UNAVAILABLE },
    });
    session.close();
  });

  it('closes with 4400 on a duplicate hello', async () => {
    const ports = createInProcessPortPair();
    const session = new Session(ports.a, { peer: HUB, livenessIntervalMs: false });
    ports.b.send(rawHello());
    await session.ready;
    ports.b.send(rawHello());
    await tick();
    expect(session.closure).toMatchObject({
      code: CLOSE_CODES.PROTOCOL_ERROR,
      reason: 'duplicate hello',
    });
  });

  it('announces its frame ceiling and honours the lower one', async () => {
    const ports = createInProcessPortPair();
    const recorder = new FrameRecorder(ports.b);
    const session = new Session(ports.a, {
      peer: HUB,
      maxFrameBytes: 8192,
      livenessIntervalMs: false,
    });
    const hello = await recorder.until((frame) => frame.type === 'hello');
    expect(hello).toMatchObject({ type: 'hello', limits: { maxFrameBytes: 8192 } });
    ports.b.send({ ...rawHello(), limits: { maxFrameBytes: 4096 } });
    await session.ready;
    expect(session.sendLimitBytes).toBe(4096);
    session.close();
  });

  it('announces the lower of its own ceiling and the one the port decodes', async () => {
    // A port that only decodes 4096 cannot be talked into accepting 8192 by a
    // session option: announcing the higher number invites the peer to send a
    // frame the port will refuse, and the refusal ends the session.
    const ports = createInProcessPortPair({ maxFrameBytes: 4096 });
    const recorder = new FrameRecorder(ports.b);
    const session = new Session(ports.a, {
      peer: HUB,
      maxFrameBytes: 8192,
      livenessIntervalMs: false,
    });
    const hello = await recorder.until((frame) => frame.type === 'hello');
    expect(hello).toMatchObject({ type: 'hello', limits: { maxFrameBytes: 4096 } });
    ports.b.send(rawHello());
    await session.ready;
    expect(session.sendLimitBytes).toBe(4096);
    session.close();
  });

  it('refuses a frame ceiling below the floor of the wire', () => {
    // 512 would build a `hello` whose `limits.maxFrameBytes` the schema
    // refuses, killing the session at the handshake rather than at the call
    // that set it. It is refused where it was written instead.
    const ports = createInProcessPortPair();
    expect(() => new Session(ports.a, { peer: HUB, maxFrameBytes: 512 })).toThrow(
      new RangeError('maxFrameBytes is 512; expected an integer of at least 4096')
    );
  });

  it.each([
    ['maxInFlight', 0, 'maxInFlight is 0; expected an integer of at least 1'],
    ['maxInFlight', 1.5, 'maxInFlight is 1.5; expected an integer of at least 1'],
    ['maxStreamKeys', 0, 'maxStreamKeys is 0; expected an integer of at least 1'],
  ])('refuses %s of %p at construction', (option, value, message) => {
    // `maxInFlight: 0` announces a limit the schema refuses and `maxStreamKeys:
    // 0` refuses the session's own first emit; neither is a configuration a
    // caller can have meant, so it is refused where it was written.
    const ports = createInProcessPortPair();
    expect(() => new Session(ports.a, { peer: HUB, [option]: value })).toThrow(
      new RangeError(message)
    );
  });

  it('refuses a port whose own ceiling is below the floor of the wire', () => {
    // `Port.maxFrameBytes` is a plain number on an interface applications
    // implement, and the session now takes the lower of the two ceilings —
    // so a low one would quietly drag a perfectly valid option under the
    // floor, and the handshake would die naming neither number.
    class NarrowPort extends FakePort {
      readonly maxFrameBytes = 1024;
    }
    expect(() => new Session(new NarrowPort(), { peer: HUB, maxFrameBytes: 65_536 })).toThrow(
      new RangeError('port maxFrameBytes is 1024; expected an integer of at least 4096')
    );
  });

  it('keeps a port ceiling above the default when no option asks for less', async () => {
    // The option is absent, so the port's own ceiling is the answer whole; a
    // transport that can carry more than 16 MiB is not clamped back to it.
    const ports = createInProcessPortPair({ maxFrameBytes: 32 * 1024 * 1024 });
    const session = new Session(ports.a, { peer: HUB, livenessIntervalMs: false });
    ports.b.send({ ...rawHello(), limits: { maxFrameBytes: 32 * 1024 * 1024 } });
    await session.ready;
    expect(session.sendLimitBytes).toBe(32 * 1024 * 1024);
    session.close();
  });
});

describe('Session close', () => {
  it('resolves after every in-flight handler has settled', async () => {
    const ports = createInProcessPortPair();
    let released = (): void => undefined;
    let started = (): void => undefined;
    const firstCall = new Promise<void>((resolve) => {
      started = resolve;
    });
    let finished = false;
    const responder = new Session(ports.b, {
      peer: RUNTIME,
      livenessIntervalMs: false,
      handlers: {
        'test.slow': async () => {
          started();
          await new Promise<void>((resolve) => {
            released = resolve;
          });
          finished = true;
          return null;
        },
      },
    });
    const hub = new Session(ports.a, { peer: HUB, livenessIntervalMs: false });
    await Promise.all([hub.ready, responder.ready]);
    void hub.request('test.slow', {}).catch(() => undefined);
    await firstCall;

    const closing = responder.close();
    // Teardown is synchronous, so the state is already closed; the promise is
    // about the handler, which is still running.
    expect(responder.state).toBe('closed');
    expect(finished).toBe(false);
    released();
    const closure = await closing;

    expect(finished).toBe(true);
    expect(closure.code).toBe(CLOSE_CODES.RELEASED);
    hub.closeNow();
  });

  it('gives up on a handler that ignores its abort signal after the grace', async () => {
    const ports = createInProcessPortPair();
    const responder = new Session(ports.b, {
      peer: RUNTIME,
      livenessIntervalMs: false,
      handlerGraceMs: 20,
      // Never settles, and never looks at the signal: the shutdown is delayed
      // by an unkillable handler but must not be blocked by one.
      handlers: { 'test.stuck': () => new Promise(() => undefined) },
    });
    const hub = new Session(ports.a, { peer: HUB, livenessIntervalMs: false });
    await Promise.all([hub.ready, responder.ready]);
    void hub.request('test.stuck', {}).catch(() => undefined);
    await tick();

    const closure = await responder.close(CLOSE_CODES.RELEASED, 'grace');
    expect(closure.reason).toBe('grace');
    hub.closeNow();
  });

  it('a handler awaiting its own close() stalls to the grace, not forever', async () => {
    const ports = createInProcessPortPair();
    let started = 0;
    let finished = 0;
    let handlerSettled: () => void = () => undefined;
    const handlerDone = new Promise<void>((resolve) => {
      handlerSettled = resolve;
    });
    const responder = new Session(ports.b, {
      peer: RUNTIME,
      livenessIntervalMs: false,
      handlerGraceMs: 20,
      handlers: {
        // `close()` waits on every in-flight handler, this one included: it
        // cannot tell "called from inside a running handler" apart from any
        // other caller, so this call resolves only once the grace elapses.
        'test.closes-itself': async (_params, context) => {
          // A prior await, matching the shape that actually stalls: it lets
          // this handler's own dispatch promise land in `#dispatches` before
          // `close()` is called, so `close()` ends up waiting on it.
          await Promise.resolve();
          started = Date.now();
          await context.session.close();
          finished = Date.now();
          handlerSettled();
          return null;
        },
      },
    });
    const hub = new Session(ports.a, { peer: HUB, livenessIntervalMs: false });
    await Promise.all([hub.ready, responder.ready]);
    void hub.request('test.closes-itself', {}).catch(() => undefined);

    // Timed on the handler's own call, not a second close() from here: a
    // second call would race the first and could resolve sooner than a full
    // grace period, which is not the property this test is pinning down.
    await handlerDone;
    expect(finished - started).toBeGreaterThanOrEqual(15);
    hub.closeNow();
  });

  it('closeNow tears down without waiting, and closing twice is a no-op', async () => {
    const { hub, runtime } = pair();
    await Promise.all([hub.ready, runtime.ready]);

    hub.closeNow(CLOSE_CODES.SUPERSEDED, 'replaced');
    expect(hub.state).toBe('closed');
    expect(hub.closure).toMatchObject({ code: CLOSE_CODES.SUPERSEDED, reason: 'replaced' });

    // A second close keeps the first reason; nothing is re-torn-down.
    const again = await hub.close(CLOSE_CODES.RELEASED, 'later');
    expect(again).toMatchObject({ code: CLOSE_CODES.SUPERSEDED, reason: 'replaced' });
    runtime.closeNow();
  });
});

describe('Session requests', () => {
  it('rejects an invalid or reserved method name locally', async () => {
    const { hub } = pair();
    await expect(hub.request('nodots', {})).rejects.toMatchObject({
      code: RESERVED_ERROR_CODES.INVALID_REQUEST,
    });
    // `rpc.nowhere`, not `rpc.discover`: a reserved name this wire *defines*
    // is refused only once the effective minor is known, so it waits for the
    // handshake. Every other rpc. name never reaches the wire at all.
    await expect(hub.request('rpc.nowhere', {})).rejects.toMatchObject({
      code: RESERVED_ERROR_CODES.INVALID_REQUEST,
    });
    hub.close();
  });

  it('maps a handler that throws RemoteError, Error and AbortError onto the wire', async () => {
    const ports = createInProcessPortPair();
    const responder = new Session(ports.b, {
      peer: RUNTIME,
      livenessIntervalMs: false,
      handlers: {
        'test.remote': () => {
          throw new RemoteError('APP_CODE', 'app said no', { why: 'policy' });
        },
        'test.plain': () => {
          throw new Error('unexpected');
        },
        'test.abort': () => {
          throw Object.assign(new Error('gave up'), { name: 'AbortError' });
        },
        'test.void': () => undefined,
      },
    });
    const requester = new Session(ports.a, { peer: HUB, livenessIntervalMs: false });
    await expect(requester.request('test.remote', {})).rejects.toMatchObject({
      code: 'APP_CODE',
      message: 'app said no',
      details: { why: 'policy' },
    });
    await expect(requester.request('test.plain', {})).rejects.toMatchObject({
      code: RESERVED_ERROR_CODES.INTERNAL,
      message: 'unexpected',
    });
    await expect(requester.request('test.abort', {})).rejects.toMatchObject({
      code: RESERVED_ERROR_CODES.CANCELLED,
    });
    expect(await requester.request('test.void', {})).toBeNull();
    requester.close();
    responder.close();
  });

  it('answers a duplicate in-flight id with INVALID_REQUEST and keeps the first running', async () => {
    const ports = createInProcessPortPair();
    const recorder = new FrameRecorder(ports.b);
    let release: () => void = () => undefined;
    const session = new Session(ports.a, {
      peer: HUB,
      livenessIntervalMs: false,
      handlers: {
        'test.slow': () => new Promise<string>((resolve) => (release = () => resolve('done'))),
      },
    });
    ports.b.send(rawHello());
    await session.ready;
    ports.b.send({ type: 'req', id: 'dup', method: 'test.slow', params: {} });
    await tick();
    ports.b.send({ type: 'req', id: 'dup', method: 'test.slow', params: {} });
    const refused = await recorder.until((frame) => frame.type === 'err');
    expect(refused).toMatchObject({
      id: 'dup',
      error: { code: RESERVED_ERROR_CODES.INVALID_REQUEST },
    });
    release();
    const answered = await recorder.until((frame) => frame.type === 'res');
    expect(answered).toMatchObject({ id: 'dup', result: 'done' });
    session.close();
  });

  it('ignores a response for an unknown id', async () => {
    const ports = createInProcessPortPair();
    const session = new Session(ports.a, { peer: HUB, livenessIntervalMs: false });
    ports.b.send(rawHello());
    await session.ready;
    ports.b.send({ type: 'res', id: 'nobody', result: 1 });
    await tick();
    expect(session.state).toBe('ready');
    session.close();
  });

  it('fails a request sent after close with UNAVAILABLE', async () => {
    const { hub, runtime } = pair();
    await hub.ready;
    hub.close();
    await expect(hub.request('test.echo', {})).rejects.toMatchObject({
      code: RESERVED_ERROR_CODES.UNAVAILABLE,
    });
    runtime.close();
  });

  it('aborts the handler signal when the session closes', async () => {
    const ports = createInProcessPortPair();
    let aborted = false;
    const responder = new Session(ports.b, {
      peer: RUNTIME,
      livenessIntervalMs: false,
      handlers: {
        'test.hang': (_params, context) =>
          new Promise((_resolve, reject) => {
            context.signal.addEventListener('abort', () => {
              aborted = true;
              reject(new Error('closed'));
            });
          }),
      },
    });
    const requester = new Session(ports.a, { peer: HUB, livenessIntervalMs: false });
    const pending = requester.request('test.hang', {});
    await tick();
    responder.close();
    await expect(pending).rejects.toMatchObject({ code: RESERVED_ERROR_CODES.UNAVAILABLE });
    expect(aborted).toBe(true);
  });
});

describe('Session events and liveness', () => {
  it('drops events emitted before the handshake and after close', async () => {
    const ports = createInProcessPortPair();
    const session = new Session(ports.a, { peer: HUB, livenessIntervalMs: false });
    expect(session.emit({ topic: 'test.early', payload: 1 })).toBe(false);
    ports.b.send(rawHello());
    await session.ready;
    expect(session.emit({ topic: 'test.ok', payload: 1 })).toBe(true);
    session.close();
    expect(session.emit({ topic: 'test.late', payload: 1 })).toBe(false);
  });

  it('does not count a stream key whose send failed toward the ceiling', async () => {
    const ports = createInProcessPortPair();
    let failNextEvent = false;
    const port = new FailingSendPort(ports.a, (frame) => failNextEvent && frame.type === 'evt');
    const session = new Session(port, {
      peer: HUB,
      livenessIntervalMs: false,
      maxStreamKeys: 1,
    });
    ports.b.send(rawHello());
    await session.ready;

    failNextEvent = true;
    expect(() => session.emit({ topic: 'test.a', payload: null })).toThrow(
      'the transport refused this frame'
    );
    failNextEvent = false;
    // The failed emit above must not have left "test.a" occupying the one
    // stream key this session allows: a different key still fits.
    expect(session.emit({ topic: 'test.b', payload: null })).toBe(true);
  });

  it('closes with a liveness timeout when pongs stop', async () => {
    const ports = createInProcessPortPair();
    const session = new Session(ports.a, { peer: HUB, livenessIntervalMs: 15 });
    ports.b.send(rawHello());
    await session.ready;
    const closed = new Promise((resolve) => session.onClose(resolve));
    expect(await closed).toMatchObject({ code: CLOSE_CODES.RELEASED, reason: 'liveness timeout' });
  });

  it('stays open while the peer answers pings', async () => {
    const ports = createInProcessPortPair();
    ports.b.onFrame((frame) => {
      if (frame.type === 'ping') ports.b.send({ type: 'pong' });
    });
    const session = new Session(ports.a, { peer: HUB, livenessIntervalMs: 10 });
    ports.b.send(rawHello());
    await session.ready;
    await tick(60);
    expect(session.state).toBe('ready');
    session.close();
  });

  it('tears down on a received close frame with its code', async () => {
    const ports = createInProcessPortPair();
    const session = new Session(ports.a, { peer: HUB, livenessIntervalMs: false });
    ports.b.send(rawHello());
    await session.ready;
    const closed = new Promise((resolve) => session.onClose(resolve));
    ports.b.send({ type: 'close', code: CLOSE_CODES.UNAUTHORIZED, reason: 'token revoked' });
    expect(await closed).toMatchObject({
      code: CLOSE_CODES.UNAUTHORIZED,
      reason: 'token revoked',
      fatal: true,
    });
  });

  it('fires onClose once, and immediately for a late subscriber', async () => {
    const { hub, runtime } = pair();
    await hub.ready;
    let count = 0;
    hub.onClose(() => {
      count += 1;
    });
    hub.close();
    hub.close();
    await tick();
    expect(count).toBe(1);
    const late = new Promise((resolve) => hub.onClose(resolve));
    expect(await late).toMatchObject({ code: CLOSE_CODES.RELEASED });
    runtime.close();
  });
});

describe('Session port closures', () => {
  it('rejects ready with PROTOCOL_MISMATCH when the port refuses the peer hello with 4426', async () => {
    const port = new FakePort();
    const session = new Session(port, { peer: HUB, livenessIntervalMs: false });
    const error = new CodecError('schema', 'hello does not match the wire schema', {
      frameType: 'hello',
    });
    port.report({ kind: 'protocol-error', error, code: CLOSE_CODES.PROTOCOL_MISMATCH });

    await expect(session.ready).rejects.toMatchObject({
      code: RESERVED_ERROR_CODES.PROTOCOL_MISMATCH,
      details: { closeCode: CLOSE_CODES.PROTOCOL_MISMATCH },
    });
    expect(session.closure).toMatchObject({
      code: CLOSE_CODES.PROTOCOL_MISMATCH,
      fatal: true,
      error,
    });
    expect(session.state).toBe('closed');
  });

  it('carries the codec error and rejects ready with UNAVAILABLE on a 4400 refusal', async () => {
    const port = new FakePort();
    const session = new Session(port, { peer: HUB, livenessIntervalMs: false });
    const error = new CodecError('invalid-json', 'line is not JSON');
    port.report({ kind: 'protocol-error', error, code: CLOSE_CODES.PROTOCOL_ERROR });

    await expect(session.ready).rejects.toMatchObject({
      code: RESERVED_ERROR_CODES.UNAVAILABLE,
      details: { closeCode: CLOSE_CODES.PROTOCOL_ERROR },
    });
    expect(session.closure).toMatchObject({
      code: CLOSE_CODES.PROTOCOL_ERROR,
      reason: 'line is not JSON',
      fatal: false,
      error,
    });
  });

  it('treats a link that vanished as a 4000 release', async () => {
    const port = new FakePort();
    const session = new Session(port, { peer: HUB, livenessIntervalMs: false });
    port.report({ kind: 'closed' });

    await expect(session.ready).rejects.toMatchObject({ code: RESERVED_ERROR_CODES.UNAVAILABLE });
    expect(session.closure).toMatchObject({ code: CLOSE_CODES.RELEASED, fatal: false });
  });
});
