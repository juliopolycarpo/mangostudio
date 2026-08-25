import { describe, expect, it } from 'bun:test';
import {
  decodeActivityCursor,
  encodeActivityCursor,
} from '../../../../src/modules/activity/domain/activity-cursor';

describe('activity cursor', () => {
  it('round-trips createdAt and id through encode/decode', () => {
    const encoded = encodeActivityCursor({ createdAt: 1_700_000_000_000, id: 'evt-1' });

    expect(decodeActivityCursor(encoded)).toEqual({ createdAt: 1_700_000_000_000, id: 'evt-1' });
  });

  it('returns undefined for an empty string', () => {
    expect(decodeActivityCursor('')).toBeUndefined();
  });

  it('returns undefined for garbage that decodes to no separator', () => {
    // Base64url of "no-separator-here" — decodes cleanly but has no ':'.
    const garbage = Buffer.from('no-separator-here', 'utf8').toString('base64url');
    expect(decodeActivityCursor(garbage)).toBeUndefined();
  });

  it('returns undefined when createdAt is not numeric', () => {
    const cursor = Buffer.from('not-a-number:evt-1', 'utf8').toString('base64url');
    expect(decodeActivityCursor(cursor)).toBeUndefined();
  });

  it('returns undefined for a missing separator entirely', () => {
    const cursor = Buffer.from('1700000000000-evt-1', 'utf8').toString('base64url');
    expect(decodeActivityCursor(cursor)).toBeUndefined();
  });

  it('returns undefined for a negative createdAt', () => {
    const cursor = Buffer.from('-5:evt-1', 'utf8').toString('base64url');
    expect(decodeActivityCursor(cursor)).toBeUndefined();
  });

  it('returns undefined when id is empty', () => {
    const cursor = Buffer.from('1700000000000:', 'utf8').toString('base64url');
    expect(decodeActivityCursor(cursor)).toBeUndefined();
  });
});
