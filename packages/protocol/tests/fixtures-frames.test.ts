import { describe, expect, it } from 'bun:test';
import frames from '../../../spec/fixtures/1/frames.json';
import { decodeLine, encodeLine } from '../src/codec/ndjson';
import { CodecError, type CodecErrorKind } from '../src/errors';
import { isSubset } from './support/fixtures';
import { refusalOf } from './support/refusal';

interface FrameCase {
  readonly name: string;
  readonly verdict: 'accept' | 'reject' | 'implementation-defined';
  readonly line: string;
  readonly expected?: unknown;
  readonly reason?: string;
}

const cases = frames.cases as readonly FrameCase[];

/** The fixture reasons that name one decoder refusal exactly. */
const KIND_OF_REASON: Readonly<Record<string, CodecErrorKind>> = {
  'invalid-json': 'invalid-json',
  schema: 'schema',
  'too-large': 'too-large',
};

function refusalOfLine(line: string): CodecError {
  return refusalOf(() => decodeLine(line), `the line ${line}`);
}

describe('frame corpus', () => {
  it('reads every case of spec/fixtures/1/frames.json', () => {
    expect(cases.length).toBeGreaterThan(60);
  });

  for (const item of cases.filter((entry) => entry.verdict === 'accept')) {
    it(`accepts ${item.name}`, () => {
      const frame = decodeLine(item.line);
      const reencoded: unknown = JSON.parse(encodeLine(frame).trimEnd());

      expect(isSubset(item.expected, reencoded)).toBe(true);
    });
  }

  for (const item of cases.filter((entry) => entry.verdict === 'reject')) {
    it(`refuses ${item.name}`, () => {
      const error = refusalOfLine(item.line);
      const expectedKind = item.reason === undefined ? undefined : KIND_OF_REASON[item.reason];

      expect(error.kind).toBe(expectedKind as CodecErrorKind);
    });
  }

  for (const item of cases.filter((entry) => entry.verdict === 'implementation-defined')) {
    it(`neither crashes nor throws anything but a CodecError on ${item.name}`, () => {
      try {
        decodeLine(item.line);
      } catch (error) {
        expect(error).toBeInstanceOf(CodecError);
      }
    });
  }
});
