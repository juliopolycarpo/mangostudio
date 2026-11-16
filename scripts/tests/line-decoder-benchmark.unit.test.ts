import { describe, expect, it } from 'bun:test';

import { LineDecoder } from '@mangostudio/protocol';

import {
  DECODER_SCENARIOS,
  oneLineInput,
  shortLinesInput,
  timeDecoderPass,
} from '../bench/line-decoder';

/** A decoder that swallows every record, standing in for a broken revision. */
class FrameDroppingLineDecoder {
  push(_chunk: Uint8Array) {
    return { frames: [] };
  }
  finish() {
    return { frames: [] };
  }
}

/** A decoder that refuses the first push, standing in for a too-low frame limit. */
class RefusingLineDecoder {
  push(_chunk: Uint8Array) {
    return { frames: [], error: { message: 'line is 9 bytes; expected at most 4' } };
  }
  finish() {
    return { frames: [] };
  }
}

describe('line-decoder benchmark inputs', () => {
  it('builds one line of exactly the requested size, terminator included', () => {
    const { bytes, frames } = oneLineInput(4096);

    expect(bytes.byteLength).toBe(4096);
    expect(bytes.indexOf(0x0a)).toBe(4095);
    expect(frames).toBe(1);
  });

  it('builds one line per short frame', () => {
    const { bytes, frames } = shortLinesInput(50);

    expect(bytes.filter((byte) => byte === 0x0a).length).toBe(50);
    expect(frames).toBe(50);
  });

  it('names every scenario once', () => {
    const names = DECODER_SCENARIOS.map((scenario) => scenario.name);

    expect(new Set(names).size).toBe(names.length);
  });
});

describe('timeDecoderPass', () => {
  it('decodes the whole input with the shipped decoder and returns a duration', () => {
    const { bytes, frames } = shortLinesInput(100);

    const elapsedMs = timeDecoderPass(() => new LineDecoder(), bytes, 7, frames);

    expect(elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it('fails a pass whose decoder delivers the wrong number of frames', () => {
    const { bytes, frames } = shortLinesInput(3);

    expect(() => timeDecoderPass(() => new FrameDroppingLineDecoder(), bytes, 16, frames)).toThrow(
      'expected frames: 3 | received: 0'
    );
  });

  it('fails a pass whose decoder refuses the input', () => {
    const { bytes, frames } = oneLineInput(64);

    expect(() => timeDecoderPass(() => new RefusingLineDecoder(), bytes, 16, frames)).toThrow(
      'expected no refusal | received: line is 9 bytes; expected at most 4'
    );
  });
});
