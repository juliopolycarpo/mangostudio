import { describe, expect, it } from 'bun:test';
import {
  negotiate,
  ORDERED_ANSWER_MINOR,
  PROTOCOL_MAJOR,
  PROTOCOL_MINOR,
  PROTOCOL_VERSION,
} from '../src/version';

describe('protocol version constants', () => {
  it('announces wire 1.2', () => {
    expect(PROTOCOL_MAJOR).toBe(1);
    expect(PROTOCOL_MINOR).toBe(2);
    expect(PROTOCOL_VERSION).toEqual({ major: 1, minor: 2 });
  });

  it('keeps the answer-ordering feature minor at 2 whatever the current minor', () => {
    expect(ORDERED_ANSWER_MINOR).toBe(2);
  });
});

describe('negotiate', () => {
  it('takes the lower minor when the majors match', () => {
    expect(negotiate({ major: 1, minor: 5 }, { major: 1, minor: 2 })).toEqual({
      ok: true,
      effectiveMinor: 2,
    });
    expect(negotiate({ major: 1, minor: 2 }, { major: 1, minor: 5 })).toEqual({
      ok: true,
      effectiveMinor: 2,
    });
  });

  it('is symmetric: both peers derive the same effective minor', () => {
    const local = { major: 1, minor: 4 };
    const remote = { major: 1, minor: 1 };

    expect(negotiate(local, remote)).toEqual(negotiate(remote, local));
  });

  it('refuses a different major with close code 4426', () => {
    expect(negotiate({ major: 1, minor: 0 }, { major: 2, minor: 0 })).toEqual({
      ok: false,
      closeCode: 4426,
    });
    expect(negotiate({ major: 2, minor: 1 }, { major: 1, minor: 9 })).toEqual({
      ok: false,
      closeCode: 4426,
    });
  });
});
