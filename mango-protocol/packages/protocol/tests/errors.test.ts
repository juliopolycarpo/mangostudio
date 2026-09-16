import { describe, expect, it } from 'bun:test';
import { CodecError, isReservedErrorCode, RESERVED_ERROR_CODES, RemoteError } from '../src/errors';

describe('isReservedErrorCode', () => {
  it('accepts every code the spec reserves', () => {
    for (const code of Object.values(RESERVED_ERROR_CODES)) {
      expect(isReservedErrorCode(code)).toBe(true);
    }
    expect(Object.keys(RESERVED_ERROR_CODES)).toHaveLength(10);
  });

  it('refuses an application code and an inherited property name', () => {
    expect(isReservedErrorCode('SOME_FUTURE_CODE_2')).toBe(false);
    expect(isReservedErrorCode('toString')).toBe(false);
    expect(isReservedErrorCode('denied')).toBe(false);
  });
});

describe('CodecError', () => {
  it('carries its kind and stays an Error', () => {
    const error = new CodecError('too-large', 'line is 5000 bytes; expected at most 4096');

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('CodecError');
    expect(error.kind).toBe('too-large');
    expect(error.message).toBe('line is 5000 bytes; expected at most 4096');
    expect(error.frameType).toBeUndefined();
  });

  it('carries the frame type of the refused input when one was parsed', () => {
    const error = new CodecError('schema', 'bad hello', { frameType: 'hello' });

    expect(error.frameType).toBe('hello');
  });
});

describe('RemoteError', () => {
  it('preserves the code, message and details of an err frame', () => {
    const error = new RemoteError('DENIED', 'fsRead was not granted', { capability: 'fsRead' });

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('RemoteError');
    expect(error.code).toBe('DENIED');
    expect(error.message).toBe('fsRead was not granted');
    expect(error.details).toEqual({ capability: 'fsRead' });
  });

  it('leaves details absent when the err frame carried none', () => {
    const error = new RemoteError('INTERNAL', 'boom');

    expect(error.details).toBeUndefined();
  });
});
