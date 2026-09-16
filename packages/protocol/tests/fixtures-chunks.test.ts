import { describe, expect, it } from 'bun:test';
import chunks from '../../../spec/fixtures/1/chunks.json';
import {
  CHUNK_HEADER_BYTES,
  type ChunkOptions,
  ChunkReassembler,
  encodeChunks,
} from '../src/codec/chunk';
import type { CodecError, CodecErrorKind } from '../src/errors';
import type { Frame } from '../src/schemas/frames';
import { fromBase64, isSubset, toBase64 } from './support/fixtures';
import { refusalOf } from './support/refusal';

interface ChunkCase {
  readonly name: string;
  readonly verdict: 'accept' | 'reject';
  readonly maxMessageBytes: number;
  readonly maxFrameBytes?: number;
  readonly messages: readonly string[];
  readonly expected?: unknown;
  readonly reason?: string;
  readonly refusedAt?: number;
}

const cases = chunks.cases as readonly ChunkCase[];

function optionsOf(item: ChunkCase): ChunkOptions {
  return item.maxFrameBytes === undefined
    ? { maxMessageBytes: item.maxMessageBytes }
    : { maxMessageBytes: item.maxMessageBytes, maxFrameBytes: item.maxFrameBytes };
}

/** Feeds every message of a case in order and returns the frames completed. */
function reassemble(item: ChunkCase): Frame[] {
  const reassembler = new ChunkReassembler(optionsOf(item));
  const frames: Frame[] = [];
  for (const message of item.messages) {
    const frame = reassembler.push(fromBase64(message));
    if (frame !== null) frames.push(frame);
  }
  return frames;
}

/** The message index at which a reject case throws, and the error it throws. */
function refusalOfCase(item: ChunkCase): { readonly index: number; readonly error: CodecError } {
  const reassembler = new ChunkReassembler(optionsOf(item));
  let index = 0;
  const error = refusalOf(() => {
    for (index = 0; index < item.messages.length; index += 1) {
      reassembler.push(fromBase64(item.messages[index] ?? ''));
    }
  }, item.name);
  return { index, error };
}

/** True when the reference chunker produced the run: every non-final message is full. */
function isReferenceChunked(item: ChunkCase): boolean {
  return item.messages
    .slice(0, -1)
    .every((message) => fromBase64(message).byteLength === item.maxMessageBytes);
}

describe('chunk corpus', () => {
  const accepted = cases.filter((entry) => entry.verdict === 'accept');

  it('reads every case of spec/fixtures/1/chunks.json', () => {
    expect(cases.length).toBeGreaterThan(12);
    expect(accepted.length).toBeGreaterThan(3);
  });

  for (const item of accepted) {
    it(`reassembles ${item.name}`, () => {
      const frames = reassemble(item);

      expect(frames).toHaveLength(1);
      expect(isSubset(item.expected, frames[0])).toBe(true);
      expect(frames[0]).toEqual(item.expected as Frame);
    });
  }

  for (const item of accepted.filter(isReferenceChunked)) {
    it(`re-encodes ${item.name} byte for byte`, () => {
      const messages = encodeChunks(item.expected as Frame, optionsOf(item));

      expect(messages.map(toBase64)).toEqual([...item.messages]);
    });
  }

  it('covers the reference chunker on more than one case', () => {
    expect(accepted.filter(isReferenceChunked).length).toBeGreaterThan(2);
  });

  for (const item of cases.filter((entry) => entry.verdict === 'reject')) {
    it(`refuses ${item.name}`, () => {
      const { index, error } = refusalOfCase(item);

      expect(error.kind).toBe(item.reason as CodecErrorKind);
      expect(index).toBe(item.refusedAt ?? item.messages.length - 1);
    });
  }

  it('leaves the header at nine bytes', () => {
    expect(CHUNK_HEADER_BYTES).toBe(9);
  });
});
