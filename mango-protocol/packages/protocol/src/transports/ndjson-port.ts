/**
 * The NDJSON port every byte-oriented transport reuses. stdio, the local
 * socket and the spawn launcher differ only in where their bytes come from and
 * go to, so framing, refusal handling and the close sequence live here once.
 *
 * The port owns no operating-system object: it takes a `ByteSink` to write to
 * and is driven by `feed`, `eof` and `failed`. Nothing in this module imports
 * `node:`, which keeps it testable with a plain fake sink.
 */

import { closeCodeForCodecError } from '../close';
import { encodeLine, LineDecoder, resolveFrameLimit } from '../codec/ndjson';
import type { CodecError } from '../errors';
import { Listeners } from '../listeners';
import type { Port, PortClosure } from '../port';
import { CLOSE_REASON_MAX_LENGTH } from '../schemas/common';
import type { CloseFrame, Frame } from '../schemas/frames';

/** Where a port's encoded lines go: one already-framed record at a time. */
export interface ByteSink {
  /** Writes one NDJSON record, terminator included. A throw is a broken pipe. */
  write(bytes: Uint8Array): void;
  /**
   * Ends the writable side and releases whatever the transport holds: the
   * listeners on the readable half, a socket a rude peer never closed, a
   * registration in a listener's table. The port calls it exactly once, on
   * every path that ends the port, so it is the only teardown hook a transport
   * needs. A throw here is swallowed.
   */
  end(): void;
}

export interface NdjsonPortOptions {
  readonly sink: ByteSink;
  /** Largest line the decoder accepts; the 16 MiB default of §11 when absent. */
  readonly maxFrameBytes?: number;
}

/** The port plus the three inputs a transport drives it with. */
export interface NdjsonPortHandle {
  readonly port: Port;
  /** Feeds the next piece of the incoming byte stream. */
  feed(bytes: Uint8Array): void;
  /** The peer stopped writing: end of file, or a socket the peer half-closed. */
  eof(): void;
  /** The transport itself broke: a socket error, a broken pipe, a failed spawn. */
  failed(error: Error): void;
}

/** What the port is doing, and what a refused `send` names in its message. */
type PortState = 'open' | 'closed' | 'protocol-error' | 'ended' | 'failed';

const encoder = new TextEncoder();

/**
 * Builds one NDJSON port over a byte sink.
 *
 * @example
 * const handle = createNdjsonPort({ sink: { write: (b) => socket.write(b), end: () => socket.end() } });
 * socket.on('data', (chunk) => handle.feed(chunk));
 * const session = new Session(handle.port, { peer });
 */
export function createNdjsonPort(options: NdjsonPortOptions): NdjsonPortHandle {
  const port = new NdjsonPort(options);
  return {
    port,
    feed: (bytes) => port.feed(bytes),
    eof: () => port.eof(),
    failed: (error) => port.failed(error),
  };
}

class NdjsonPort implements Port {
  readonly maxFrameBytes: number;
  readonly #sink: ByteSink;
  readonly #decoder: LineDecoder;
  readonly #frames = new Listeners<Frame>();
  readonly #closed = new Listeners<PortClosure>();
  #state: PortState = 'open';
  #why = '';
  #sinkWritable = true;
  #sinkEnded = false;

  constructor(options: NdjsonPortOptions) {
    this.maxFrameBytes = resolveFrameLimit(options);
    this.#sink = options.sink;
    this.#decoder = new LineDecoder({ maxFrameBytes: this.maxFrameBytes });
  }

  send(frame: Frame): void {
    if (this.#state !== 'open') throw this.#closedError();
    const line = encoder.encode(encodeLine(frame, { maxFrameBytes: this.maxFrameBytes }));
    if (!this.#writeLine(line)) throw this.#closedError();
  }

  onFrame(listener: (frame: Frame) => void): () => void {
    return this.#frames.add(listener);
  }

  onClosed(listener: (closure: PortClosure) => void): () => void {
    return this.#closed.add(listener);
  }

  close(code: number, reason?: string): void {
    if (this.#state !== 'open') return;
    this.#state = 'closed';
    this.#why = `closed by this side with ${code}`;
    // The owner asked for this, so the far side is told and no closure is
    // reported back to the owner: `onClosed` is for closures nobody chose.
    this.#writeClose(code, reason);
    this.#endSink();
    this.#frames.clear();
    this.#closed.clear();
  }

  /** Decodes what arrived, delivers whole frames, and ends the stream on a refusal. */
  feed(bytes: Uint8Array): void {
    if (this.#state !== 'open') return;
    const { frames, error } = this.#decoder.push(bytes);
    for (const frame of frames) {
      // A listener may close the port (the session does, on a `close` frame),
      // and everything after that belongs to a stream nobody is reading.
      if (this.#state !== 'open') return;
      this.#frames.emit(frame);
    }
    if (error !== undefined) this.#refuse(error);
  }

  eof(): void {
    if (this.#state !== 'open') return;
    this.#state = 'ended';
    this.#why = 'the peer reached end of file';
    // A record without its terminator is an incomplete frame, not a refusal:
    // end of file is a transport closure and never a protocol error (stdio.md).
    this.#endSink();
    this.#report({ kind: 'closed' });
  }

  failed(error: Error): void {
    if (this.#state !== 'open') return;
    this.#state = 'failed';
    this.#why = error.message;
    this.#endSink();
    // The message is the only thing that tells an operator a broken pipe apart
    // from a peer that left politely; both are a 4000 release to the session.
    this.#report({ kind: 'closed', reason: error.message });
  }

  /** A refused line cannot be resynchronised: say so, tell the peer, stop. */
  #refuse(error: CodecError): void {
    const code = closeCodeForCodecError(error);
    this.#state = 'protocol-error';
    this.#why = error.message;
    this.#writeClose(code, error.message);
    this.#endSink();
    this.#report({ kind: 'protocol-error', error, code });
  }

  #report(closure: PortClosure): void {
    this.#frames.clear();
    this.#closed.emit(closure);
    this.#closed.clear();
  }

  /** True when the line reached the sink; a broken pipe fails the port instead. */
  #writeLine(line: Uint8Array): boolean {
    if (!this.#sinkWritable) return false;
    try {
      this.#sink.write(line);
      return true;
    } catch (cause) {
      this.#sinkWritable = false;
      this.failed(cause instanceof Error ? cause : new Error(String(cause)));
      return false;
    }
  }

  /**
   * Writes the farewell of §10 before the stream ends. It is best effort: the
   * pipe may already be gone, and ending the sink is what matters either way.
   */
  #writeClose(code: number, reason?: string): void {
    if (!this.#sinkWritable) return;
    const frame: CloseFrame = {
      type: 'close',
      code,
      ...(reason !== undefined ? { reason: reason.slice(0, CLOSE_REASON_MAX_LENGTH) } : {}),
    };
    const line = this.#encodeClose(frame);
    if (line === undefined) {
      // The code itself is not one a `close` frame may carry. That does not
      // change what the port does next, and the sink still has to be ended.
      this.#sinkWritable = false;
      return;
    }
    try {
      this.#sink.write(line);
    } catch {
      // The peer is already gone. The sink still has to be ended: that is
      // where the transport releases its handles.
      this.#sinkWritable = false;
    }
  }

  /**
   * The farewell as bytes, dropping its reason if that is what it takes to
   * fit. The reason is capped by characters and JSON escapes one NUL into six
   * bytes, so a schema-valid reason can still outgrow a lowered frame limit —
   * and the code is the part the peer needs. `undefined` means no `close`
   * frame can be encoded at all.
   */
  #encodeClose(frame: CloseFrame): Uint8Array | undefined {
    for (const candidate of [frame, { type: 'close', code: frame.code } as CloseFrame]) {
      try {
        return encoder.encode(encodeLine(candidate, { maxFrameBytes: this.maxFrameBytes }));
      } catch {
        // Try the shorter one; if that fails too, the code is the problem.
      }
    }
    return undefined;
  }

  /** Runs the transport's teardown exactly once, whatever ended the port. */
  #endSink(): void {
    if (this.#sinkEnded) return;
    this.#sinkEnded = true;
    this.#sinkWritable = false;
    try {
      this.#sink.end();
    } catch {
      // The stream is already gone; there is nothing left to release.
    }
  }

  #closedError(): Error {
    return new Error(
      `NDJSON port is in state "${this.#state}" (${this.#why}); expected state "open" to send a frame.`
    );
  }
}
