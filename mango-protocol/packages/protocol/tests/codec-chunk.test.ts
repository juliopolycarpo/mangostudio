import { describe, expect, it } from 'bun:test';
import {
  CHUNK_FORMAT_VERSION,
  CHUNK_HEADER_BYTES,
  ChunkReassembler,
  DEFAULT_MAX_MESSAGE_BYTES,
  encodeChunks,
  MIN_MAX_MESSAGE_BYTES,
  MIN_NONFINAL_PAYLOAD_BYTES,
  maxChunksFor,
} from '../src/codec/chunk';
import type { Frame } from '../src/schemas/frames';
import { refusalOf } from './support/refusal';

const encoder = new TextEncoder();
const PING: Frame = { type: 'ping' };

function bulkFrame(bytes: number): Frame {
  return { type: 'req', id: 'bulk', method: 'test.bulk', params: { blob: 'x'.repeat(bytes) } };
}

/** Builds one message by hand, so a test can break exactly one header rule. */
function message(
  version: number,
  index: number,
  count: number,
  payload: Uint8Array,
  headerBytes = CHUNK_HEADER_BYTES
): Uint8Array {
  const bytes = new Uint8Array(headerBytes + payload.byteLength);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, version);
  if (headerBytes >= 5) view.setUint32(1, index);
  if (headerBytes >= 9) view.setUint32(5, count);
  bytes.set(payload, headerBytes);
  return bytes;
}

/** Feeds every message and returns the frames the reassembler completed. */
function reassemble(messages: readonly Uint8Array[], reassembler: ChunkReassembler): Frame[] {
  const frames: Frame[] = [];
  for (const item of messages) {
    const frame = reassembler.push(item);
    if (frame !== null) frames.push(frame);
  }
  return frames;
}

describe('maxChunksFor', () => {
  it('bounds the run by the 1024-byte non-final floor', () => {
    expect(maxChunksFor(16 * 1024 * 1024)).toBe(16384);
    expect(maxChunksFor(4096)).toBe(4);
    expect(maxChunksFor(4097)).toBe(5);
  });
});

describe('encodeChunks', () => {
  it('sends a small frame as one message: header then line', () => {
    const [only, ...rest] = encodeChunks(PING);

    expect(rest).toEqual([]);
    expect(only?.byteLength).toBe(CHUNK_HEADER_BYTES + 15);
    const view = new DataView((only as Uint8Array).buffer);
    expect(view.getUint8(0)).toBe(CHUNK_FORMAT_VERSION);
    expect(view.getUint32(1)).toBe(0);
    expect(view.getUint32(5)).toBe(1);
    expect(new TextDecoder().decode((only as Uint8Array).subarray(CHUNK_HEADER_BYTES))).toBe(
      '{"type":"ping"}'
    );
  });

  it('fills every message but the last to capacity', () => {
    const messages = encodeChunks(bulkFrame(40_000), {
      maxMessageBytes: DEFAULT_MAX_MESSAGE_BYTES,
    });

    expect(messages.length).toBeGreaterThan(2);
    for (const item of messages.slice(0, -1)) {
      expect(item.byteLength).toBe(DEFAULT_MAX_MESSAGE_BYTES);
    }
    expect(messages.at(-1)?.byteLength).toBeLessThanOrEqual(DEFAULT_MAX_MESSAGE_BYTES);
  });

  it('numbers the run 0 to count-1 with one count throughout', () => {
    const messages = encodeChunks(bulkFrame(5000), { maxMessageBytes: MIN_MAX_MESSAGE_BYTES });

    messages.forEach((item, index) => {
      const view = new DataView(item.buffer);
      expect(view.getUint32(1)).toBe(index);
      expect(view.getUint32(5)).toBe(messages.length);
    });
  });

  it('refuses a message ceiling under the floor the spec allows', () => {
    expect(() => encodeChunks(PING, { maxMessageBytes: 2047 })).toThrow(RangeError);
  });

  it('refuses a frame over the frame limit before splitting it', () => {
    expect(refusalOf(() => encodeChunks(bulkFrame(5000), { maxFrameBytes: 4096 })).kind).toBe(
      'too-large'
    );
  });
});

describe('ChunkReassembler', () => {
  it('round trips a frame through its own chunks', () => {
    const frame = bulkFrame(40_000);

    expect(reassemble(encodeChunks(frame), new ChunkReassembler())).toEqual([frame]);
  });

  it('returns null until the final chunk arrives', () => {
    const messages = encodeChunks(bulkFrame(5000), { maxMessageBytes: MIN_MAX_MESSAGE_BYTES });
    const reassembler = new ChunkReassembler();

    for (const item of messages.slice(0, -1)) expect(reassembler.push(item)).toBeNull();
    expect(reassembler.push(messages[messages.length - 1] as Uint8Array)).not.toBeNull();
  });

  it('reassembles a message that is a view into a larger buffer', () => {
    const [only] = encodeChunks(PING);
    const backing = new Uint8Array(64);
    backing.set(only as Uint8Array, 7);
    const view = backing.subarray(7, 7 + (only as Uint8Array).byteLength);

    expect(new ChunkReassembler().push(view)).toEqual(PING);
  });

  it('accepts a non-final payload of exactly 1024 bytes', () => {
    const line = encoder.encode(JSON.stringify(bulkFrame(2000)));
    const messages = [
      message(1, 0, 2, line.subarray(0, MIN_NONFINAL_PAYLOAD_BYTES)),
      message(1, 1, 2, line.subarray(MIN_NONFINAL_PAYLOAD_BYTES)),
    ];

    expect(reassemble(messages, new ChunkReassembler())).toEqual([bulkFrame(2000)]);
  });

  it('refuses a short header, naming both sizes', () => {
    const error = refusalOf(() => new ChunkReassembler().push(new Uint8Array(5)));

    expect(error.kind).toBe('chunk-header');
    expect(error.message).toContain('message is 5 bytes');
    expect(error.message).toContain('9-byte chunk header');
  });

  it('refuses another format version', () => {
    const error = refusalOf(() =>
      new ChunkReassembler().push(message(2, 0, 1, encoder.encode('{"type":"ping"}')))
    );

    expect(error.kind).toBe('chunk-version');
    expect(error.message).toContain('version is 2');
  });

  it('refuses a count of zero and a count over the bound', () => {
    expect(
      refusalOf(() => new ChunkReassembler().push(message(1, 0, 0, new Uint8Array(1)))).kind
    ).toBe('chunk-count');

    const error = refusalOf(() =>
      new ChunkReassembler({ maxFrameBytes: 4096 }).push(
        message(1, 0, 5, new Uint8Array(MIN_NONFINAL_PAYLOAD_BYTES))
      )
    );
    expect(error.kind).toBe('chunk-count');
    expect(error.message).toContain('expected 1 to 4');
  });

  it('refuses an index that is not the one expected', () => {
    const error = refusalOf(() =>
      new ChunkReassembler().push(message(1, 1, 1, encoder.encode('{"type":"ping"}')))
    );

    expect(error.kind).toBe('chunk-index');
    expect(error.message).toContain('expected 0');
  });

  it('refuses a gap in the run', () => {
    const messages = encodeChunks(bulkFrame(40_000));
    const reassembler = new ChunkReassembler();
    reassembler.push(messages[0] as Uint8Array);

    const error = refusalOf(() => reassembler.push(messages[2] as Uint8Array));

    expect(error.kind).toBe('chunk-index');
    expect(error.message).toContain('expected 1');
  });

  it('refuses a count that changed mid-frame', () => {
    const messages = encodeChunks(bulkFrame(40_000));
    const reassembler = new ChunkReassembler();
    reassembler.push(messages[0] as Uint8Array);

    const error = refusalOf(() =>
      reassembler.push(message(1, 1, 4, new Uint8Array(MIN_NONFINAL_PAYLOAD_BYTES)))
    );

    expect(error.kind).toBe('chunk-count');
    expect(error.message).toContain('the count the frame started with');
  });

  it('refuses a chunk with no payload', () => {
    const error = refusalOf(() => new ChunkReassembler().push(message(1, 0, 1, new Uint8Array(0))));

    expect(error.kind).toBe('empty');
  });

  it('refuses a non-final chunk under the 1024-byte floor', () => {
    const error = refusalOf(() =>
      new ChunkReassembler().push(message(1, 0, 2, new Uint8Array(MIN_NONFINAL_PAYLOAD_BYTES - 1)))
    );

    expect(error.kind).toBe('chunk-dribble');
    expect(error.message).toContain('1023 payload bytes');
  });

  it('refuses the accumulated payload as soon as it passes the frame limit', () => {
    const messages = encodeChunks(bulkFrame(5000), { maxMessageBytes: MIN_MAX_MESSAGE_BYTES });
    const reassembler = new ChunkReassembler({ maxFrameBytes: 4096 });

    const error = refusalOf(() => reassemble(messages, reassembler));

    expect(error.kind).toBe('too-large');
  });

  it('refuses a reassembled line that is not a frame, carrying its type', () => {
    const error = refusalOf(() =>
      new ChunkReassembler().push(message(1, 0, 1, encoder.encode('{"type":"nope"}')))
    );

    expect(error.kind).toBe('schema');
    expect(error.frameType).toBe('nope');
  });

  it('drops a partly reassembled frame on a refusal and on reset', () => {
    const messages = encodeChunks(bulkFrame(40_000));
    const reassembler = new ChunkReassembler();

    reassembler.push(messages[0] as Uint8Array);
    expect(refusalOf(() => reassembler.push(new Uint8Array(4))).kind).toBe('chunk-header');
    expect(reassemble(messages, reassembler)).toEqual([bulkFrame(40_000)]);

    reassembler.push(messages[0] as Uint8Array);
    reassembler.reset();
    expect(reassemble(messages, reassembler)).toEqual([bulkFrame(40_000)]);
  });
});
