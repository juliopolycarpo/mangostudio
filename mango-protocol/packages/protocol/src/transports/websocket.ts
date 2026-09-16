/**
 * The WebSocket transport of spec/transports/websocket.md: one connection
 * carries one session, frames travel as chunked binary messages under the
 * `mango.v1` subprotocol, and the WebSocket close code carries the reason code.
 *
 * This module owns no socket. It takes a sink — anything that can send bytes
 * and close — and returns a `Port` plus the four callbacks a server framework
 * calls when its socket moves. `websocket-client.ts` wires a WHATWG socket to
 * it; a Bun, Deno or Node server does the same with its own object.
 *
 * Nothing here imports `node:`, so the `@mangostudio/protocol/ws` entry stays
 * browser-safe.
 */

import { CLOSE_CODES, closeCodeForCodecError, isCloseCode } from '../close';
import { type ChunkOptions, ChunkReassembler, encodeChunks } from '../codec/chunk';
import { resolveFrameLimit } from '../codec/ndjson';
import { CodecError } from '../errors';
import { Listeners } from '../listeners';
import type { Port, PortClosure } from '../port';
import type { Frame } from '../schemas/frames';

/** The subprotocol a Mango Protocol 1 dialler offers and an acceptor selects. */
export const WEBSOCKET_SUBPROTOCOL = 'mango.v1' as const;

/** RFC 6455 caps the close reason at 123 UTF-8 bytes; the `close` frame carries the full one. */
const MAX_CLOSE_REASON_BYTES = 123;

const encoder = new TextEncoder();

/**
 * What a socket did with one message: took it, buffered it under backpressure
 * (stop until the socket drains), or refused it (fatal, the stream is now out
 * of step).
 */
export type SendOutcome = 'sent' | 'buffered' | 'dropped';

/** The two things the port needs from a socket. A sink that returns nothing sent the message. */
export interface WebSocketSink {
  send(message: Uint8Array): SendOutcome | undefined;
  close(code: number, reason?: string): void;
}

/** How the port chunks what it sends and bounds what it reassembles. */
export interface WebSocketPortOptions {
  /** Largest frame this port reassembles; `16777216` by default (§11). */
  readonly maxFrameBytes?: number;
  /** Message ceiling for the chunker; `16384` by default. */
  readonly maxMessageBytes?: number;
  /**
   * Send a `close` frame before closing the socket. On by default. The close
   * code already carries the reason, so a peer may turn it off; when both are
   * sent the frame goes first.
   */
  readonly sendCloseFrame?: boolean;
  /**
   * Opts this port into enforcing the Origin policy of
   * spec/transports/websocket.md itself, for an acceptor that would rather
   * hand the header down than check it at the HTTP upgrade. `origin` is
   * required but nullable on purpose: a caller must write out
   * `request.headers.get('origin') ?? undefined` rather than omit the field,
   * so forgetting to read the header cannot read as an origin to pass
   * through. A disallowed origin gets nothing at all, not even `hello`: the
   * port closes itself with `4403` before `createWebSocketPort` returns.
   */
  readonly accept?: {
    readonly origin: string | undefined;
    readonly allowedOrigins: readonly string[];
  };
}

/**
 * The port, and the four callbacks whichever framework owns the socket must
 * call: one per incoming message, one when the socket drains, one when it
 * closes, one when it errors.
 */
export interface WebSocketPortHandle {
  readonly port: Port;
  /** One incoming WebSocket message. A text message is a protocol error. */
  onMessage(message: Uint8Array | ArrayBuffer | string): void;
  /** The socket finished flushing what backpressure had buffered. */
  onDrain(): void;
  /** The socket closed. `4000`–`4999` is the peer's reason code. */
  onClose(code: number, reason?: string): void;
  /** The socket failed. Reported as the link ending, without a reason code. */
  onError(error: Error): void;
}

/**
 * True when an acceptor's allow-list admits the `Origin` an upgrade carried.
 *
 * The comparison is exact on the serialised origin, never a prefix, suffix or
 * substring: `https://app.example.attacker.test` ends with no entry of
 * `['https://app.example']` and must not be admitted by one. There is no
 * wildcard — an entry is one origin — and an empty list admits no browser at
 * all, which is the right configuration for an acceptor that only ever serves
 * native clients.
 *
 * An absent `Origin` is not a browser: no user agent attached one, so this
 * check passes it through and the credential is what governs it
 * (spec/transports/websocket.md, Origin).
 *
 * @example
 * isOriginAllowed('https://app.example', ['https://app.example']); // true
 * isOriginAllowed('https://app.example.attacker.test', ['https://app.example']); // false
 */
export function isOriginAllowed(origin: string | undefined, allowed: readonly string[]): boolean {
  if (origin === undefined) return true;
  return allowed.includes(origin);
}

/**
 * Maps the number `Bun.ServerWebSocket.send` returns onto a `SendOutcome`:
 * `0` is a dropped message, `-1` is backpressure, anything above zero is the
 * count of bytes sent.
 *
 * @example
 * const sink = { send: (bytes) => outcomeOfBunSend(ws.send(bytes)), close: (c, r) => ws.close(c, r) };
 */
export function outcomeOfBunSend(result: number): SendOutcome {
  if (result === 0) return 'dropped';
  if (result < 0) return 'buffered';
  return 'sent';
}

/**
 * Wraps a socket sink as a `Port`: frames go out as a contiguous run of chunks
 * through one FIFO queue, incoming messages are reassembled into frames, and
 * the WebSocket close code becomes the port's closure.
 *
 * @example
 * const handle = createWebSocketPort({
 *   send: (bytes) => outcomeOfBunSend(ws.send(bytes)),
 *   close: (code, reason) => ws.close(code, reason),
 * });
 * const session = new Session(handle.port, { peer });
 * // then, from the framework's own callbacks:
 * handle.onMessage(message);
 * handle.onClose(code, reason);
 *
 * With `accept`, a disallowed origin closes the returned port with `4403`
 * before this returns and sends nothing to the socket first:
 *
 * @example
 * const handle = createWebSocketPort(sink, {
 *   accept: { origin: request.headers.get('origin') ?? undefined, allowedOrigins },
 * });
 * // The port is closed before the session can send `hello`, so `ready`
 * // rejects with UNAVAILABLE naming the 4403 the socket was closed with;
 * // `handle.port.onClosed` reports that closure in full.
 * new Session(handle.port, { peer });
 */
export function createWebSocketPort(
  sink: WebSocketSink,
  options: WebSocketPortOptions = {}
): WebSocketPortHandle {
  const port = new WebSocketPort(sink, options);
  if (
    options.accept !== undefined &&
    !isOriginAllowed(options.accept.origin, options.accept.allowedOrigins)
  ) {
    port.refuseOrigin();
  }
  return {
    port,
    onMessage: (message) => port.receiveMessage(message),
    onDrain: () => port.receiveDrain(),
    onClose: (code, reason) => port.receiveClose(code, reason),
    onError: (error) => port.receiveError(error),
  };
}

/** One connection's port: a send queue, a reassembler, and one closure. */
class WebSocketPort implements Port {
  readonly maxFrameBytes: number;
  readonly #sink: WebSocketSink;
  readonly #chunkOptions: ChunkOptions;
  readonly #sendCloseFrame: boolean;
  readonly #reassembler: ChunkReassembler;
  readonly #frames = new Listeners<Frame>();
  readonly #closed = new Listeners<PortClosure>();
  /** Chunks accepted from `send` that the socket has not taken yet, in order. */
  #queue: Uint8Array[] = [];
  #queuedBytes = 0;
  /**
   * Frames decoded before anyone subscribed. The socket is listening from the
   * moment it exists, and the peer sends its `hello` as soon as the upgrade
   * completes, so a frame can be ready before the session is constructed.
   */
  #arrivals: Frame[] = [];
  #flushScheduled = false;
  #paused = false;
  #open = true;
  #ownerClosed = false;
  #reported = false;
  /** A closure raised before anyone subscribed; held rather than dropped. */
  #pendingClosure: PortClosure | undefined;
  #closureScheduled = false;
  #closeCode: number | undefined;

  constructor(sink: WebSocketSink, options: WebSocketPortOptions) {
    this.#sink = sink;
    this.maxFrameBytes = resolveFrameLimit(options);
    this.#chunkOptions = {
      maxFrameBytes: this.maxFrameBytes,
      ...(options.maxMessageBytes !== undefined
        ? { maxMessageBytes: options.maxMessageBytes }
        : {}),
    };
    this.#sendCloseFrame = options.sendCloseFrame ?? true;
    this.#reassembler = new ChunkReassembler({ maxFrameBytes: this.maxFrameBytes });
  }

  send(frame: Frame): void {
    if (!this.#open) {
      throw new Error(
        `WebSocket port is ${this.#state()}; expected an open port to send a ${frame.type} frame.`
      );
    }
    this.#enqueue(encodeChunks(frame, this.#chunkOptions));
  }

  onFrame(listener: (frame: Frame) => void): () => void {
    const detach = this.#frames.add(listener);
    this.#scheduleArrivals();
    return detach;
  }

  onClosed(listener: (closure: PortClosure) => void): () => void {
    const detach = this.#closed.add(listener);
    this.#scheduleClosure();
    return detach;
  }

  close(code: number, reason?: string): void {
    if (!this.#open) return;
    // Set first: a farewell the socket drops must not report a closure the
    // owner already knows about.
    this.#ownerClosed = true;
    if (this.#sendCloseFrame) this.#sendFarewell(code, reason);
    if (!this.#open) return;
    this.#shutdown(code);
    this.#sink.close(code, clampCloseReason(reason));
  }

  /**
   * Refuses the port before it ever sends anything: no farewell `close`
   * frame (spec/transports/websocket.md, Origin says "before it sends
   * `hello`", so nothing may go out ahead of the refusal), just the socket
   * close and the closure.
   *
   * Unlike `close()`, the closure here is not one the caller already knows
   * about — this runs inside `createWebSocketPort`, before the caller has
   * the handle back — so `#ownerClosed` stays false and `#report` holds the
   * closure until somebody subscribes, the way `#arrivals` holds a frame
   * that arrived before anyone was listening for frames.
   */
  refuseOrigin(): void {
    this.#shutdown(CLOSE_CODES.FORBIDDEN);
    this.#sink.close(CLOSE_CODES.FORBIDDEN, 'origin not allowed');
    this.#report({
      kind: 'closed',
      code: CLOSE_CODES.FORBIDDEN,
      reason: 'origin not allowed',
    });
  }

  /** One incoming message: text is fatal, bytes feed the reassembler. */
  receiveMessage(message: Uint8Array | ArrayBuffer | string): void {
    if (!this.#open) return;
    if (typeof message === 'string') {
      this.#failReceive(
        new CodecError(
          'schema',
          `message is text of ${message.length} characters; expected a binary message, the only kind ${WEBSOCKET_SUBPROTOCOL} carries`
        )
      );
      return;
    }
    const bytes = message instanceof Uint8Array ? message : new Uint8Array(message);
    let frame: Frame | null;
    try {
      frame = this.#reassembler.push(bytes);
    } catch (error) {
      this.#failReceive(asCodecError(error));
      return;
    }
    if (frame !== null) this.#deliver(frame);
  }

  /** Backpressure cleared: the queue may move again. */
  receiveDrain(): void {
    if (!this.#open || !this.#paused) return;
    this.#paused = false;
    this.#flush();
  }

  /** The socket closed; `4000`–`4999` is a reason code, anything else is the link ending. */
  receiveClose(code: number, reason?: string): void {
    this.#shutdown(code);
    if (!isCloseCode(code)) {
      this.#report({ kind: 'closed' });
      return;
    }
    this.#report({
      kind: 'closed',
      code,
      ...(reason !== undefined && reason !== '' ? { reason } : {}),
    });
  }

  /** The socket failed. WHATWG never precedes a clean 4xxx close with an error. */
  receiveError(error: Error): void {
    this.#shutdown();
    this.#report({ kind: 'closed', reason: error.message });
  }

  /**
   * Emits one frame, or holds it until someone subscribes. Once a frame is
   * waiting every later one queues behind it, so order survives the wait.
   */
  #deliver(frame: Frame): void {
    if (this.#frames.size > 0 && this.#arrivals.length === 0) {
      this.#frames.emit(frame);
      return;
    }
    this.#arrivals.push(frame);
    this.#scheduleArrivals();
  }

  /** Drains on a microtask, never inside `onFrame`: a subscriber may still be constructing. */
  #scheduleArrivals(): void {
    if (this.#flushScheduled || this.#frames.size === 0 || this.#arrivals.length === 0) return;
    this.#flushScheduled = true;
    queueMicrotask(() => {
      this.#flushScheduled = false;
      while (this.#frames.size > 0) {
        const frame = this.#arrivals.shift();
        if (frame === undefined) return;
        this.#frames.emit(frame);
      }
    });
  }

  /** Appends one frame's chunks and pushes as many as the socket will take. */
  #enqueue(messages: readonly Uint8Array[]): void {
    for (const message of messages) {
      this.#queue.push(message);
      this.#queuedBytes += message.byteLength;
    }
    this.#flush();
  }

  #flush(): void {
    while (this.#open && !this.#paused) {
      const message = this.#queue[0];
      if (message === undefined) return;
      const outcome = this.#sink.send(message) ?? 'sent';
      if (outcome === 'dropped') {
        this.#failSend(
          `the socket dropped a ${message.byteLength}-byte chunk; expected it to be sent or buffered`
        );
        return;
      }
      this.#queue.shift();
      this.#queuedBytes -= message.byteLength;
      if (outcome === 'buffered') {
        this.#paused = true;
        break;
      }
    }
    if (this.#paused && this.#queuedBytes > this.maxFrameBytes) {
      this.#failSend(
        `the send queue holds ${this.#queuedBytes} bytes while the socket is not draining; expected at most ${this.maxFrameBytes}`
      );
    }
  }

  /** Best effort: a farewell the codec or the queue refuses must not stop the close. */
  #sendFarewell(code: number, reason?: string): void {
    if (!isCloseCode(code)) return;
    try {
      this.#enqueue(
        encodeChunks(
          { type: 'close', code, ...(reason !== undefined ? { reason } : {}) },
          this.#chunkOptions
        )
      );
    } catch {
      // The socket close code carries the same reason; the frame is optional here.
    }
  }

  /**
   * A send the stream cannot recover from: close with `4400` and say so
   * (§ Backpressure). The closure is reported before the socket is closed,
   * because a socket whose `close` calls its own close handler synchronously
   * would otherwise claim the one closure with a plain `closed`.
   */
  #failSend(reason: string): void {
    this.#shutdown(CLOSE_CODES.PROTOCOL_ERROR);
    this.#report({ kind: 'closed', code: CLOSE_CODES.PROTOCOL_ERROR, reason });
    this.#sink.close(CLOSE_CODES.PROTOCOL_ERROR, clampCloseReason(reason));
  }

  /** A record the decoder refused: close with the code the refusal calls for (§10). */
  #failReceive(error: CodecError): void {
    const code = closeCodeForCodecError(error);
    this.#shutdown(code);
    this.#report({ kind: 'protocol-error', error, code });
    this.#sink.close(code, clampCloseReason(error.message));
  }

  #shutdown(code?: number): void {
    if (!this.#open) return;
    this.#open = false;
    this.#paused = false;
    this.#queue = [];
    this.#queuedBytes = 0;
    this.#arrivals = [];
    this.#closeCode = code;
    this.#reassembler.reset();
    this.#frames.clear();
  }

  /**
   * Delivers a held closure once there is somebody to deliver it to, on a
   * microtask rather than inside `onClosed`, because a subscriber adding
   * itself from a constructor is not finished being built yet.
   */
  #scheduleClosure(): void {
    if (this.#closureScheduled || this.#pendingClosure === undefined) return;
    if (this.#closed.size === 0) return;
    this.#closureScheduled = true;
    queueMicrotask(() => {
      this.#closureScheduled = false;
      const closure = this.#pendingClosure;
      if (closure === undefined) return;
      this.#pendingClosure = undefined;
      this.#report(closure);
    });
  }

  /**
   * At most one closure, and never for a close this side asked for.
   *
   * A closure raised before anyone subscribed is held rather than dropped:
   * the socket is closing from the moment it exists, so a refused upgrade or
   * a peer that hangs up can close it before the `Session` is constructed,
   * and a listener attached afterwards must still learn why. Only the first
   * such closure is kept — it is the one that ended the port.
   */
  #report(closure: PortClosure): void {
    if (this.#reported || this.#ownerClosed) return;
    if (this.#closed.size === 0) {
      this.#pendingClosure ??= closure;
      return;
    }
    this.#reported = true;
    this.#pendingClosure = undefined;
    this.#closed.emit(closure);
    this.#closed.clear();
  }

  #state(): string {
    if (this.#open) return 'open';
    return this.#closeCode === undefined ? 'closed' : `closed with code ${this.#closeCode}`;
  }
}

/** Every refusal the codecs raise is a `CodecError`; anything else is reported as one. */
function asCodecError(error: unknown): CodecError {
  if (error instanceof CodecError) return error;
  const detail = error instanceof Error ? error.message : String(error);
  return new CodecError('schema', `the chunk decoder threw ${detail}; expected a CodecError`);
}

/**
 * Cuts a close reason down to the 123 UTF-8 bytes RFC 6455 allows, on a
 * character boundary, so a long decoder message cannot make the close itself
 * throw.
 */
function clampCloseReason(reason?: string): string | undefined {
  if (reason === undefined) return undefined;
  if (encoder.encode(reason).byteLength <= MAX_CLOSE_REASON_BYTES) return reason;
  let text = reason.slice(0, MAX_CLOSE_REASON_BYTES);
  while (text.length > 0 && encoder.encode(text).byteLength > MAX_CLOSE_REASON_BYTES) {
    text = text.slice(0, -1);
  }
  return text;
}
