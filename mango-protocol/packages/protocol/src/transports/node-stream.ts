/**
 * One NDJSON port over a pair of Node streams. stdio, the local socket and the
 * spawn launcher all reduce to this: a readable half that feeds the decoder, a
 * writable half that takes the encoded lines, and one teardown that releases
 * both when the port ends.
 *
 * The streams are typed through the ambient `NodeJS` namespace rather than
 * `node:stream`, so a caller may pass `process.stdout`, a `net.Socket` or a
 * `PassThrough` without a cast.
 */

import { createNdjsonPort, type NdjsonPortHandle } from './ndjson-port';

const encoder = new TextEncoder();

export interface StreamPortOptions {
  /** Largest line the decoder accepts; the 16 MiB default of §11 when absent. */
  readonly maxFrameBytes?: number;
  /**
   * Extra teardown, run once when the port ends: destroying a socket the peer
   * never closed, dropping a registration, reaping a child.
   */
  readonly onRelease?: () => void;
}

/**
 * Builds the port for one pair of streams and returns the handle, so a
 * transport that observes more than the streams (a launcher watching the
 * child's exit) can still report a closure.
 *
 * Ending the port ends the writable half, detaches every listener from the
 * readable half and pauses it, which is what lets the process exit and the
 * operating-system handle go.
 *
 * @example
 * const handle = createStreamPort(socket, socket, { onRelease: () => socket.destroy() });
 * const session = new Session(handle.port, { peer });
 */
export function createStreamPort(
  readable: NodeJS.ReadableStream,
  writable: NodeJS.WritableStream,
  options: StreamPortOptions = {}
): NdjsonPortHandle {
  let detach = (): void => undefined;
  const handle = createNdjsonPort({
    sink: {
      write: (bytes) => writeTo(writable, bytes),
      end: () => {
        detach();
        endWritable(writable);
        options.onRelease?.();
      },
    },
    ...(options.maxFrameBytes !== undefined ? { maxFrameBytes: options.maxFrameBytes } : {}),
  });
  detach = readFramesFrom(readable, handle);
  // A duplex reports its write errors on the same object; two separate streams
  // need the writable watched too, or an EPIPE becomes an uncaught exception.
  if (!isSameStream(readable, writable)) reportStreamErrors(writable, handle);
  return handle;
}

/** True when both halves are one duplex object, as a socket's are. */
function isSameStream(readable: object, writable: object): boolean {
  return readable === writable;
}

/**
 * Drives a port from a readable stream and returns the function that stops
 * doing so. Every chunk is fed to the decoder, end of file is a closure, and a
 * stream error fails the port instead of becoming an uncaught exception.
 *
 * @example
 * const detach = readFramesFrom(child.stdout, handle);
 */
export function readFramesFrom(
  stream: NodeJS.ReadableStream,
  handle: NdjsonPortHandle
): () => void {
  const onData = (chunk: unknown): void => handle.feed(toBytes(chunk));
  const onEnd = (): void => handle.eof();
  const onError = (cause: unknown): void => handle.failed(asError(cause));
  stream.on('data', onData);
  stream.on('end', onEnd);
  // A stream destroyed without an error (a peer that vanished, a socket reset
  // the platform reports as nothing at all) emits `close` and no `end`.
  stream.on('close', onEnd);
  stream.on('error', onError);
  return () => {
    stream.removeListener('data', onData);
    stream.removeListener('end', onEnd);
    stream.removeListener('close', onEnd);
    // `error` stays: a stream torn down at the same moment as its peer still
    // emits a late EPIPE, and an unlistened `error` event is fatal. The port
    // ignores it, having already closed.
    // Nothing reads this stream any more, and a flowing one keeps the event
    // loop alive: a process whose port closed has to be able to exit.
    stream.pause();
  };
}

/**
 * Reports a writable stream's errors as a port closure. A pipe whose reader is
 * gone emits `EPIPE`, and an unlistened `error` event would crash the process.
 *
 * @example
 * reportStreamErrors(process.stdout, handle);
 */
export function reportStreamErrors(stream: NodeJS.EventEmitter, handle: NdjsonPortHandle): void {
  stream.on('error', (cause: unknown) => handle.failed(asError(cause)));
}

/**
 * Writes one record, refusing a stream that can no longer take it. A destroyed
 * or ended stream reports the write differently on every runtime (a throw, an
 * async `error`, a silent drop); refusing here makes it one thing, and the port
 * turns it into a closure.
 *
 * @example
 * writeTo(socket, encoder.encode('{"type":"ping"}\n'));
 */
export function writeTo(stream: NodeJS.WritableStream, bytes: Uint8Array): void {
  if (!stream.writable) {
    throw new Error(
      'the stream is not writable; expected an open pipe, received one that ended or was destroyed'
    );
  }
  // The operating-system pipe buffer is the only flow control this transport
  // has (stdio.md, Backpressure); a false return is Node buffering for us.
  stream.write(bytes);
}

/** Ends a writable half once, tolerating one that already ended. */
function endWritable(stream: NodeJS.WritableStream): void {
  if (stream.writable) stream.end();
}

/**
 * One stream chunk as plain bytes. A `Buffer` is re-viewed as a `Uint8Array`
 * because `Buffer.prototype.slice` aliases Node's shared read pool, where
 * `Uint8Array.prototype.slice` copies.
 *
 * @example
 * toBytes(Buffer.from('{"type":"ping"}\n'));
 */
export function toBytes(chunk: unknown): Uint8Array {
  if (typeof chunk === 'string') return encoder.encode(chunk);
  if (ArrayBuffer.isView(chunk)) {
    return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  }
  throw new TypeError(
    `stream chunk is ${typeof chunk}; expected a Buffer, a Uint8Array or a string (the stream must not be in object mode)`
  );
}

/**
 * The `Error` behind an event argument, so a port always fails with something
 * that carries a message.
 *
 * @example
 * asError('ECONNRESET').message; // 'ECONNRESET'
 */
export function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}
