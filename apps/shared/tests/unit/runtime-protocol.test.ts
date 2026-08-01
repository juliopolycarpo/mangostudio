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

  it('measures a record exactly once it is complete, not while it accumulates', () => {
    const decoder = new RuntimeFrameDecoder({ maxFrameBytes: 8 });

    // Four characters, twelve UTF-8 bytes. The pending guard is a cheap
    // code-unit bound, so this accumulates; the exact check on the terminated
    // record is what rejects it, and it can say how far over the limit it is.
    expect(() => decoder.push('日本語文')).not.toThrow();
    expect(() => decoder.push('\n')).toThrow('(12 bytes)');
  });
});

describe('runtime protocol compatibility', () => {
  it('accepts equal major/minor versions with different patches', () => {
    expect(() => assertRuntimeProtocolCompatible('1.2.0', '1.2.9')).not.toThrow();
  });

  it('refuses a same-version peer that carries a field this build does not know', () => {
    // The compat window a remote transport is supposed to have — same
    // major/minor, one side newer, additive fields ignored — does not exist
    // yet. Every frame schema is `additionalProperties: false`, so a peer at
    // 1.0 that adds an optional field has its frame refused and its connection
    // torn down. That is the safe direction to be wrong in, and it is fine
    // while hub and runtime ship together; it stops being fine the moment a
    // remote runtime can be a release behind. Pinned here so the protocol
    // evolution rules land as a deliberate change to this line rather than as
    // an assumption nobody checked.
    const skewed = { ...request, deadlineMs: 30_000 };

    expect(Value.Check(RuntimeFrameSchema, skewed)).toBe(false);
    expect(() => decodeRuntimeFrameLine(JSON.stringify(skewed))).toThrow(RuntimeFrameCodecError);
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
