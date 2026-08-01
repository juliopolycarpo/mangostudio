import {
  encodeRuntimeFrameChunks,
  RUNTIME_MAX_FRAME_BYTES,
  RUNTIME_MAX_TRANSPORT_MESSAGE_BYTES,
  RuntimeChunkReassembler,
  type RuntimeFrame,
  RuntimeFrameCodecError,
} from '@mangostudio/shared/runtime-protocol';
import type { RuntimeFramePort } from '../transport';

/** Why a WebSocket port stopped: the socket went away, or the codec refused a message. */
export type WebSocketFramePortClosure =
  | { readonly kind: 'closed' }
  | { readonly kind: 'protocol-error'; readonly error: Error };

/**
 * What a sink reports back about one message.
 *
 * `backpressure` means the message was accepted into the socket's outgoing
 * buffer but nothing more should be written until it drains; `dropped` means it
 * was not accepted at all, which desynchronises the chunk stream and is
 * therefore fatal to the connection rather than something to retry.
 */
export type WebSocketSendResult = 'sent' | 'backpressure' | 'dropped';

export interface WebSocketFrameSink {
  send(message: Uint8Array): WebSocketSendResult;
}

export interface WebSocketFramePortOptions {
  readonly sink: WebSocketFrameSink;
  readonly maxMessageBytes?: number;
  readonly maxFrameBytes?: number;
  /**
   * Ceiling on chunks waiting for a peer that has stopped reading. Defaults to
   * one whole frame, which is the smallest bound that never refuses a legal
   * send.
   */
  readonly maxQueuedBytes?: number;
  /** Fires at most once, and never for an owner-initiated `close()`. */
  readonly onClosed?: (closure: WebSocketFramePortClosure) => void;
}

export interface WebSocketFramePort extends RuntimeFramePort {
  /** Feeds one message the socket delivered. */
  receive(message: ArrayBuffer | ArrayBufferView | string): void;
  /** Signals that the socket's outgoing buffer drained. */
  handleDrain(): void;
  /** Signals that the socket closed for a reason the owner did not choose. */
  handleSocketClosed(): void;
}

/**
 * A frame port over any WebSocket, in either direction.
 *
 * Frames are chunked so no single message exceeds the socket's payload limit,
 * and every chunk goes through one queue per connection. That queue is not an
 * optimisation: the host resolves requests concurrently, so two oversized
 * responses would otherwise interleave their chunks into a stream neither peer
 * can reassemble.
 */
export function createWebSocketFramePort(options: WebSocketFramePortOptions): WebSocketFramePort {
  return new WebSocketFramePortImpl(options);
}

class WebSocketFramePortImpl implements WebSocketFramePort {
  readonly #listeners = new Set<(frame: RuntimeFrame) => void>();
  readonly #maxFrameBytes: number;
  readonly #maxMessageBytes: number;
  readonly #maxQueuedBytes: number;
  readonly #onClosed: ((closure: WebSocketFramePortClosure) => void) | undefined;
  readonly #queue: Uint8Array[] = [];
  readonly #reassembler: RuntimeChunkReassembler;
  readonly #sink: WebSocketFrameSink;
  #closed = false;
  #paused = false;
  #queuedBytes = 0;

  constructor(options: WebSocketFramePortOptions) {
    this.#sink = options.sink;
    this.#maxMessageBytes = options.maxMessageBytes ?? RUNTIME_MAX_TRANSPORT_MESSAGE_BYTES;
    this.#maxFrameBytes = options.maxFrameBytes ?? RUNTIME_MAX_FRAME_BYTES;
    this.#maxQueuedBytes = options.maxQueuedBytes ?? this.#maxFrameBytes;
    this.#onClosed = options.onClosed;
    this.#reassembler = new RuntimeChunkReassembler({
      maxFrameBytes: this.#maxFrameBytes,
      maxMessageBytes: this.#maxMessageBytes,
    });
  }

  send(frame: RuntimeFrame): void {
    if (this.#closed) throw new Error('Runtime websocket port is closed.');
    // Encoding first, and synchronously, is what lets an oversized result
    // become a typed error response to its own request instead of a rejection
    // nobody is waiting on.
    const chunks = encodeRuntimeFrameChunks(frame, {
      maxMessageBytes: this.#maxMessageBytes,
      maxFrameBytes: this.#maxFrameBytes,
    });

    // A paused queue is a peer that is not reading, and the host answers
    // requests concurrently — so without a ceiling the sender holds every
    // pending response for a socket that may never drain. An empty queue
    // always accepts, so a single maximum frame is never refused for being
    // large; what is refused is piling more on top of one that is not moving.
    const bytes = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
    if (this.#queuedBytes > 0 && this.#queuedBytes + bytes > this.#maxQueuedBytes) {
      this.#tearDown({
        kind: 'protocol-error',
        error: new RuntimeFrameCodecError(
          `Runtime websocket has ${this.#queuedBytes} bytes queued for a peer that is not reading; the connection cannot keep up.`
        ),
      });
      return;
    }

    this.#queue.push(...chunks);
    this.#queuedBytes += bytes;
    this.#pump();
  }

  onFrame(listener: (frame: RuntimeFrame) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  close(): void {
    this.#dispose();
  }

  receive(message: ArrayBuffer | ArrayBufferView | string): void {
    if (this.#closed) return;
    if (typeof message === 'string') {
      // Chunk headers are binary, and a text message cannot carry one. Refusing
      // rather than coercing keeps a peer speaking a different framing from
      // looking like a peer speaking this one badly.
      this.#tearDown({
        kind: 'protocol-error',
        error: new RuntimeFrameCodecError('Runtime websocket messages must be binary.'),
      });
      return;
    }

    let frame: RuntimeFrame | null;
    try {
      frame = this.#reassembler.push(toBytes(message));
    } catch (error) {
      this.#tearDown({ kind: 'protocol-error', error: asError(error) });
      return;
    }
    if (!frame) return;

    for (const listener of [...this.#listeners]) {
      // A listener can close the port while handling a frame — a teardown
      // response, say — and nothing after that has a destination.
      if (this.#closed) return;
      listener(frame);
    }
  }

  handleDrain(): void {
    if (this.#closed) return;
    this.#paused = false;
    this.#pump();
  }

  handleSocketClosed(): void {
    this.#tearDown({ kind: 'closed' });
  }

  #pump(): void {
    while (!this.#closed && !this.#paused && this.#queue.length > 0) {
      const chunk = this.#queue[0];
      if (!chunk) break;
      const result = this.#sink.send(chunk);
      if (result === 'dropped') {
        // Half a frame reached the peer and the rest never will. There is no
        // resynchronisation point in a chunk stream, so the connection ends.
        this.#tearDown({
          kind: 'protocol-error',
          error: new RuntimeFrameCodecError(
            'Runtime websocket dropped a chunk; the frame stream cannot be resumed.'
          ),
        });
        return;
      }
      this.#queue.shift();
      this.#queuedBytes -= chunk.byteLength;
      if (result === 'backpressure') {
        this.#paused = true;
        return;
      }
    }
  }

  #tearDown(closure: WebSocketFramePortClosure): void {
    if (this.#closed) return;
    this.#dispose();
    this.#onClosed?.(closure);
  }

  #dispose(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#queue.length = 0;
    this.#queuedBytes = 0;
    this.#listeners.clear();
    this.#reassembler.reset();
  }
}

/** Bun's server-side socket: a numeric result that distinguishes the three outcomes. */
export interface ServerWebSocketLike {
  send(message: Uint8Array, compress?: boolean): number;
}

/**
 * Adapts a `Bun.serve` socket. It returns the byte count on success, `-1` when
 * the message was buffered under backpressure, and `0` when it was dropped —
 * which, with `closeOnBackpressureLimit` on, is the socket about to close.
 */
export function serverWebSocketSink(socket: ServerWebSocketLike): WebSocketFrameSink {
  return {
    send(message) {
      const result = socket.send(message);
      if (result > 0) return 'sent';
      return result < 0 ? 'backpressure' : 'dropped';
    },
  };
}

/** The WHATWG client socket Bun exposes for an outbound connection. */
export interface ClientWebSocketLike {
  send(message: Uint8Array): void;
  readonly bufferedAmount: number;
}

/**
 * Adapts a dialing client socket. The WHATWG API reports no send outcome and
 * emits no drain event, so every write is reported as sent and the buffer is
 * left to grow: the peer that needs pacing is the hub, whose server sockets
 * close on backpressure, and it is on the other adapter.
 */
export function clientWebSocketSink(socket: ClientWebSocketLike): WebSocketFrameSink {
  return {
    send(message) {
      socket.send(message);
      return 'sent';
    },
  };
}

function toBytes(message: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (ArrayBuffer.isView(message)) {
    return new Uint8Array(message.buffer, message.byteOffset, message.byteLength);
  }
  return new Uint8Array(message);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
