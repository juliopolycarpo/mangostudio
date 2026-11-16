import { describe, expect, it } from 'bun:test';

import { decodeLine, LineDecoder, type LineDecoderOutcome } from '../src/codec/ndjson';
import { CodecError } from '../src/errors';
import type { Frame } from '../src/schemas/frames';

const encoder = new TextEncoder();
const LIMIT = 4096;
const LINE_FEED = 0x0a;
const CARRIAGE_RETURN = 0x0d;
const PING: Frame = { type: 'ping' };
const UNICODE: Frame = { type: 'req', id: 'é', method: 'a.b', params: '🥭 ü 中' };

/** A `req` frame whose compact JSON is exactly `bytes` long. */
function frameOfSize(bytes: number): Frame {
  const overhead = JSON.stringify({ type: 'req', id: 'b', method: 'a.b', params: '' }).length;
  return { type: 'req', id: 'b', method: 'a.b', params: 'x'.repeat(bytes - overhead) };
}

function line(frame: Frame, terminator = '\n'): string {
  return `${JSON.stringify(frame)}${terminator}`;
}

/** Frames plus the refusal's kind and exact text: what a caller can observe. */
interface ObservedOutcome {
  readonly frames: readonly Frame[];
  readonly error: string | null;
}

function observe(outcome: LineDecoderOutcome): ObservedOutcome {
  return {
    frames: outcome.frames,
    error: outcome.error ? `${outcome.error.kind}: ${outcome.error.message}` : null,
  };
}

/** Feeds `bytes` in pieces of `size`, then finishes, and returns every outcome. */
function feed(decoder: LineDecoder, bytes: Uint8Array, size: number): ObservedOutcome[] {
  const outcomes: ObservedOutcome[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += size) {
    outcomes.push(observe(decoder.push(bytes.subarray(offset, offset + size))));
  }
  outcomes.push(observe(decoder.finish()));
  return outcomes;
}

/**
 * What a `LineDecoder` must report after each push and on `finish`, computed
 * from the whole stream at once instead of incrementally: split it on `\n`,
 * hand each push the lines whose `\n` it delivered, decode each with
 * `decodeLine` (blank lines are skipped, not refused), and measure the
 * unterminated rest, less one trailing `\r`, against the limit. The first
 * refusal is repeated by every later call.
 */
function expectedOutcomes(
  stream: Uint8Array,
  pushEnds: readonly number[],
  limit: number
): ObservedOutcome[] {
  const lines: { readonly start: number; readonly end: number }[] = [];
  let tailStart = 0;
  for (let index = 0; index < stream.byteLength; index += 1) {
    if (stream[index] !== LINE_FEED) continue;
    lines.push({ start: tailStart, end: index });
    tailStart = index + 1;
  }

  const outcomes: ObservedOutcome[] = [];
  let latched: string | null = null;
  let nextLine = 0;
  const decodeInto = (record: Uint8Array, frames: Frame[]): string | null => {
    try {
      frames.push(decodeLine(record, { maxFrameBytes: limit }));
      return null;
    } catch (error) {
      if (!(error instanceof CodecError)) throw error;
      return error.kind === 'empty' ? null : `${error.kind}: ${error.message}`;
    }
  };

  for (const end of [...pushEnds, null]) {
    if (latched !== null) {
      outcomes.push({ frames: [], error: latched });
      continue;
    }
    const frames: Frame[] = [];
    let error: string | null = null;
    if (end === null) {
      // `finish`: the unterminated rest is one last record.
      error = decodeInto(stream.subarray(tailStart), frames);
    } else {
      while (error === null && nextLine < lines.length && (lines[nextLine]?.end ?? 0) < end) {
        const { start, end: newline } = lines[nextLine] as { start: number; end: number };
        error = decodeInto(stream.subarray(start, newline), frames);
        nextLine += 1;
      }
      if (error === null) {
        const lineStart = lines[nextLine]?.start ?? tailStart;
        const partial =
          end - lineStart - (end > lineStart && stream[end - 1] === CARRIAGE_RETURN ? 1 : 0);
        if (partial > limit) {
          error = `too-large: partial line is already ${partial} bytes; expected at most ${limit}`;
        }
      }
    }
    latched = error;
    outcomes.push({ frames, error });
  }
  return outcomes;
}

describe('LineDecoder across chunk boundaries', () => {
  it('decodes a CRLF record whose \\r and \\n arrive in different pushes', () => {
    const decoder = new LineDecoder();

    expect(decoder.push('{"type":"ping"}\r')).toEqual({ frames: [] });
    expect(decoder.push('\n')).toEqual({ frames: [PING] });
  });

  it('accepts a line exactly at the limit whose \\r is buffered and whose \\n comes later', () => {
    const atLimit = frameOfSize(LIMIT);
    const decoder = new LineDecoder({ maxFrameBytes: LIMIT });

    // LIMIT + 1 bytes are pending, but one is the CRLF's `\r`.
    expect(decoder.push(`${JSON.stringify(atLimit)}\r`)).toEqual({ frames: [] });
    expect(decoder.push('\n')).toEqual({ frames: [atLimit] });
  });

  it('refuses a completed line over the limit that was assembled from several pushes', () => {
    const decoder = new LineDecoder({ maxFrameBytes: LIMIT });
    expect(decoder.push('y'.repeat(LIMIT))).toEqual({ frames: [] });

    // The completed-line check fires before the partial check could.
    const outcome = observe(decoder.push(`yy\n${line(PING)}`));

    expect(outcome).toEqual({
      frames: [],
      error: `too-large: line is ${LIMIT + 2} bytes; expected at most ${LIMIT}`,
    });
  });

  it('delivers the records before a refusal in the push that completes a buffered line', () => {
    const decoder = new LineDecoder();
    decoder.push('{"type":');

    const outcome = decoder.push(`"ping"}\n${line(PING)}{"type":"nope"}\n${line(PING)}`);

    expect(outcome.frames).toEqual([PING, PING]);
    expect(outcome.error?.kind).toBe('schema');
  });

  it('does not keep a reference to the caller’s chunk', () => {
    const decoder = new LineDecoder();
    const chunk = encoder.encode('{"type":"pi');

    decoder.push(chunk);
    chunk.fill(0x7b);

    expect(decoder.push('ng"}\n').frames).toEqual([PING]);
  });

  it('does not keep a reference to a Node Buffer chunk either', () => {
    const decoder = new LineDecoder();
    const chunk = Buffer.from('{"type":"pi');

    decoder.push(chunk);
    chunk.fill(0x7b);

    expect(decoder.push(Buffer.from('ng"}\n')).frames).toEqual([PING]);
  });

  it('decodes trailing data on finish after many pushes, and finishes twice cleanly', () => {
    const decoder = new LineDecoder();
    const bytes = encoder.encode(`${line(PING)}${JSON.stringify(UNICODE)}\r`);
    for (let offset = 0; offset < bytes.byteLength; offset += 3) {
      decoder.push(bytes.subarray(offset, offset + 3));
    }

    expect(decoder.finish()).toEqual({ frames: [UNICODE] });
    expect(decoder.finish()).toEqual({ frames: [] });
  });

  it('accepts new input after finish', () => {
    const decoder = new LineDecoder();
    decoder.push('{"type":"ping"}');
    decoder.finish();

    expect(decoder.push(line(PING)).frames).toEqual([PING]);
  });

  // A copy of the whole pending buffer per push made this about 34 GB of
  // copying and several seconds; the explicit timeout turns that back into a
  // failure on a fast machine.
  it(
    'reassembles a 2 MiB record fed in 16 B pieces in linear time',
    () => {
      const big = frameOfSize(2 * 1024 * 1024);

      const outcomes = feed(new LineDecoder(), encoder.encode(line(big)), 16);

      expect(outcomes.flatMap((outcome) => outcome.frames)).toEqual([big]);
      expect(outcomes.filter((outcome) => outcome.error !== null)).toEqual([]);
    },
    { timeout: 2000 }
  );
});

/**
 * Lines the property run draws from. Each reaches a branch of the decoder:
 * multi-byte text, CRLF, `\r\r\n`, blank and whitespace lines, a BOM, bad
 * JSON, a non-frame, and sizes at, just past and well past the limit.
 */
const CORPUS: readonly { readonly text: string; readonly weight: number }[] = [
  { text: line(PING), weight: 8 },
  { text: line(PING, '\r\n'), weight: 4 },
  { text: line(UNICODE), weight: 4 },
  { text: line(UNICODE, '\r\n'), weight: 2 },
  { text: '\n', weight: 2 },
  { text: '\r\n', weight: 2 },
  { text: ' \t \n', weight: 2 },
  { text: line(frameOfSize(LIMIT)), weight: 2 },
  { text: line(frameOfSize(LIMIT), '\r\n'), weight: 2 },
  { text: line(frameOfSize(LIMIT - 1), '\r\r\n'), weight: 1 },
  { text: line(frameOfSize(1000)), weight: 2 },
  { text: '﻿{"type":"ping"}\n', weight: 1 },
  { text: '{"type":\n', weight: 1 },
  { text: '{"type":"nope"}\n', weight: 1 },
  { text: line(frameOfSize(LIMIT + 1)), weight: 1 },
  { text: `${' '.repeat(LIMIT + 1)}\n`, weight: 1 },
  { text: `${' '.repeat(LIMIT)}\r\n`, weight: 1 },
];
const CORPUS_WEIGHT = CORPUS.reduce((sum, entry) => sum + entry.weight, 0);

const PIECE_SIZES = [0, 1, 2, 3, 7, 16, 255, 4096, 5000] as const;

/** Deterministic xorshift32, so a failing seed can be replayed. */
function seededRandom(seed: number): () => number {
  let state = seed || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

function pickLine(next: () => number): string {
  let roll = next() * CORPUS_WEIGHT;
  for (const entry of CORPUS) {
    roll -= entry.weight;
    if (roll < 0) return entry.text;
  }
  return line(PING);
}

/** One push as `NdjsonPort` or a caller may hand it over: bytes, a Node Buffer, or text. */
function asChunk(piece: Uint8Array, kind: number): Uint8Array | string {
  if (kind < 0.2) return Buffer.from(piece);
  // Text only when the piece is whole UTF-8; a cut character would change the bytes.
  const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(piece);
  if (kind < 0.3 && encoder.encode(text).byteLength === piece.byteLength) return text;
  return piece;
}

describe('LineDecoder against a decode-the-whole-stream model', () => {
  it('reports the same frames and refusals after every push and on finish', () => {
    for (let seed = 1; seed <= 300; seed += 1) {
      const next = seededRandom(seed);
      const lines = Array.from({ length: 1 + Math.floor(next() * 12) }, () => pickLine(next));
      // Half the streams end mid-record, so `finish` has trailing data to decode.
      const text = next() < 0.5 ? lines.join('') : lines.join('').replace(/\n$/, '');
      const stream = encoder.encode(text);

      const decoder = new LineDecoder({ maxFrameBytes: LIMIT });
      const pushEnds: number[] = [];
      const observed: ObservedOutcome[] = [];
      let offset = 0;
      do {
        const fixed = PIECE_SIZES[Math.floor(next() * PIECE_SIZES.length)] as number;
        const size = next() < 0.2 ? 1 + Math.floor(next() * 64) : fixed;
        const piece = stream.slice(offset, offset + size);
        observed.push(observe(decoder.push(asChunk(piece, next()))));
        offset += piece.byteLength;
        pushEnds.push(offset);
      } while (offset < stream.byteLength);
      observed.push(observe(decoder.finish()));

      const expected = expectedOutcomes(stream, pushEnds, LIMIT);
      for (const [index, outcome] of observed.entries()) {
        const where =
          index < pushEnds.length
            ? `seed ${seed}, push ${index} ending at byte ${pushEnds[index]}`
            : `seed ${seed}, finish`;
        expect(outcome, where).toEqual(expected[index] as ObservedOutcome);
      }
    }
  });
});
