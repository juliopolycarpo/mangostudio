/**
 * Splits one protocol frame across several transport messages.
 *
 * WebSocket payload limits are a property of the server, not of a route: Bun
 * takes one `websocket` option object per `Bun.serve`, and the browser bus
 * pins `maxPayloadLength` to 16 KiB. Raising it to fit a 16 MiB protocol frame
 * would apply to every browser socket too — Bun buffers a whole message before
 * anything validates it, so that is a denial-of-service regression on the bus,
 * not a simplification. Chunking above the socket keeps both limits honest.
 *
 * Each message carries a nine-byte header: a format version, the chunk index,
 * and the chunk count. Chunks of one frame always arrive contiguously because
 * the sender serializes them through a single queue, so the index is a
 * desynchronisation check rather than a reordering buffer — a gap means the
 * stream is no longer trustworthy, and a guess about a filesystem mutation is
 * worse than a failure.
 */

import {
  decodeRuntimeFrameLine,
  encodeRuntimeFrame,
  RUNTIME_MAX_FRAME_BYTES,
  RuntimeFrameCodecError,
} from './codec';
import type { RuntimeFrame } from './schemas';

/** Header format; bumped only if the layout below changes. */
const CHUNK_FORMAT_VERSION = 1;

/** Version byte, then two big-endian uint32s: index and count. */
export const RUNTIME_CHUNK_HEADER_BYTES = 9;

/**
 * Largest transport message a chunk may become. Matches the browser bus's
 * `maxPayloadLength`, which is the constraint that forced this layer.
 */
export const RUNTIME_MAX_TRANSPORT_MESSAGE_BYTES = 16 * 1024;

export interface RuntimeChunkOptions {
  readonly maxMessageBytes?: number;
  readonly maxFrameBytes?: number;
}

/** Encodes one frame as the ordered messages a transport should send. */
export function encodeRuntimeFrameChunks(
  frame: RuntimeFrame,
  options: RuntimeChunkOptions = {}
): Uint8Array[] {
  const maxMessageBytes = options.maxMessageBytes ?? RUNTIME_MAX_TRANSPORT_MESSAGE_BYTES;
  const capacity = maxMessageBytes - RUNTIME_CHUNK_HEADER_BYTES;
  if (capacity <= 0) {
    throw new RuntimeFrameCodecError(
      `Runtime chunk size ${maxMessageBytes} leaves no room for a payload.`
    );
  }

  // `encodeRuntimeFrame` appends the NDJSON terminator, which this framing does
  // not need: the header already says where a record ends, and carrying the
  // newline would let a reassembled buffer read as two records.
  const line = encodeRuntimeFrame(frame, options.maxFrameBytes ?? RUNTIME_MAX_FRAME_BYTES);
  const bytes = new TextEncoder().encode(line.slice(0, -1));
  const count = Math.max(1, Math.ceil(bytes.byteLength / capacity));

  const chunks: Uint8Array[] = [];
  for (let index = 0; index < count; index += 1) {
    const start = index * capacity;
    const payload = bytes.subarray(start, Math.min(start + capacity, bytes.byteLength));
    const message = new Uint8Array(RUNTIME_CHUNK_HEADER_BYTES + payload.byteLength);
    const header = new DataView(message.buffer, message.byteOffset, RUNTIME_CHUNK_HEADER_BYTES);
    header.setUint8(0, CHUNK_FORMAT_VERSION);
    header.setUint32(1, index);
    header.setUint32(5, count);
    message.set(payload, RUNTIME_CHUNK_HEADER_BYTES);
    chunks.push(message);
  }
  return chunks;
}

/**
 * Rebuilds frames from the messages `encodeRuntimeFrameChunks` produced.
 *
 * Two bounds, because a byte cap alone is not one. The accumulated size is
 * bounded by the limit the codec enforces on a whole frame, so a peer cannot
 * spend the hub's memory by never sending a last chunk — but a peer that
 * declares a huge chunk count and then dribbles one byte per message stays
 * under that cap while making the reassembler retain one `Uint8Array` per
 * message, which is memory the byte total never sees. The declared count is
 * therefore checked against the most chunks this framing could ever need for a
 * whole frame, and a header claiming more is refused on arrival.
 */
export class RuntimeChunkReassembler {
  readonly #maxChunks: number;
  readonly #maxFrameBytes: number;
  #expectedIndex = 0;
  #expectedCount = 0;
  #parts: Uint8Array[] = [];
  #pendingBytes = 0;

  constructor(options: RuntimeChunkOptions = {}) {
    this.#maxFrameBytes = options.maxFrameBytes ?? RUNTIME_MAX_FRAME_BYTES;
    const capacity =
      (options.maxMessageBytes ?? RUNTIME_MAX_TRANSPORT_MESSAGE_BYTES) - RUNTIME_CHUNK_HEADER_BYTES;
    this.#maxChunks = capacity > 0 ? Math.ceil(this.#maxFrameBytes / capacity) : 1;
  }

  /** Returns the completed frame, or null while one is still arriving. */
  push(message: Uint8Array): RuntimeFrame | null {
    if (message.byteLength < RUNTIME_CHUNK_HEADER_BYTES) {
      this.#fail('Runtime chunk is shorter than its header.');
    }
    const header = new DataView(message.buffer, message.byteOffset, RUNTIME_CHUNK_HEADER_BYTES);
    if (header.getUint8(0) !== CHUNK_FORMAT_VERSION) {
      this.#fail(`Runtime chunk format ${header.getUint8(0)} is not supported.`);
    }

    const index = header.getUint32(1);
    const count = header.getUint32(5);
    if (count === 0) this.#fail('Runtime chunk claims a frame of zero chunks.');
    if (count > this.#maxChunks) {
      this.#fail(
        `Runtime chunk claims ${count} chunks; at most ${this.#maxChunks} can be a frame.`
      );
    }
    if (index >= count) this.#fail(`Runtime chunk ${index} is outside a ${count}-chunk frame.`);

    if (this.#parts.length === 0) {
      this.#expectedCount = count;
      this.#expectedIndex = 0;
    } else if (count !== this.#expectedCount) {
      this.#fail('Runtime chunk belongs to a different frame than the one in progress.');
    }
    if (index !== this.#expectedIndex) {
      this.#fail(`Runtime chunk ${index} arrived where ${this.#expectedIndex} was expected.`);
    }

    const payload = message.subarray(RUNTIME_CHUNK_HEADER_BYTES);
    this.#pendingBytes += payload.byteLength;
    if (this.#pendingBytes > this.#maxFrameBytes) {
      this.#fail(
        `Runtime frame exceeds the ${this.#maxFrameBytes}-byte limit before its last chunk.`
      );
    }
    this.#parts.push(payload);
    this.#expectedIndex += 1;
    if (this.#expectedIndex < this.#expectedCount) return null;

    const line = new TextDecoder().decode(concat(this.#parts, this.#pendingBytes));
    this.reset();
    return decodeRuntimeFrameLine(line, this.#maxFrameBytes);
  }

  reset(): void {
    this.#expectedIndex = 0;
    this.#expectedCount = 0;
    this.#parts = [];
    this.#pendingBytes = 0;
  }

  #fail(message: string): never {
    this.reset();
    throw new RuntimeFrameCodecError(message);
  }
}

function concat(parts: readonly Uint8Array[], size: number): Uint8Array {
  if (parts.length === 1 && parts[0]) return parts[0];
  const merged = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    merged.set(part, offset);
    offset += part.byteLength;
  }
  return merged;
}
