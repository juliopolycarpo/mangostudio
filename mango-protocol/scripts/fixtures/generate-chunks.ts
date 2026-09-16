/**
 * Generates `spec/fixtures/1/chunks.json`, the WebSocket chunk-framing corpus.
 *
 * Chunk messages are binary, so the corpus is produced by this reference
 * encoder rather than typed by hand. The committed file is the fixture; CI
 * regenerates it and fails when the output differs, so an edit here is a
 * deliberate corpus change.
 *
 * @example
 * bun ./scripts/fixtures/generate-chunks.ts          # rewrite the file
 * bun ./scripts/fixtures/generate-chunks.ts --check  # exit 1 when stale
 */

const HEADER_BYTES = 9;
const FORMAT_VERSION = 1;
const MIN_NONFINAL_PAYLOAD = 1024;
const DEFAULT_MESSAGE_BYTES = 16 * 1024;

import { fileURLToPath } from 'node:url';

const OUTPUT = new URL('../../spec/fixtures/1/chunks.json', import.meta.url);

interface Chunk {
  readonly version: number;
  readonly index: number;
  readonly count: number;
  readonly payload: Uint8Array;
}

function header(chunk: Omit<Chunk, 'payload'>, size = HEADER_BYTES): Uint8Array {
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, chunk.version);
  if (size >= 5) view.setUint32(1, chunk.index);
  if (size >= 9) view.setUint32(5, chunk.count);
  return bytes;
}

function message(chunk: Chunk): Uint8Array {
  const bytes = new Uint8Array(HEADER_BYTES + chunk.payload.byteLength);
  bytes.set(header(chunk), 0);
  bytes.set(chunk.payload, HEADER_BYTES);
  return bytes;
}

/** Reference chunker: fills every message to capacity, last one takes the rest. */
function chunkFrame(frame: unknown, maxMessageBytes = DEFAULT_MESSAGE_BYTES): Uint8Array[] {
  const capacity = maxMessageBytes - HEADER_BYTES;
  const bytes = new TextEncoder().encode(JSON.stringify(frame));
  const count = Math.max(1, Math.ceil(bytes.byteLength / capacity));
  const out: Uint8Array[] = [];
  for (let index = 0; index < count; index += 1) {
    const start = index * capacity;
    const payload = bytes.subarray(start, Math.min(start + capacity, bytes.byteLength));
    out.push(message({ version: FORMAT_VERSION, index, count, payload }));
  }
  return out;
}

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');

interface Case {
  readonly name: string;
  readonly verdict: 'accept' | 'reject';
  readonly maxMessageBytes: number;
  readonly maxFrameBytes?: number;
  readonly messages: readonly string[];
  readonly expected?: unknown;
  readonly reason?: string;
  /** Index of the message that must be refused; the last one when absent. */
  readonly refusedAt?: number;
  readonly note?: string;
}

const small = { type: 'ping' } as const;
const filler = (bytes: number) => ({
  type: 'req',
  id: 'bulk',
  method: 'test.bulk',
  params: { blob: 'x'.repeat(bytes) },
});

function build(): Case[] {
  const big = filler(40_000);
  const bigChunks = chunkFrame(big, 16 * 1024);
  const exact = filler(16 * 1024 - HEADER_BYTES - 60); // sized so the line is exactly one capacity
  const exactLine = new TextEncoder().encode(JSON.stringify(exact));
  const cases: Case[] = [
    {
      name: 'y_single_chunk',
      verdict: 'accept',
      maxMessageBytes: 16 * 1024,
      messages: chunkFrame(small).map(b64),
      expected: small,
    },
    {
      name: 'y_three_chunks',
      verdict: 'accept',
      maxMessageBytes: 16 * 1024,
      messages: bigChunks.map(b64),
      expected: big,
      note: `${bigChunks.length} messages; every non-final one carries a full capacity payload.`,
    },
    {
      name: 'y_small_message_ceiling',
      verdict: 'accept',
      maxMessageBytes: 2048,
      messages: chunkFrame(filler(5000), 2048).map(b64),
      expected: filler(5000),
      note: 'The smallest ceiling the spec allows; non-final payloads are 2039 bytes.',
    },
    {
      name: 'y_nonfinal_payload_at_minimum',
      verdict: 'accept',
      maxMessageBytes: 16 * 1024,
      messages: [
        message({
          version: 1,
          index: 0,
          count: 2,
          payload: exactLine.subarray(0, MIN_NONFINAL_PAYLOAD),
        }),
        message({
          version: 1,
          index: 1,
          count: 2,
          payload: exactLine.subarray(MIN_NONFINAL_PAYLOAD),
        }),
      ].map(b64),
      expected: exact,
      note: 'A non-final chunk with exactly 1024 payload bytes is the minimum a receiver accepts.',
    },
    {
      name: 'n_format_version_2',
      verdict: 'reject',
      maxMessageBytes: 16 * 1024,
      messages: [
        message({
          version: 2,
          index: 0,
          count: 1,
          payload: new TextEncoder().encode('{"type":"ping"}'),
        }),
      ].map(b64),
      reason: 'chunk-version',
    },
    {
      name: 'n_short_header',
      verdict: 'reject',
      maxMessageBytes: 16 * 1024,
      messages: [header({ version: 1, index: 0, count: 1 }, 5)].map(b64),
      reason: 'chunk-header',
    },
    {
      name: 'n_count_zero',
      verdict: 'reject',
      maxMessageBytes: 16 * 1024,
      messages: [message({ version: 1, index: 0, count: 0, payload: new Uint8Array(0) })].map(b64),
      reason: 'chunk-count',
    },
    {
      name: 'n_count_exceeds_bound',
      verdict: 'reject',
      maxMessageBytes: 16 * 1024,
      maxFrameBytes: 16 * 1024 * 1024,
      messages: [
        message({
          version: 1,
          index: 0,
          count: 16_385,
          payload: new Uint8Array(MIN_NONFINAL_PAYLOAD),
        }),
      ].map(b64),
      reason: 'chunk-count',
      note: 'ceil(16 MiB / 1024) = 16384 is the most chunks a frame can need.',
    },
    {
      name: 'n_index_out_of_range',
      verdict: 'reject',
      maxMessageBytes: 16 * 1024,
      messages: [
        message({
          version: 1,
          index: 1,
          count: 1,
          payload: new TextEncoder().encode('{"type":"ping"}'),
        }),
      ].map(b64),
      reason: 'chunk-index',
    },
    {
      name: 'n_index_gap',
      verdict: 'reject',
      maxMessageBytes: 16 * 1024,
      messages: [bigChunks[0], bigChunks[2]].map((m) => b64(m as Uint8Array)),
      reason: 'chunk-index',
    },
    {
      name: 'n_count_changes_mid_frame',
      verdict: 'reject',
      maxMessageBytes: 16 * 1024,
      messages: [
        bigChunks[0] as Uint8Array,
        message({ version: 1, index: 1, count: 4, payload: new Uint8Array(MIN_NONFINAL_PAYLOAD) }),
      ].map(b64),
      reason: 'chunk-count',
    },
    {
      name: 'n_nonfinal_payload_below_minimum',
      verdict: 'reject',
      maxMessageBytes: 16 * 1024,
      messages: [
        message({
          version: 1,
          index: 0,
          count: 2,
          payload: exactLine.subarray(0, MIN_NONFINAL_PAYLOAD - 1),
        }),
      ].map(b64),
      reason: 'chunk-dribble',
      note: 'A non-final chunk with 1023 payload bytes is refused on arrival.',
    },
    {
      name: 'n_exceeds_frame_limit',
      verdict: 'reject',
      maxMessageBytes: 2048,
      maxFrameBytes: 4096,
      messages: chunkFrame(filler(7000), 2048).map(b64),
      reason: 'too-large',
      refusedAt: 2,
      note: 'Four chunks of 2039 payload bytes; refused on the third, as soon as the accumulated payload passes 4096, without waiting for the last chunk.',
    },
    {
      name: 'n_reassembled_line_invalid',
      verdict: 'reject',
      maxMessageBytes: 16 * 1024,
      messages: [
        message({
          version: 1,
          index: 0,
          count: 1,
          payload: new TextEncoder().encode('{"type":"nope"}'),
        }),
      ].map(b64),
      reason: 'schema',
    },
  ];
  return cases;
}

const document = {
  $comment:
    'WebSocket chunk-framing corpus, generated by scripts/fixtures/generate-chunks.ts. messages are base64 binary WebSocket messages fed in order; expected is the reassembled frame.',
  cases: build(),
};
const text = `${JSON.stringify(document, null, 2)}\n`;

if (process.argv.includes('--check')) {
  const current = await Bun.file(OUTPUT)
    .text()
    .catch(() => '');
  if (current !== text) {
    console.error(
      'spec/fixtures/1/chunks.json is stale; run bun ./scripts/fixtures/generate-chunks.ts'
    );
    process.exit(1);
  }
  console.log('chunks.json is up to date');
} else {
  await Bun.write(OUTPUT, text);
  console.log(`wrote ${fileURLToPath(OUTPUT)} (${document.cases.length} cases)`);
}
