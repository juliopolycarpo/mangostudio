import { describe, expect, it } from 'bun:test';

import { SNAPSHOT_CHUNK_MAX_BYTES } from '@mangostudio/shared/runtime-contract';

import {
  pullStagedChunks,
  type StagedChunkSource,
} from '../../../../src/services/tools/file-mutation-snapshot';

const MIB = 1024 * 1024;

interface RecordedRead {
  readonly offset: number;
  readonly length: number;
}

/**
 * A runtime holding one staged capture, with a hook to misbehave: `reply` turns
 * each request into the number of bytes it answers with, defaulting to what was
 * asked for, and `contentLength` caps the capture at what it really holds.
 */
class ScriptedStagedCapture implements StagedChunkSource {
  readonly reads: RecordedRead[] = [];

  constructor(
    private readonly reply: (request: RecordedRead) => number = (request) => request.length,
    private readonly contentLength = Number.POSITIVE_INFINITY
  ) {}

  readonly snapshot = {
    readChunk: (params: { stagedId: string; offset: number; length: number }) => {
      this.reads.push({ offset: params.offset, length: params.length });
      const available = Math.max(0, this.contentLength - params.offset);
      const answered = Math.min(this.reply(params), available);
      return Promise.resolve({ contentBase64: Buffer.alloc(answered, 1).toString('base64') });
    },
  };
}

async function drain(chunks: AsyncIterable<Uint8Array>): Promise<number> {
  let total = 0;
  for await (const chunk of chunks) total += chunk.byteLength;
  return total;
}

async function failureOf(chunks: AsyncIterable<Uint8Array>): Promise<string> {
  try {
    await drain(chunks);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return '(the pull finished without an error)';
}

describe('pullStagedChunks', () => {
  it('reads a capture whole, asking for no more than is left', async () => {
    const size = 2 * SNAPSHOT_CHUNK_MAX_BYTES + 17;
    const capture = new ScriptedStagedCapture(undefined, size);

    expect(await drain(pullStagedChunks(capture, 'stage-1', size, 8 * MIB))).toBe(size);

    expect(capture.reads).toEqual([
      { offset: 0, length: SNAPSHOT_CHUNK_MAX_BYTES },
      { offset: SNAPSHOT_CHUNK_MAX_BYTES, length: SNAPSHOT_CHUNK_MAX_BYTES },
      { offset: 2 * SNAPSHOT_CHUNK_MAX_BYTES, length: 17 },
    ]);
  });

  it('refuses a capture that reports more than the limit, before reading a byte', async () => {
    const capture = new ScriptedStagedCapture();

    const message = await failureOf(pullStagedChunks(capture, 'stage-2', 10 * MIB, 3 * MIB));

    expect(message).toBe(
      `staged capture stage-2 reports ${10 * MIB} bytes, past the ${3 * MIB}-byte checkpoint limit`
    );
    expect(capture.reads).toEqual([]);
  });

  it('stops at the limit when the runtime does not report a size and never runs dry', async () => {
    const capture = new ScriptedStagedCapture();

    expect(await drain(pullStagedChunks(capture, 'stage-3', undefined, 3 * MIB))).toBe(3 * MIB);

    expect(capture.reads).toHaveLength(3);
  });

  it('refuses a chunk longer than the one it asked for', async () => {
    const capture = new ScriptedStagedCapture((request) => request.length + 1);

    const message = await failureOf(pullStagedChunks(capture, 'stage-4', 3 * MIB, 8 * MIB));

    expect(message).toBe(
      `staged capture stage-4 returned ${SNAPSHOT_CHUNK_MAX_BYTES + 1} bytes at offset 0, ` +
        `but ${SNAPSHOT_CHUNK_MAX_BYTES} were requested`
    );
  });

  it('refuses an oversized final chunk that would push the total past the reported size', async () => {
    const size = SNAPSHOT_CHUNK_MAX_BYTES + 10;
    // Honest for the first slice, then a full slice where only 10 bytes remain.
    const capture = new ScriptedStagedCapture((request) =>
      request.offset === 0 ? request.length : SNAPSHOT_CHUNK_MAX_BYTES
    );

    const message = await failureOf(pullStagedChunks(capture, 'stage-5', size, 8 * MIB));

    expect(message).toBe(
      `staged capture stage-5 returned ${SNAPSHOT_CHUNK_MAX_BYTES} bytes at offset ${SNAPSHOT_CHUNK_MAX_BYTES}, ` +
        'but 10 were requested'
    );
  });

  it('reports a capture that ends before its reported size instead of finishing quietly', async () => {
    const capture = new ScriptedStagedCapture(undefined, SNAPSHOT_CHUNK_MAX_BYTES);

    const message = await failureOf(pullStagedChunks(capture, 'stage-6', 3 * MIB, 8 * MIB));

    expect(message).toBe(
      `staged capture stage-6 ended at offset ${SNAPSHOT_CHUNK_MAX_BYTES}, before its reported ${3 * MIB} bytes`
    );
  });
});
