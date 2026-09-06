/**
 * The one write loop both slot writers need.
 *
 * A live update and a local install put the same bytes in the same place; only
 * the transfer differs. Both then prove what landed by hashing it, and that
 * proof is only worth anything if the hash sees what the filesystem *confirmed*
 * rather than what was offered to it.
 */

import type { FileHandle } from 'node:fs/promises';

/** Writes some prefix of `bytes` and reports how many it took. */
export type WriteChunk = (handle: FileHandle, bytes: Uint8Array) => Promise<number>;

const systemWriteChunk: WriteChunk = async (handle, bytes) =>
  (await handle.write(bytes)).bytesWritten;

export interface WriteAllBytesOptions {
  /** Injected for tests; a real short write cannot be provoked on demand. */
  readonly writeChunk?: WriteChunk | undefined;
  /** Called with each slice the filesystem confirmed, in order. */
  readonly onWritten: (confirmed: Uint8Array) => void;
  /** Builds the refusal, so each caller keeps its own typed error. */
  readonly invalidWrite: (written: number, remainingBytes: number) => Error;
}

/**
 * Writes every byte of `bytes`, reporting each confirmed slice as it lands.
 *
 * `FileHandle.write` may resolve having written less than it was given. A
 * caller that ignores `bytesWritten` publishes a truncated file, and a caller
 * that hashes the offered chunk instead of the confirmed one cannot notice:
 * the digest describes the source, not the destination, so it still matches.
 * // Usage: await writeAllBytes(handle, chunk, { onWritten: (s) => hash.update(s), invalidWrite })
 */
export async function writeAllBytes(
  handle: FileHandle,
  bytes: Uint8Array,
  options: WriteAllBytesOptions
): Promise<void> {
  const writeChunk = options.writeChunk ?? systemWriteChunk;
  let offset = 0;
  while (offset < bytes.byteLength) {
    const remaining = bytes.subarray(offset);
    const written = await writeChunk(handle, remaining);
    if (!Number.isSafeInteger(written) || written <= 0 || written > remaining.byteLength) {
      throw options.invalidWrite(written, remaining.byteLength);
    }
    options.onWritten(remaining.subarray(0, written));
    offset += written;
  }
}
