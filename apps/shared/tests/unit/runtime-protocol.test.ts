import { describe, expect, it } from 'bun:test';
import {
  assertRuntimeProtocolCompatible,
  decodeRuntimeFrameLine,
  encodeRuntimeFrame,
  narrowRuntimeErrorCode,
  RUNTIME_PROTOCOL_VERSION,
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
  it('holds the protocol at 1.0, so a bump is a decision and not a side effect', () => {
    // `assertRuntimeProtocolCompatible` is strict major+minor equality, and
    // remote transports are the first place two peers can be on different
    // releases at all. Every schema change that keeps them talking is therefore
    // additive-and-optional rather than a version bump: bumping this string
    // disconnects every runtime nobody has updated yet, which is a migration to
    // plan, not a line to change in passing.
    expect(RUNTIME_PROTOCOL_VERSION).toBe('1.0');
  });

  it('accepts equal major/minor versions with different patches', () => {
    expect(() => assertRuntimeProtocolCompatible('1.2.0', '1.2.9')).not.toThrow();
  });

  it('refuses a same-version peer that carries a field this build does not know on a frame envelope', () => {
    // Frame envelopes stay closed (`additionalProperties: false`). Additive
    // evolution lands on the capability manifest and on open `err.code`, not
    // on every frame picking up optional siblings — those would still drop the
    // socket. Pinned so a future "just add a field to req" does not slip past.
    const skewed = { ...request, deadlineMs: 30_000 };

    expect(Value.Check(RuntimeFrameSchema, skewed)).toBe(false);
    expect(() => decodeRuntimeFrameLine(JSON.stringify(skewed))).toThrow(RuntimeFrameCodecError);
  });

  it("ignores unknown keys on a newer peer's capability manifest", () => {
    const hello = {
      type: 'hello' as const,
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      runtimeVersion: '0.1.1',
      manifest: {
        platform: 'linux',
        arch: 'x64',
        pathStyle: 'posix' as const,
        homeDir: '/home/peer',
        shells: ['bash' as const],
        git: { available: true, version: '2.45.0', vendor: 'extra' },
        features: {
          tools: true,
          git: true,
          probing: true,
          mcp: true,
          library: true,
          checkpoints: true,
          fsRead: true,
          futureFlag: false,
        },
        profile: 'readonly',
      },
    };

    expect(Value.Check(RuntimeFrameSchema, hello)).toBe(true);
    expect(decodeRuntimeFrameLine(JSON.stringify(hello))).toEqual(hello);
  });

  it('decodes an unknown err.code and lets consumers narrow it to INTERNAL', () => {
    const frame = {
      type: 'res' as const,
      id: 'request-1',
      err: {
        code: 'RUNTIME_DENIED',
        message: 'shell is not granted on this machine',
        details: { capability: 'shell' },
      },
    };

    expect(Value.Check(RuntimeFrameSchema, frame)).toBe(true);
    expect(decodeRuntimeFrameLine(JSON.stringify(frame))).toEqual(frame);
    expect(narrowRuntimeErrorCode(frame.err.code)).toBe('RUNTIME_DENIED');
    expect(narrowRuntimeErrorCode('TIMEOUT')).toBe('TIMEOUT');
    expect(narrowRuntimeErrorCode('SOMETHING_FROM_THE_FUTURE')).toBe('INTERNAL');
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
