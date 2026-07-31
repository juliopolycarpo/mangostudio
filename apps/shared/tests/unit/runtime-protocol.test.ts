import { describe, expect, it } from 'bun:test';
import {
  assertRuntimeProtocolCompatible,
  decodeRuntimeFrameLine,
  encodeRuntimeFrame,
  RuntimeFrameCodecError,
  RuntimeFrameDecoder,
  RuntimeFrameSchema,
  RuntimeProtocolError,
  type RuntimeRequestFrame,
} from '@mangostudio/shared/runtime-protocol';
import { Value } from '@sinclair/typebox/value';

const request: RuntimeRequestFrame = {
  type: 'req',
  id: 'request-1',
  method: 'fs.read-file',
  params: { path: '/tmp/example.txt' },
};

describe('runtime protocol frames', () => {
  it('round-trips a request through the NDJSON codec', () => {
    const encoded = encodeRuntimeFrame(request);

    expect(encoded.endsWith('\n')).toBe(true);
    expect(decodeRuntimeFrameLine(encoded.trimEnd())).toEqual(request);
  });

  it('buffers partial lines and emits every complete frame', () => {
    const decoder = new RuntimeFrameDecoder();
    const encoded = encodeRuntimeFrame(request);
    const midpoint = Math.floor(encoded.length / 2);

    expect(decoder.push(encoded.slice(0, midpoint))).toEqual([]);
    expect(decoder.push(encoded.slice(midpoint))).toEqual([request]);
    expect(decoder.finish()).toEqual([]);
  });

  it('decodes a final record without a trailing newline', () => {
    const decoder = new RuntimeFrameDecoder();

    expect(decoder.push(JSON.stringify(request))).toEqual([]);
    expect(decoder.finish()).toEqual([request]);
  });

  it('rejects malformed JSON and schema-invalid frames', () => {
    expect(() => decodeRuntimeFrameLine('{')).toThrow(RuntimeFrameCodecError);
    expect(() =>
      decodeRuntimeFrameLine(JSON.stringify({ type: 'req', id: 'missing-method', params: {} }))
    ).toThrow('protocol schema');
    expect(Value.Check(RuntimeFrameSchema, { ...request, signal: {} })).toBe(false);
  });

  it('enforces the configured line cap while buffering', () => {
    const decoder = new RuntimeFrameDecoder({ maxFrameBytes: 8 });

    expect(() => decoder.push('123456789')).toThrow('8-byte line limit');
  });
});

describe('runtime protocol compatibility', () => {
  it('accepts equal major/minor versions with different patches', () => {
    expect(() => assertRuntimeProtocolCompatible('1.2.0', '1.2.9')).not.toThrow();
  });

  it('rejects a stale runtime with an actionable typed error', () => {
    try {
      assertRuntimeProtocolCompatible('1.2', '1.1');
      throw new Error('Expected protocol mismatch');
    } catch (error) {
      expect(error).toBeInstanceOf(RuntimeProtocolError);
      expect((error as RuntimeProtocolError).code).toBe('PROTOCOL_MISMATCH');
      expect((error as Error).message).toContain('same release');
    }
  });
});
