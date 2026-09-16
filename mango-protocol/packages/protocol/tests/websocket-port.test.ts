import { describe, expect, it } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { CHUNK_HEADER_BYTES } from '../src/codec/chunk';
import { RESERVED_ERROR_CODES } from '../src/errors';
import type { PortClosure } from '../src/port';
import type { Frame } from '../src/schemas/frames';
import { Session } from '../src/session';
import { CONFORMANCE_A } from '../src/testing/conformance';
import { rejectionOf } from '../src/testing/rejection';
import {
  createWebSocketPort,
  outcomeOfBunSend,
  type SendOutcome,
  WEBSOCKET_SUBPROTOCOL,
  type WebSocketPortHandle,
  type WebSocketPortOptions,
  type WebSocketSink,
} from '../src/transports/websocket';
import { type WhatwgWebSocketLike, webSocketPort } from '../src/transports/websocket-client';

/** A socket that records what it was asked to do and answers a scripted outcome. */
class FakeWebSocketSink implements WebSocketSink {
  readonly sent: Uint8Array[] = [];
  readonly closes: { code: number; reason: string | undefined }[] = [];
  /** Ordered log of calls, so a test can prove the close frame went out first. */
  readonly calls: string[] = [];
  /** Answers for the next sends, in order; `outcome` answers the rest. */
  readonly scripted: SendOutcome[] = [];
  outcome: SendOutcome | undefined = 'sent';

  send(message: Uint8Array): SendOutcome | undefined {
    const answer = this.scripted.shift() ?? this.outcome;
    this.calls.push(`send:${answer ?? 'undefined'}`);
    if (answer !== 'dropped') this.sent.push(message.slice());
    return answer;
  }

  close(code: number, reason?: string): void {
    this.calls.push(`close:${code}`);
    this.closes.push({ code, reason });
  }
}

/** A socket whose `close` calls the close handler back synchronously, as Bun's does. */
class ReentrantCloseSink implements WebSocketSink {
  handle: WebSocketPortHandle | undefined;
  readonly closes: number[] = [];

  send(): SendOutcome {
    return 'sent';
  }

  close(code: number, reason?: string): void {
    this.closes.push(code);
    this.handle?.onClose(code, reason);
  }
}

/** A WHATWG socket whose events a test fires by hand. */
class FakeWhatwgWebSocket implements WhatwgWebSocketLike {
  binaryType = 'nodebuffer';
  readyState = 1;
  protocol: string = WEBSOCKET_SUBPROTOCOL;
  readonly sent: Uint8Array[] = [];
  readonly closes: { code: number | undefined; reason: string | undefined }[] = [];
  readonly #listeners = new Map<string, ((event: unknown) => void)[]>();

  send(data: Uint8Array): void {
    this.sent.push(data.slice());
  }

  close(code?: number, reason?: string): void {
    this.readyState = 3;
    this.closes.push({ code, reason });
  }

  addEventListener(type: string, listener: (event: never) => void): void {
    const listeners = this.#listeners.get(type) ?? [];
    listeners.push(listener as (event: unknown) => void);
    this.#listeners.set(type, listeners);
  }

  /** Fires one event at every listener registered for it. */
  emit(type: string, event?: unknown): void {
    for (const listener of this.#listeners.get(type) ?? []) listener(event);
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Version, index and count of one outgoing message. */
function headerOf(message: Uint8Array): { version: number; index: number; count: number } {
  const view = new DataView(message.buffer, message.byteOffset, message.byteLength);
  return { version: view.getUint8(0), index: view.getUint32(1), count: view.getUint32(5) };
}

/** The NDJSON line a run of messages carries. */
function lineOf(messages: readonly Uint8Array[]): string {
  const payloads = messages.map((message) => message.subarray(CHUNK_HEADER_BYTES));
  const size = payloads.reduce((total, payload) => total + payload.byteLength, 0);
  const line = new Uint8Array(size);
  let offset = 0;
  for (const payload of payloads) {
    line.set(payload, offset);
    offset += payload.byteLength;
  }
  return decoder.decode(line);
}

/** One message carrying `line` whole, the way a raw peer would send it. */
function rawChunk(line: string): Uint8Array {
  const payload = encoder.encode(line);
  const message = new Uint8Array(CHUNK_HEADER_BYTES + payload.byteLength);
  const view = new DataView(message.buffer);
  view.setUint8(0, 1);
  view.setUint32(1, 0);
  view.setUint32(5, 1);
  message.set(payload, CHUNK_HEADER_BYTES);
  return message;
}

interface Harness {
  readonly sink: FakeWebSocketSink;
  readonly handle: WebSocketPortHandle;
  readonly closures: PortClosure[];
}

function harness(options: WebSocketPortOptions = {}): Harness {
  const sink = new FakeWebSocketSink();
  const handle = createWebSocketPort(sink, options);
  const closures: PortClosure[] = [];
  handle.port.onClosed((closure) => closures.push(closure));
  return { sink, handle, closures };
}

function blobFrame(bytes: number, id: string): Frame {
  return { type: 'req', id, method: 'test.echo', params: { blob: 'x'.repeat(bytes) } };
}

describe('createWebSocketPort', () => {
  it('sends one frame as a contiguous run of chunks and never interleaves two', () => {
    const { sink, handle } = harness({ maxMessageBytes: 2048 });

    handle.port.send(blobFrame(5000, 'r1'));
    handle.port.send(blobFrame(5000, 'r2'));

    const headers = sink.sent.map(headerOf);
    expect(headers.every((header) => header.version === 1)).toBe(true);
    const count = headers[0]?.count ?? 0;
    expect(count).toBeGreaterThan(1);
    expect(headers.map((header) => header.index)).toEqual([
      ...Array.from({ length: count }, (_value, index) => index),
      ...Array.from({ length: count }, (_value, index) => index),
    ]);
    expect(JSON.parse(lineOf(sink.sent.slice(0, count)))).toMatchObject({ id: 'r1' });
    expect(JSON.parse(lineOf(sink.sent.slice(count)))).toMatchObject({ id: 'r2' });
  });

  it('pauses the queue on a buffered send and resumes it on drain', () => {
    const { sink, handle } = harness({ maxMessageBytes: 2048 });
    sink.scripted.push('buffered');

    handle.port.send(blobFrame(5000, 'r1'));
    const paused = sink.sent.length;
    expect(paused).toBe(1);

    handle.onDrain();
    expect(sink.sent.length).toBeGreaterThan(paused);
    expect(JSON.parse(lineOf(sink.sent))).toMatchObject({ id: 'r1' });
  });

  it('treats a sink that returns nothing as having sent the message', () => {
    const { sink, handle } = harness();
    sink.outcome = undefined;

    handle.port.send({ type: 'ping' });

    expect(sink.sent).toHaveLength(1);
    expect(JSON.parse(lineOf(sink.sent))).toEqual({ type: 'ping' });
  });

  it('closes with 4400 when a paused queue grows past one frame limit', () => {
    const { sink, handle, closures } = harness({ maxFrameBytes: 4096, maxMessageBytes: 2048 });
    sink.outcome = 'buffered';

    handle.port.send(blobFrame(3900, 'r1'));
    expect(sink.closes).toEqual([]);
    handle.port.send(blobFrame(3900, 'r2'));

    expect(sink.closes).toMatchObject([{ code: 4400 }]);
    expect(closures).toHaveLength(1);
    expect(closures[0]).toMatchObject({ kind: 'closed', code: 4400 });
    expect((closures[0] as { reason: string }).reason).toMatch(
      /send queue holds \d+ bytes .*expected at most 4096/
    );
  });

  it('closes with 4400 when the socket drops a chunk', () => {
    const { sink, handle, closures } = harness();
    sink.outcome = 'dropped';

    handle.port.send({ type: 'ping' });

    expect(sink.closes).toMatchObject([{ code: 4400 }]);
    expect(closures[0]).toMatchObject({ kind: 'closed', code: 4400 });
    expect((closures[0] as { reason: string }).reason).toMatch(/dropped a \d+-byte chunk/);
  });

  it('reports a text message as a protocol error and closes with 4400', () => {
    const { sink, handle, closures } = harness();

    handle.onMessage('{"type":"ping"}');

    expect(sink.closes).toMatchObject([{ code: 4400 }]);
    expect(closures[0]).toMatchObject({ kind: 'protocol-error', code: 4400 });
    const closure = closures[0] as { error: Error };
    expect(closure.error.message).toMatch(/message is text of 15 characters; expected a binary/);
  });

  it('reports a refused chunk with the close code the refusal calls for', () => {
    const bad = harness();
    const versionTwo = rawChunk('{"type":"ping"}');
    versionTwo[0] = 2;
    bad.handle.onMessage(versionTwo);
    expect(bad.sink.closes).toMatchObject([{ code: 4400 }]);
    expect(bad.closures[0]).toMatchObject({ kind: 'protocol-error', code: 4400 });
    expect((bad.closures[0] as { error: { kind: string } }).error.kind).toBe('chunk-version');

    const hello = harness();
    hello.handle.onMessage(rawChunk('{"type":"hello","protocolVersion":"1.0.1"}'));
    expect(hello.sink.closes).toMatchObject([{ code: 4426 }]);
    expect(hello.closures[0]).toMatchObject({ kind: 'protocol-error', code: 4426 });
  });

  it('truncates a long refusal to the 123 bytes a close frame allows', () => {
    const { sink, handle } = harness();

    handle.onMessage(rawChunk(`{"type":"hello","note":"${'é'.repeat(400)}"`));

    const reason = sink.closes[0]?.reason ?? '';
    expect(reason.length).toBeGreaterThan(0);
    expect(encoder.encode(reason).byteLength).toBeLessThanOrEqual(123);
  });

  it('delivers a frame once every chunk of it has arrived', () => {
    const sender = harness({ maxMessageBytes: 2048 });
    sender.handle.port.send(blobFrame(5000, 'r1'));

    const receiver = harness({ maxMessageBytes: 2048 });
    const frames: Frame[] = [];
    receiver.handle.port.onFrame((frame) => frames.push(frame));
    for (const [index, message] of sender.sink.sent.entries()) {
      receiver.handle.onMessage(message);
      if (index < sender.sink.sent.length - 1) expect(frames).toHaveLength(0);
    }

    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ id: 'r1', method: 'test.echo' });
  });

  it('accepts an ArrayBuffer as readily as a view', () => {
    const sender = harness();
    sender.handle.port.send({ type: 'pong' });
    const message = sender.sink.sent[0] ?? new Uint8Array();

    const receiver = harness();
    const frames: Frame[] = [];
    receiver.handle.port.onFrame((frame) => frames.push(frame));
    receiver.handle.onMessage(message.slice().buffer);

    expect(frames).toEqual([{ type: 'pong' }]);
  });

  it('carries a 4xxx close code to the closure and drops a link-level one', () => {
    const reasoned = harness();
    reasoned.handle.onClose(4409, 'superseded by a newer connection');
    expect(reasoned.closures).toEqual([
      { kind: 'closed', code: 4409, reason: 'superseded by a newer connection' },
    ]);

    const severed = harness();
    severed.handle.onClose(1006, 'Connection ended');
    expect(severed.closures).toEqual([{ kind: 'closed' }]);
  });

  it('reports a socket error as the link ending, without a reason code', () => {
    const { closures } = reportError();
    expect(closures).toEqual([{ kind: 'closed', reason: 'socket reset' }]);
  });

  function reportError(): Harness {
    const built = harness();
    built.handle.onError(new Error('socket reset'));
    return built;
  }

  it('reports a closure at most once', () => {
    const { handle, closures } = harness();

    handle.onClose(4000, 'released');
    handle.onClose(4409, 'superseded');
    handle.onError(new Error('late'));

    expect(closures).toEqual([{ kind: 'closed', code: 4000, reason: 'released' }]);
  });

  it('sends the close frame before closing the socket, and reports no closure', () => {
    const { sink, handle, closures } = harness();

    handle.port.close(4409, 'superseded by a newer connection');

    expect(sink.calls).toEqual(['send:sent', 'close:4409']);
    expect(JSON.parse(lineOf(sink.sent))).toEqual({
      type: 'close',
      code: 4409,
      reason: 'superseded by a newer connection',
    });
    expect(sink.closes).toEqual([{ code: 4409, reason: 'superseded by a newer connection' }]);
    expect(closures).toEqual([]);

    handle.onClose(4409, 'superseded by a newer connection');
    expect(closures).toEqual([]);
  });

  it('skips the close frame when the option is off', () => {
    const { sink, handle } = harness({ sendCloseFrame: false });

    handle.port.close(4000, 'released');

    expect(sink.calls).toEqual(['close:4000']);
  });

  it('throws on a send after the port closed, naming the state', () => {
    const { handle } = harness();
    handle.port.close(4409, 'superseded');

    expect(() => handle.port.send({ type: 'ping' })).toThrow(
      /WebSocket port is closed with code 4409; expected an open port to send a ping frame/
    );
  });

  it('ignores a message that arrives after the port closed', () => {
    const { handle, closures } = harness();
    handle.onClose(4000, 'released');

    handle.onMessage('a text frame nobody should see');

    expect(closures).toEqual([{ kind: 'closed', code: 4000, reason: 'released' }]);
  });

  it('keeps the refusal when the socket reports its own close synchronously', () => {
    const sink = new ReentrantCloseSink();
    const handle = createWebSocketPort(sink);
    sink.handle = handle;
    const closures: PortClosure[] = [];
    handle.port.onClosed((closure) => closures.push(closure));

    handle.onMessage('{"type":"ping"}');

    expect(sink.closes).toEqual([4400]);
    expect(closures).toHaveLength(1);
    expect(closures[0]).toMatchObject({ kind: 'protocol-error', code: 4400 });
  });

  it('holds frames that arrive before anyone subscribed and delivers them in order', async () => {
    const sender = harness();
    sender.handle.port.send({ type: 'ping' });
    sender.handle.port.send({ type: 'pong' });

    const receiver = harness();
    for (const message of sender.sink.sent) receiver.handle.onMessage(message);
    const frames: Frame[] = [];
    receiver.handle.port.onFrame((frame) => frames.push(frame));

    expect(frames).toEqual([]);
    await Promise.resolve();
    expect(frames).toEqual([{ type: 'ping' }, { type: 'pong' }]);
  });

  it('exposes the frame limit it decodes under', () => {
    expect(harness().handle.port.maxFrameBytes).toBe(16 * 1024 * 1024);
    expect(harness({ maxFrameBytes: 8192 }).handle.port.maxFrameBytes).toBe(8192);
  });
});

describe('createWebSocketPort accept', () => {
  const ALLOWED_ORIGINS = ['https://app.example'];

  it('refuses a disallowed origin with 4403 before hello, and sends nothing', async () => {
    const sink = new FakeWebSocketSink();
    const handle = createWebSocketPort(sink, {
      accept: { origin: 'https://evil.example', allowedOrigins: ALLOWED_ORIGINS },
    });
    const closures: PortClosure[] = [];
    handle.port.onClosed((closure) => closures.push(closure));

    // No farewell close frame: spec/transports/websocket.md says "before it
    // sends hello", so nothing goes out ahead of the refusal.
    expect(sink.sent).toEqual([]);
    expect(sink.calls).toEqual(['close:4403']);
    expect(sink.closes).toEqual([{ code: 4403, reason: 'origin not allowed' }]);

    // The report waits for a subscriber, so a listener attached in the same
    // tick as `createWebSocketPort` (the ordinary case) still sees it.
    expect(closures).toEqual([]);
    await Promise.resolve();
    expect(closures).toEqual([{ kind: 'closed', code: 4403, reason: 'origin not allowed' }]);
  });

  it('still reports the refusal to a listener that subscribes turns later', async () => {
    // An acceptor that awaits anything at all between building the port and
    // wiring it up — a session lookup, an audit write — drains the microtask
    // queue first. A closure held for exactly one microtask is gone by then,
    // and the subscriber would never learn why the port is closed.
    const sink = new FakeWebSocketSink();
    const handle = createWebSocketPort(sink, {
      accept: { origin: 'https://evil.example', allowedOrigins: ALLOWED_ORIGINS },
    });
    await Promise.resolve();
    await Promise.resolve();

    const closures: PortClosure[] = [];
    handle.port.onClosed((closure) => closures.push(closure));
    await Promise.resolve();

    expect(closures).toEqual([{ kind: 'closed', code: 4403, reason: 'origin not allowed' }]);
  });

  it('fails a Session built on the refused port, naming the code the socket was closed with', async () => {
    const sink = new FakeWebSocketSink();
    const handle = createWebSocketPort(sink, {
      accept: { origin: 'https://evil.example', allowedOrigins: ALLOWED_ORIGINS },
    });

    // The port is already closed, so the session's own `hello` is refused
    // where it is sent rather than after a handshake timeout; the 4403 rides
    // in the refusal. The closure itself is what `port.onClosed` reports.
    const rejection = await rejectionOf(new Session(handle.port, { peer: CONFORMANCE_A }).ready);

    expect(rejection).toMatchObject({ code: RESERVED_ERROR_CODES.UNAVAILABLE });
    expect((rejection as Error).message).toContain('4403');
  });

  it('drops a later onClose(4403) from the framework as a no-op', async () => {
    const sink = new FakeWebSocketSink();
    const handle = createWebSocketPort(sink, {
      accept: { origin: 'https://evil.example', allowedOrigins: ALLOWED_ORIGINS },
    });
    const closures: PortClosure[] = [];
    handle.port.onClosed((closure) => closures.push(closure));
    await Promise.resolve();

    handle.onClose(4403, 'origin not allowed');

    expect(closures).toHaveLength(1);
  });

  it('still reports the refusal when the framework closes before anyone subscribes', async () => {
    // The ordinary integration order: `refuseOrigin` closes the socket, the
    // framework calls back with its own close, and only then does the
    // acceptor wire a `Session` to the port. A closure the port emitted to
    // nobody must not count as reported, or the subscriber that follows
    // learns nothing about the 4403 the socket was closed with.
    const sink = new FakeWebSocketSink();
    const handle = createWebSocketPort(sink, {
      accept: { origin: 'https://evil.example', allowedOrigins: ALLOWED_ORIGINS },
    });
    handle.onClose(4403, 'origin not allowed');

    const closures: PortClosure[] = [];
    handle.port.onClosed((closure) => closures.push(closure));
    await Promise.resolve();

    expect(closures).toEqual([{ kind: 'closed', code: 4403, reason: 'origin not allowed' }]);
  });

  it('lets hello flow for an allowed origin', () => {
    const sink = new FakeWebSocketSink();
    const handle = createWebSocketPort(sink, {
      accept: { origin: 'https://app.example', allowedOrigins: ALLOWED_ORIGINS },
    });

    handle.port.send({ type: 'ping' });

    expect(sink.calls).toEqual(['send:sent']);
  });

  it('lets hello flow for an absent origin, which is not a browser', () => {
    const sink = new FakeWebSocketSink();
    const handle = createWebSocketPort(sink, {
      accept: { origin: undefined, allowedOrigins: ALLOWED_ORIGINS },
    });

    handle.port.send({ type: 'ping' });

    expect(sink.calls).toEqual(['send:sent']);
  });

  it('never refuses without an accept option, whatever the upgrade carried', async () => {
    const sink = new FakeWebSocketSink();
    const handle = createWebSocketPort(sink);
    const closures: PortClosure[] = [];
    handle.port.onClosed((closure) => closures.push(closure));

    handle.port.send({ type: 'ping' });
    await Promise.resolve();

    // The refusal is opt-in: without `accept` the port neither closes nor
    // reports a closure, whoever the origin would have been.
    expect(sink.calls).toEqual(['send:sent']);
    expect(sink.closes).toEqual([]);
    expect(closures).toEqual([]);
  });
});

describe('outcomeOfBunSend', () => {
  it('maps the ServerWebSocket send status onto an outcome', () => {
    expect(outcomeOfBunSend(0)).toBe('dropped');
    expect(outcomeOfBunSend(-1)).toBe('buffered');
    expect(outcomeOfBunSend(24)).toBe('sent');
  });
});

describe('webSocketPort', () => {
  it('refuses a socket that is not open, naming the readyState', () => {
    const socket = new FakeWhatwgWebSocket();
    socket.readyState = 0;

    expect(() => webSocketPort(socket)).toThrow(/WebSocket readyState is 0; expected OPEN \(1\)/);
  });

  it('switches the socket to arraybuffer and forwards sends', () => {
    const socket = new FakeWhatwgWebSocket();

    const port = webSocketPort(socket);
    port.send({ type: 'ping' });

    expect(socket.binaryType).toBe('arraybuffer');
    expect(JSON.parse(lineOf(socket.sent))).toEqual({ type: 'ping' });
  });

  it('wires message, close and error events to the port', () => {
    const sender = new FakeWhatwgWebSocket();
    webSocketPort(sender).send({ type: 'pong' });

    const socket = new FakeWhatwgWebSocket();
    const port = webSocketPort(socket);
    const frames: Frame[] = [];
    const closures: PortClosure[] = [];
    port.onFrame((frame) => frames.push(frame));
    port.onClosed((closure) => closures.push(closure));

    socket.emit('message', { data: sender.sent[0] });
    expect(frames).toEqual([{ type: 'pong' }]);

    socket.emit('close', { code: 4429, reason: 'slow down' });
    expect(closures).toEqual([{ kind: 'closed', code: 4429, reason: 'slow down' }]);
  });

  it('reports an error event as the link ending', () => {
    const socket = new FakeWhatwgWebSocket();
    const port = webSocketPort(socket);
    const closures: PortClosure[] = [];
    port.onClosed((closure) => closures.push(closure));

    socket.emit('error');

    expect(closures).toMatchObject([{ kind: 'closed' }]);
  });

  it('closes the socket with the code the owner chose', () => {
    const socket = new FakeWhatwgWebSocket();

    webSocketPort(socket).close(4000, 'released');

    expect(socket.closes).toEqual([{ code: 4000, reason: 'released' }]);
  });
});

describe('the ws entry', () => {
  it('imports no node: module, so it stays browser-safe', async () => {
    const nodeImport = /(?:from|import|require)\s*\(?\s*['"]node:/;
    const root = fileURLToPath(new URL('../src', import.meta.url));
    const paths = [
      `${root}/ws.ts`,
      `${root}/transports/websocket.ts`,
      `${root}/transports/websocket-client.ts`,
    ];

    for (const path of paths) {
      expect(nodeImport.test(await Bun.file(path).text())).toBe(false);
    }
    expect(nodeImport.test("import { Buffer } from 'node:buffer';")).toBe(true);
  });
});
