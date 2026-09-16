import { describe, expect, it } from 'bun:test';
import {
  DEFAULT_MAX_FRAME_BYTES,
  decodeLine,
  encodeFrameBytes,
  encodeLine,
  LineDecoder,
  MIN_MAX_FRAME_BYTES,
  measureFrameBytes,
} from '../src/codec/ndjson';
import type { CodecError } from '../src/errors';
import type { Frame } from '../src/schemas/frames';
import { refusalOf } from './support/refusal';

const encoder = new TextEncoder();
const PING: Frame = { type: 'ping' };

function bulkFrame(bytes: number): Frame {
  return { type: 'req', id: 'bulk', method: 'test.bulk', params: { blob: 'x'.repeat(bytes) } };
}

describe('encodeFrameBytes', () => {
  it('encodes compact JSON with no terminator', () => {
    expect(new TextDecoder().decode(encodeFrameBytes(PING))).toBe('{"type":"ping"}');
  });

  it('validates the frame before encoding it', () => {
    const error = refusalOf(() => encodeFrameBytes({ type: 'req' } as unknown as Frame));

    expect(error.kind).toBe('schema');
    expect(error.frameType).toBe('req');
  });

  it('refuses a frame over the limit, naming both sizes', () => {
    const error = refusalOf(() =>
      encodeFrameBytes(bulkFrame(5000), { maxFrameBytes: MIN_MAX_FRAME_BYTES })
    );

    expect(error.kind).toBe('too-large');
    expect(error.message).toContain('expected at most 4096');
  });

  it('refuses a frame JSON cannot carry', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const frame: Frame = { type: 'req', id: 'r', method: 'a.b', params: circular };

    const error = refusalOf(() => encodeFrameBytes(frame));

    expect(error.kind).toBe('schema');
    expect(error.message).toContain('not JSON-serialisable');
  });
});

describe('encodeLine', () => {
  it('appends exactly one line feed', () => {
    expect(encodeLine(PING)).toBe('{"type":"ping"}\n');
  });

  it('measures the limit without the terminator', () => {
    const frame = bulkFrame(5000);
    const exact = measureFrameBytes(frame);

    expect(encodeLine(frame, { maxFrameBytes: exact }).length).toBe(exact + 1);
    expect(refusalOf(() => encodeLine(frame, { maxFrameBytes: exact - 1 })).kind).toBe('too-large');
  });
});

describe('measureFrameBytes', () => {
  it('counts UTF-8 bytes, not characters', () => {
    expect(measureFrameBytes(PING)).toBe(15);
    expect(measureFrameBytes({ type: 'req', id: 'é', method: 'a.b', params: null })).toBe(
      measureFrameBytes({ type: 'req', id: 'e', method: 'a.b', params: null }) + 1
    );
  });

  it('agrees with the encoded length', () => {
    const frame = bulkFrame(100);

    expect(measureFrameBytes(frame)).toBe(encodeFrameBytes(frame).byteLength);
  });
});

describe('frame limit options', () => {
  it('defaults to 16 MiB', () => {
    expect(DEFAULT_MAX_FRAME_BYTES).toBe(16 * 1024 * 1024);
    expect(MIN_MAX_FRAME_BYTES).toBe(4096);
  });

  it('refuses a ceiling below the floor the spec allows', () => {
    expect(() => decodeLine('{"type":"ping"}', { maxFrameBytes: 4095 })).toThrow(RangeError);
    expect(() => new LineDecoder({ maxFrameBytes: 1.5 })).toThrow(RangeError);
  });
});

describe('decodeLine', () => {
  it('decodes a record given as text or as bytes', () => {
    expect(decodeLine('{"type":"ping"}')).toEqual(PING);
    expect(decodeLine(encoder.encode('{"type":"pong"}'))).toEqual({ type: 'pong' });
  });

  it('strips one trailing carriage return', () => {
    expect(decodeLine('{"type":"ping"}\r')).toEqual(PING);
    expect(decodeLine(encoder.encode('{"type":"ping"}\r'))).toEqual(PING);
  });

  it('refuses a blank record', () => {
    expect(refusalOf(() => decodeLine('')).kind).toBe('empty');
    expect(refusalOf(() => decodeLine('   ')).kind).toBe('empty');
    expect(refusalOf(() => decodeLine('\r')).kind).toBe('empty');
  });

  it('refuses an oversized blank record for its size, not its blankness', () => {
    // The same order `LineDecoder` and the Rust codec use. Reporting `empty`
    // here would have one giant blank line answer two different refusals
    // depending on which decoder read it.
    const blank = ' '.repeat(4097);
    expect(refusalOf(() => decodeLine(blank, { maxFrameBytes: 4096 })).kind).toBe('too-large');
    expect(refusalOf(() => decodeLine(' '.repeat(4096), { maxFrameBytes: 4096 })).kind).toBe(
      'empty'
    );
  });

  it('refuses a byte-order mark on the byte path as well as the text path', () => {
    expect(refusalOf(() => decodeLine('﻿{"type":"ping"}')).kind).toBe('invalid-json');
    expect(refusalOf(() => decodeLine(encoder.encode('﻿{"type":"ping"}'))).kind).toBe(
      'invalid-json'
    );
  });

  it('refuses a record over the limit before parsing it', () => {
    const line = encodeLine(bulkFrame(5000)).trimEnd();

    expect(refusalOf(() => decodeLine(line, { maxFrameBytes: 4096 })).kind).toBe('too-large');
  });

  it('refuses a schema-valid JSON value that is not a frame', () => {
    expect(refusalOf(() => decodeLine('{"type":"nope"}')).kind).toBe('schema');
    expect(refusalOf(() => decodeLine('[]')).kind).toBe('schema');
  });
});

describe('LineDecoder', () => {
  it('delivers every complete record of one push', () => {
    const outcome = new LineDecoder().push('{"type":"ping"}\n{"type":"pong"}\n');

    expect(outcome.frames).toEqual([PING, { type: 'pong' }]);
    expect(outcome.error).toBeUndefined();
  });

  it('holds a partial record until its terminator arrives', () => {
    const decoder = new LineDecoder();

    expect(decoder.push('{"type":').frames).toEqual([]);
    expect(decoder.push('"ping"}\n').frames).toEqual([PING]);
  });

  it('joins a record split at any byte offset, including inside a character', () => {
    const line = encoder.encode('{"type":"req","id":"é","method":"a.b","params":"🥭"}\n');

    for (let offset = 1; offset < line.byteLength; offset += 1) {
      const decoder = new LineDecoder();
      const first = decoder.push(line.subarray(0, offset));
      const second = decoder.push(line.subarray(offset));
      const frames = [...first.frames, ...second.frames];

      expect(frames).toEqual([{ type: 'req', id: 'é', method: 'a.b', params: '🥭' }]);
    }
  });

  it('ignores blank and whitespace-only lines', () => {
    const outcome = new LineDecoder().push('\n\r\n   \n{"type":"ping"}\n\n');

    expect(outcome.frames).toEqual([PING]);
  });

  it('decodes a final record without a terminator on finish', () => {
    const decoder = new LineDecoder();

    expect(decoder.push('{"type":"ping"}').frames).toEqual([]);
    expect(decoder.finish().frames).toEqual([PING]);
  });

  it('finishes an empty buffer with nothing', () => {
    const decoder = new LineDecoder();
    decoder.push('{"type":"ping"}\n');

    expect(decoder.finish()).toEqual({ frames: [] });
  });

  it('delivers the frames decoded before a refusal, then stays refused', () => {
    const decoder = new LineDecoder();

    const outcome = decoder.push('{"type":"ping"}\n{"type":"nope"}\n{"type":"pong"}\n');
    expect(outcome.frames).toEqual([PING]);
    expect(outcome.error?.kind).toBe('schema');

    const after = decoder.push('{"type":"ping"}\n');
    expect(after.frames).toEqual([]);
    expect(after.error).toBe(outcome.error as CodecError);
    expect(decoder.finish().error).toBe(outcome.error as CodecError);
  });

  it('refuses a partial line that already passed the limit', () => {
    const decoder = new LineDecoder({ maxFrameBytes: 4096 });

    const outcome = decoder.push('x'.repeat(4097));

    expect(outcome.frames).toEqual([]);
    expect(outcome.error?.kind).toBe('too-large');
    expect(outcome.error?.message).toContain('partial line is already 4097 bytes');
  });

  it('refuses an oversized blank line the same whether it arrives whole or split', () => {
    const blank = `${' '.repeat(4097)}\n`;

    const whole = new LineDecoder({ maxFrameBytes: 4096 });
    const wholeOutcome = whole.push(blank);
    expect(wholeOutcome.frames).toEqual([]);
    expect(wholeOutcome.error?.kind).toBe('too-large');
    // The line is complete here, terminator and all, so the refusal must not
    // call it partial: `decodeLine` spells the same measurement this way.
    expect(wholeOutcome.error?.message).toBe('line is 4097 bytes; expected at most 4096');

    const split = new LineDecoder({ maxFrameBytes: 4096 });
    const head = split.push(blank.slice(0, -1));
    expect(head.frames).toEqual([]);
    expect(head.error?.kind).toBe('too-large');
    const tail = split.push(blank.slice(-1));
    expect(tail.error?.kind).toBe('too-large');
  });
});
