import {
  encodeRuntimeFrame,
  RUNTIME_MAX_FRAME_BYTES,
  type RuntimeFrame,
  RuntimeFrameDecoder,
} from '@mangostudio/shared/runtime-protocol';
import type { RuntimeFramePort } from '../transport';

/** Why a stdio port stopped: a peer that hung up, or a record the codec refused. */
export type StdioFramePortClosure =
  | { readonly kind: 'eof' }
  | { readonly kind: 'protocol-error'; readonly error: Error };

export interface StdioFramePortOptions {
  readonly input: NodeJS.ReadableStream;
  readonly output: NodeJS.WritableStream;
  readonly maxFrameBytes?: number;
  /** Fires at most once, and never for an owner-initiated `close()`. */
  readonly onClosed?: (closure: StdioFramePortClosure) => void;
}

/**
 * NDJSON frame port over a pipe pair: one JSON record per line in both
 * directions. A record the codec refuses tears the connection down instead of
 * being skipped — once the stream is desynchronised, every later frame is a
 * guess, and a guess about a filesystem mutation is worse than a failure.
 */
export function createStdioFramePort(options: StdioFramePortOptions): RuntimeFramePort {
  return new StdioFramePort(options);
}

class StdioFramePort implements RuntimeFramePort {
  readonly #decoder: RuntimeFrameDecoder;
  readonly #input: NodeJS.ReadableStream;
  readonly #listeners = new Set<(frame: RuntimeFrame) => void>();
  readonly #maxFrameBytes: number;
  readonly #onClosed: ((closure: StdioFramePortClosure) => void) | undefined;
  readonly #output: NodeJS.WritableStream;
  readonly #onData: (chunk: Buffer | string) => void;
  readonly #onEnd: () => void;
  readonly #onInputError: (error: Error) => void;
  readonly #onOutputError: () => void;
  #closed = false;

  constructor(options: StdioFramePortOptions) {
    this.#input = options.input;
    this.#output = options.output;
    this.#maxFrameBytes = options.maxFrameBytes ?? RUNTIME_MAX_FRAME_BYTES;
    this.#onClosed = options.onClosed;
    this.#decoder = new RuntimeFrameDecoder({ maxFrameBytes: this.#maxFrameBytes });

    this.#onData = (chunk) => this.#receive(chunk);
    this.#onEnd = () => this.#drain();
    this.#onInputError = (error) => this.#tearDown({ kind: 'protocol-error', error });
    // A peer that dies mid-write breaks the pipe. That is the peer hanging up,
    // not a protocol violation, so it reads as EOF.
    this.#onOutputError = () => this.#tearDown({ kind: 'eof' });

    this.#input.on('data', this.#onData);
    this.#input.on('end', this.#onEnd);
    this.#input.on('error', this.#onInputError);
    this.#output.on('error', this.#onOutputError);
  }

  send(frame: RuntimeFrame): void {
    if (this.#closed) throw new Error('Runtime stdio port is closed.');
    this.#output.write(encodeRuntimeFrame(frame, this.#maxFrameBytes));
  }

  onFrame(listener: (frame: RuntimeFrame) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  close(): void {
    this.#dispose();
  }

  #receive(chunk: Buffer | string): void {
    if (this.#closed) return;

    let frames: readonly RuntimeFrame[];
    try {
      frames = this.#decoder.push(chunk);
    } catch (error) {
      this.#tearDown({ kind: 'protocol-error', error: asError(error) });
      return;
    }
    this.#deliver(frames);
  }

  /** Accepts a final record that arrived without its newline, then reports EOF. */
  #drain(): void {
    if (this.#closed) return;

    let frames: readonly RuntimeFrame[];
    try {
      frames = this.#decoder.finish();
    } catch (error) {
      this.#tearDown({ kind: 'protocol-error', error: asError(error) });
      return;
    }
    this.#deliver(frames);
    this.#tearDown({ kind: 'eof' });
  }

  #deliver(frames: readonly RuntimeFrame[]): void {
    for (const frame of frames) {
      // A listener can close the port mid-batch (a teardown response, say);
      // frames decoded before that must not be delivered afterwards.
      if (this.#closed) return;
      for (const listener of this.#listeners) listener(frame);
    }
  }

  #tearDown(closure: StdioFramePortClosure): void {
    if (this.#closed) return;
    this.#dispose();
    this.#onClosed?.(closure);
  }

  #dispose(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#input.off('data', this.#onData);
    this.#input.off('end', this.#onEnd);
    this.#input.off('error', this.#onInputError);
    this.#output.off('error', this.#onOutputError);
    // Releases the handle so a CLI process can exit once the session ends.
    this.#input.pause();
    this.#listeners.clear();
    try {
      this.#output.end();
    } catch {
      // The peer is already gone; there is nothing left to flush.
    }
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
