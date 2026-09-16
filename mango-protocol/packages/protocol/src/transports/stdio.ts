/**
 * The stdio transport of spec/transports/stdio.md: frames in on standard
 * input, frames out on standard output, diagnostics on standard error.
 *
 * This is the transport a spawned child speaks, and the one every launcher
 * (SSH, WSL, containers) reduces to.
 */

import type { Port } from '../port';
import { createStreamPort } from './node-stream';

export interface StdioPortOptions {
  /** Where frames arrive; `process.stdin` by default. */
  readonly input?: NodeJS.ReadableStream;
  /** Where frames go; `process.stdout` by default. Nothing else may write to it. */
  readonly output?: NodeJS.WritableStream;
  /** Largest line the decoder accepts; the 16 MiB default of §11 when absent. */
  readonly maxFrameBytes?: number;
}

/**
 * Opens a port over a pair of byte streams, standard input and standard output
 * by default.
 *
 * The streams are read and written as bytes, never as text: a chunk boundary
 * inside a multi-byte character must not corrupt a frame. End of file and a
 * broken pipe are closures, never protocol errors. Closing the port releases
 * the input, so a peer whose session ended can exit on its own.
 *
 * @example
 * const session = new Session(stdioPort(), { peer: { name: 'runtime', version: '1', role: 'runtime' } });
 */
export function stdioPort(options: StdioPortOptions = {}): Port {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  return createStreamPort(input, output, {
    ...(options.maxFrameBytes !== undefined ? { maxFrameBytes: options.maxFrameBytes } : {}),
  }).port;
}
