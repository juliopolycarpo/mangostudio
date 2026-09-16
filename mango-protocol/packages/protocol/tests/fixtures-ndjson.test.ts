import { describe, expect, it } from 'bun:test';
import ndjson from '../../../spec/fixtures/1/ndjson.json';
import { type FrameLimitOptions, LineDecoder } from '../src/codec/ndjson';
import type { CodecError, CodecErrorKind } from '../src/errors';
import type { Frame } from '../src/schemas/frames';
import { isSubset } from './support/fixtures';

interface NdjsonCase {
  readonly name: string;
  readonly verdict: 'accept' | 'reject';
  readonly pieces: readonly string[];
  readonly maxFrameBytes?: number;
  readonly finish?: boolean;
  readonly expected?: readonly unknown[];
  readonly reason?: string;
}

interface Run {
  readonly frames: readonly Frame[];
  readonly error?: CodecError;
}

const cases = ndjson.cases as readonly NdjsonCase[];
const encoder = new TextEncoder();

function optionsOf(item: NdjsonCase): FrameLimitOptions | undefined {
  return item.maxFrameBytes === undefined ? undefined : { maxFrameBytes: item.maxFrameBytes };
}

/** Feeds one case's pieces and returns everything the decoder produced. */
function run(item: NdjsonCase, pieces: readonly (string | Uint8Array)[]): Run {
  const decoder = new LineDecoder(optionsOf(item));
  const frames: Frame[] = [];
  for (const piece of pieces) {
    const outcome = decoder.push(piece);
    frames.push(...outcome.frames);
    if (outcome.error !== undefined) return { frames, error: outcome.error };
  }
  if (item.finish !== true) return { frames };
  const outcome = decoder.finish();
  frames.push(...outcome.frames);
  return outcome.error === undefined ? { frames } : { frames, error: outcome.error };
}

/** The same case, fed as bytes cut at `offset`, so a split inside a character is exercised. */
function splitBytes(item: NdjsonCase, offset: number): readonly Uint8Array[] {
  const joined = encoder.encode(item.pieces.join(''));
  return [joined.subarray(0, offset), joined.subarray(offset)];
}

function expectFrames(result: Run, expected: readonly unknown[]): void {
  expect(result.frames).toHaveLength(expected.length);
  expected.forEach((frame, index) => {
    expect(isSubset(frame, result.frames[index])).toBe(true);
  });
}

describe('ndjson corpus', () => {
  it('reads every case of spec/fixtures/1/ndjson.json', () => {
    expect(cases.length).toBeGreaterThan(8);
  });

  for (const item of cases.filter((entry) => entry.verdict === 'accept')) {
    it(`accepts ${item.name}`, () => {
      const result = run(item, item.pieces);

      expect(result.error).toBeUndefined();
      expectFrames(result, item.expected ?? []);
    });

    it(`accepts ${item.name} split at any byte offset`, () => {
      const length = encoder.encode(item.pieces.join('')).byteLength;

      for (let offset = 1; offset < length; offset += 1) {
        const result = run(item, splitBytes(item, offset));

        expect(result.error).toBeUndefined();
        expectFrames(result, item.expected ?? []);
      }
    });
  }

  for (const item of cases.filter((entry) => entry.verdict === 'reject')) {
    it(`refuses ${item.name}`, () => {
      const result = run(item, item.pieces);

      expect(result.error?.kind).toBe(item.reason as CodecErrorKind);
      expectFrames(result, item.expected ?? []);
    });
  }
});
