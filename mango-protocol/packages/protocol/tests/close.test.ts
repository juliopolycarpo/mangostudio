import { describe, expect, it } from 'bun:test';
import {
  CLOSE_CODES,
  closeCodeForCodecError,
  closeCodeName,
  isCloseCode,
  isFatalCloseCode,
} from '../src/close';
import { CodecError } from '../src/errors';

describe('isFatalCloseCode', () => {
  it('holds exactly the four codes of the fatal set', () => {
    expect(isFatalCloseCode(CLOSE_CODES.UNAUTHORIZED)).toBe(true);
    expect(isFatalCloseCode(CLOSE_CODES.FORBIDDEN)).toBe(true);
    expect(isFatalCloseCode(CLOSE_CODES.SUPERSEDED)).toBe(true);
    expect(isFatalCloseCode(CLOSE_CODES.PROTOCOL_MISMATCH)).toBe(true);
  });

  it('leaves the retryable codes out', () => {
    expect(isFatalCloseCode(CLOSE_CODES.RELEASED)).toBe(false);
    expect(isFatalCloseCode(CLOSE_CODES.PROTOCOL_ERROR)).toBe(false);
    expect(isFatalCloseCode(CLOSE_CODES.RATE_LIMITED)).toBe(false);
    expect(isFatalCloseCode(CLOSE_CODES.INTERNAL)).toBe(false);
    expect(isFatalCloseCode(4777)).toBe(false);
  });
});

describe('closeCodeName', () => {
  it('names every code of the table', () => {
    for (const [name, code] of Object.entries(CLOSE_CODES)) {
      expect(closeCodeName(code)).toBe(name);
    }
  });

  it('has no name for an unlisted code in range', () => {
    expect(closeCodeName(4777)).toBeUndefined();
  });
});

describe('isCloseCode', () => {
  it('accepts the 4000-4999 integers and nothing else', () => {
    expect(isCloseCode(4000)).toBe(true);
    expect(isCloseCode(4999)).toBe(true);
    expect(isCloseCode(3999)).toBe(false);
    expect(isCloseCode(5000)).toBe(false);
    expect(isCloseCode(4000.5)).toBe(false);
    expect(isCloseCode(Number.NaN)).toBe(false);
  });
});

describe('closeCodeForCodecError', () => {
  it('answers 4426 for a hello that failed the schema', () => {
    const error = new CodecError('schema', 'hello is not valid', { frameType: 'hello' });

    expect(closeCodeForCodecError(error)).toBe(4426);
  });

  it('answers 4400 for every other refusal', () => {
    expect(closeCodeForCodecError(new CodecError('invalid-json', 'not JSON'))).toBe(4400);
    expect(closeCodeForCodecError(new CodecError('too-large', 'over the limit'))).toBe(4400);
    expect(closeCodeForCodecError(new CodecError('schema', 'bad req', { frameType: 'req' }))).toBe(
      4400
    );
    expect(closeCodeForCodecError(new CodecError('schema', 'no type member'))).toBe(4400);
  });
});
