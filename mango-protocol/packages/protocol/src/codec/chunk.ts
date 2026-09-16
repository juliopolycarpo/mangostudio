/**
 * The chunk framing of spec/transports/websocket.md: one frame becomes a
 * contiguous run of binary messages, each a nine-byte header followed by a
 * slice of the frame's NDJSON line.
 *
 * | Offset | Size | Field                            |
 * | ------ | ---- | -------------------------------- |
 * | 0      | 1    | Format version, `1`              |
 * | 1      | 4    | Chunk index, unsigned big-endian |
 * | 5      | 4    | Chunk count, unsigned big-endian |
 * | 9      | …    | Payload                          |
 */

import { CodecError } from '../errors';
import type { Frame } from '../schemas/frames';
import { resolveIntegerAtLeast } from './limits';
import { decodeLine, encodeFrameBytes, resolveFrameLimit } from './ndjson';

/** Version, index and count: the header every chunk carries. */
export const CHUNK_HEADER_BYTES = 9;

/** The only chunk format version wire 1 defines. */
export const CHUNK_FORMAT_VERSION = 1;

/** Message ceiling that is safe on a server shared with browser sockets. */
export const DEFAULT_MAX_MESSAGE_BYTES = 16 * 1024;

/** Smallest message ceiling a sender may choose. */
export const MIN_MAX_MESSAGE_BYTES = 2048;

/** Payload every chunk but the last MUST carry, so a receiver can bound the count. */
export const MIN_NONFINAL_PAYLOAD_BYTES = 1024;

/** How one frame is split into messages, and how large it may be. */
export interface ChunkOptions {
  readonly maxMessageBytes?: number;
  readonly maxFrameBytes?: number;
}

/**
 * The most messages one frame can need under a frame limit, the bound a
 * receiver checks `count` against: `ceil(maxFrameBytes / 1024)`.
 *
 * @example
 * maxChunksFor(16 * 1024 * 1024); // 16384
 */
export function maxChunksFor(maxFrameBytes: number): number {
  return Math.ceil(maxFrameBytes / MIN_NONFINAL_PAYLOAD_BYTES);
}

function resolveMessageCeiling(options?: ChunkOptions): number {
  return resolveIntegerAtLeast(
    'maxMessageBytes',
    options?.maxMessageBytes,
    DEFAULT_MAX_MESSAGE_BYTES,
    MIN_MAX_MESSAGE_BYTES
  );
}

/** One binary message: the header, then this slice of the frame's line. */
function chunkMessage(index: number, count: number, payload: Uint8Array): Uint8Array {
  const message = new Uint8Array(CHUNK_HEADER_BYTES + payload.byteLength);
  const view = new DataView(message.buffer, message.byteOffset, message.byteLength);
  view.setUint8(0, CHUNK_FORMAT_VERSION);
  view.setUint32(1, index);
  view.setUint32(5, count);
  message.set(payload, CHUNK_HEADER_BYTES);
  return message;
}

/**
 * Splits one frame into the messages a WebSocket sends for it. Every message
 * but the last is filled to capacity, so the run is as short as the ceiling
 * allows and every non-final payload clears the 1024-byte floor.
 *
 * @example
 * encodeChunks({ type: 'ping' }); // one 24-byte message
 */
export function encodeChunks(frame: Frame, options?: ChunkOptions): Uint8Array[] {
  const capacity = resolveMessageCeiling(options) - CHUNK_HEADER_BYTES;
  const bytes = encodeFrameBytes(frame, options);
  const count = Math.max(1, Math.ceil(bytes.byteLength / capacity));
  const messages: Uint8Array[] = [];
  for (let index = 0; index < count; index += 1) {
    const start = index * capacity;
    const payload = bytes.subarray(start, Math.min(start + capacity, bytes.byteLength));
    messages.push(chunkMessage(index, count, payload));
  }
  return messages;
}

/**
 * Reassembles the messages of one frame, in order, and decodes the line they
 * carry. Every refusal of spec/transports/websocket.md throws a `CodecError`
 * and resets the reassembler, because the stream cannot be resynchronised: the
 * transport closes with `4400`.
 *
 * @example
 * const reassembler = new ChunkReassembler();
 * for (const message of messages) {
 *   const frame = reassembler.push(message);
 *   if (frame !== null) handle(frame);
 * }
 */
export class ChunkReassembler {
  readonly #frameLimit: number;
  readonly #maxChunks: number;
  #expectedIndex = 0;
  #count = 0;
  #size = 0;
  #parts: Uint8Array[] = [];

  /** Only the frame limit matters here; the message ceiling is a sender setting. */
  constructor(options?: ChunkOptions) {
    this.#frameLimit = resolveFrameLimit(options);
    this.#maxChunks = maxChunksFor(this.#frameLimit);
  }

  /** Accepts one message and returns the frame it completed, or `null`. */
  push(message: Uint8Array): Frame | null {
    try {
      return this.#accept(message);
    } catch (error) {
      this.reset();
      throw error;
    }
  }

  /** Drops a partly reassembled frame, after a refusal or a transport reset. */
  reset(): void {
    this.#expectedIndex = 0;
    this.#count = 0;
    this.#size = 0;
    this.#parts = [];
  }

  #accept(message: Uint8Array): Frame | null {
    const { index, count } = this.#readHeader(message);
    const payload = message.subarray(CHUNK_HEADER_BYTES);
    const size = this.#size + payload.byteLength;
    if (size > this.#frameLimit) {
      throw new CodecError(
        'too-large',
        `reassembled frame is ${size} bytes at chunk ${index}; expected at most ${this.#frameLimit}`
      );
    }
    if (payload.byteLength === 0) {
      throw new CodecError(
        'empty',
        `chunk ${index} of ${count} carries no payload; expected at least one byte`
      );
    }
    const final = index === count - 1;
    if (!final && payload.byteLength < MIN_NONFINAL_PAYLOAD_BYTES) {
      throw new CodecError(
        'chunk-dribble',
        `chunk ${index} of ${count} carries ${payload.byteLength} payload bytes; expected at least ${MIN_NONFINAL_PAYLOAD_BYTES} on a non-final chunk`
      );
    }

    this.#count = count;
    this.#size = size;
    this.#expectedIndex = index + 1;
    this.#parts.push(payload.slice());
    if (!final) return null;

    const line = concatParts(this.#parts, this.#size);
    this.reset();
    return decodeLine(line, { maxFrameBytes: this.#frameLimit });
  }

  /** Reads and checks the nine-byte header, in the refusal order of the transport spec. */
  #readHeader(message: Uint8Array): { readonly index: number; readonly count: number } {
    if (message.byteLength < CHUNK_HEADER_BYTES) {
      throw new CodecError(
        'chunk-header',
        `message is ${message.byteLength} bytes; expected at least the ${CHUNK_HEADER_BYTES}-byte chunk header`
      );
    }
    const view = new DataView(message.buffer, message.byteOffset, message.byteLength);
    const version = view.getUint8(0);
    if (version !== CHUNK_FORMAT_VERSION) {
      throw new CodecError(
        'chunk-version',
        `chunk format version is ${version}; expected ${CHUNK_FORMAT_VERSION}`
      );
    }
    const index = view.getUint32(1);
    const count = view.getUint32(5);
    if (count < 1 || count > this.#maxChunks) {
      throw new CodecError(
        'chunk-count',
        `chunk count is ${count}; expected 1 to ${this.#maxChunks} under a ${this.#frameLimit}-byte frame limit`
      );
    }
    if (index !== this.#expectedIndex) {
      throw new CodecError(
        'chunk-index',
        `chunk index is ${index}; expected ${this.#expectedIndex} next in this frame`
      );
    }
    if (this.#count !== 0 && count !== this.#count) {
      throw new CodecError(
        'chunk-count',
        `chunk count is ${count} at index ${index}; expected ${this.#count}, the count the frame started with`
      );
    }
    return { index, count };
  }
}

function concatParts(parts: readonly Uint8Array[], size: number): Uint8Array {
  const line = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    line.set(part, offset);
    offset += part.byteLength;
  }
  return line;
}
