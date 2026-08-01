import { describe, expect, it } from 'bun:test';
import {
  encodeRuntimeFrameChunks,
  RUNTIME_CHUNK_HEADER_BYTES,
  RUNTIME_MAX_TRANSPORT_MESSAGE_BYTES,
  RuntimeChunkReassembler,
  type RuntimeFrame,
  RuntimeFrameCodecError,
} from '../../src/runtime-protocol';

function responseOf(size: number): RuntimeFrame {
  return { type: 'res', id: 'req-1', ok: { blob: 'x'.repeat(size) } };
}

function reassemble(chunks: readonly Uint8Array[]): RuntimeFrame | null {
  const reassembler = new RuntimeChunkReassembler();
  let frame: RuntimeFrame | null = null;
  for (const chunk of chunks) frame = reassembler.push(chunk);
  return frame;
}

describe('runtime frame chunking', () => {
  it('sends a small frame as one message and rebuilds it', () => {
    const frame: RuntimeFrame = { type: 'ping' };
    const chunks = encodeRuntimeFrameChunks(frame);

    expect(chunks).toHaveLength(1);
    expect(reassemble(chunks)).toEqual(frame);
  });

  it('keeps every message inside the transport limit', () => {
    const chunks = encodeRuntimeFrameChunks(responseOf(200_000));

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.byteLength).toBeLessThanOrEqual(RUNTIME_MAX_TRANSPORT_MESSAGE_BYTES);
      expect(chunk.byteLength).toBeGreaterThan(RUNTIME_CHUNK_HEADER_BYTES);
    }
  });

  it('splits on byte boundaries, not character ones', () => {
    // A four-byte code point sitting exactly where a chunk ends would be torn
    // in half by any splitter that counts UTF-16 units.
    const frame: RuntimeFrame = { type: 'res', id: 'req-1', ok: { text: '🥭'.repeat(4_000) } };
    const chunks = encodeRuntimeFrameChunks(frame, { maxMessageBytes: 64 });

    expect(chunks.length).toBeGreaterThan(1);
    expect(reassemble(chunks)).toEqual(frame);
  });

  it('round-trips a frame at the top of the size range', () => {
    const frame = responseOf(2 * 1024 * 1024);

    expect(reassemble(encodeRuntimeFrameChunks(frame))).toEqual(frame);
  });

  it('refuses a frame past the codec limit before any message is produced', () => {
    expect(() => encodeRuntimeFrameChunks(responseOf(16 * 1024 * 1024 + 1))).toThrow(
      RuntimeFrameCodecError
    );
  });

  it('refuses a chunk size that leaves no room for a payload', () => {
    expect(() =>
      encodeRuntimeFrameChunks({ type: 'ping' }, { maxMessageBytes: RUNTIME_CHUNK_HEADER_BYTES })
    ).toThrow(RuntimeFrameCodecError);
  });
});

describe('runtime chunk reassembly', () => {
  it('reports nothing until the last chunk arrives', () => {
    const reassembler = new RuntimeChunkReassembler();
    const chunks = encodeRuntimeFrameChunks(responseOf(100_000));

    for (const chunk of chunks.slice(0, -1)) {
      expect(reassembler.push(chunk)).toBeNull();
    }
    expect(reassembler.push(chunks[chunks.length - 1] as Uint8Array)).not.toBeNull();
  });

  it('refuses a chunk that arrives out of order', () => {
    const reassembler = new RuntimeChunkReassembler();
    const chunks = encodeRuntimeFrameChunks(responseOf(100_000));

    reassembler.push(chunks[0] as Uint8Array);
    expect(() => reassembler.push(chunks[2] as Uint8Array)).toThrow(RuntimeFrameCodecError);
  });

  it('refuses chunks from a second frame interleaved into the first', () => {
    const reassembler = new RuntimeChunkReassembler();
    const first = encodeRuntimeFrameChunks(responseOf(100_000));
    const second = encodeRuntimeFrameChunks(responseOf(300_000));

    reassembler.push(first[0] as Uint8Array);
    expect(() => reassembler.push(second[1] as Uint8Array)).toThrow(RuntimeFrameCodecError);
  });

  it('refuses an unknown chunk format', () => {
    const [chunk] = encodeRuntimeFrameChunks({ type: 'ping' });
    const tampered = new Uint8Array(chunk as Uint8Array);
    tampered[0] = 99;

    expect(() => new RuntimeChunkReassembler().push(tampered)).toThrow(RuntimeFrameCodecError);
  });

  it('refuses a message shorter than its header', () => {
    expect(() => new RuntimeChunkReassembler().push(new Uint8Array(4))).toThrow(
      RuntimeFrameCodecError
    );
  });

  it('bounds a frame that never sends its last chunk', () => {
    // A peer that keeps claiming more chunks must not be able to spend the
    // hub's memory: the accumulated size is capped by the same frame limit.
    const reassembler = new RuntimeChunkReassembler({ maxFrameBytes: 32 * 1024 });
    const chunks = encodeRuntimeFrameChunks(responseOf(100_000));

    expect(() => {
      for (const chunk of chunks) reassembler.push(chunk);
    }).toThrow(RuntimeFrameCodecError);
  });

  it('refuses a chunk count no frame this size could need', () => {
    // The byte cap alone is not a bound on memory. A peer that declares four
    // billion chunks and then dribbles one byte per message stays far under
    // 16 MiB while making the reassembler retain one array per message, so the
    // count is checked against what this framing could ever produce.
    const reassembler = new RuntimeChunkReassembler();
    const message = new Uint8Array(RUNTIME_CHUNK_HEADER_BYTES + 1);
    const header = new DataView(message.buffer);
    header.setUint8(0, 1);
    header.setUint32(1, 0);
    header.setUint32(5, 0xff_ff_ff_ff);

    expect(() => reassembler.push(message)).toThrow(RuntimeFrameCodecError);
  });

  it('still accepts the most chunks a legal frame can take', () => {
    // The bound has to sit above the real worst case, or a maximum-size frame
    // would be refused as an attack.
    const maxFrameBytes = 128 * 1024;
    const reassembler = new RuntimeChunkReassembler({ maxFrameBytes });
    const chunks = encodeRuntimeFrameChunks(responseOf(maxFrameBytes - 1_000), { maxFrameBytes });

    let frame: RuntimeFrame | null = null;
    for (const chunk of chunks) frame = reassembler.push(chunk);
    expect(chunks.length).toBeGreaterThan(1);
    expect(frame).not.toBeNull();
  });

  it('recovers for the next frame after refusing one', () => {
    const reassembler = new RuntimeChunkReassembler();
    const partial = encodeRuntimeFrameChunks(responseOf(100_000));
    reassembler.push(partial[0] as Uint8Array);
    expect(() => reassembler.push(partial[3] as Uint8Array)).toThrow(RuntimeFrameCodecError);

    const frame: RuntimeFrame = { type: 'pong' };
    expect(reassembler.push(encodeRuntimeFrameChunks(frame)[0] as Uint8Array)).toEqual(frame);
  });
});
