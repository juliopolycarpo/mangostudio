import { beforeEach, describe, expect, it } from 'bun:test';
import { readActivityLastSeen, writeActivityLastSeen } from '@/features/activity/last-seen';

const LAST_SEEN_KEY = 'mangostudio:activity-last-seen';

beforeEach(() => {
  window.localStorage.clear();
});

describe('readActivityLastSeen / writeActivityLastSeen', () => {
  it('returns null for a user with no bookmark yet', () => {
    expect(readActivityLastSeen('user-1')).toBeNull();
  });

  it('round-trips a written timestamp', () => {
    writeActivityLastSeen('user-1', 1000);
    expect(readActivityLastSeen('user-1')).toBe(1000);
  });

  it('scopes the bookmark per user', () => {
    writeActivityLastSeen('user-1', 1000);
    writeActivityLastSeen('user-2', 2000);
    expect(readActivityLastSeen('user-1')).toBe(1000);
    expect(readActivityLastSeen('user-2')).toBe(2000);
  });

  it("overwrites a user's previous bookmark rather than keeping the oldest", () => {
    writeActivityLastSeen('user-1', 1000);
    writeActivityLastSeen('user-1', 2000);
    expect(readActivityLastSeen('user-1')).toBe(2000);
  });

  it('falls back to null on malformed storage instead of throwing', () => {
    window.localStorage.setItem(LAST_SEEN_KEY, 'not json');
    expect(readActivityLastSeen('user-1')).toBeNull();

    window.localStorage.setItem(LAST_SEEN_KEY, JSON.stringify({ 'user-1': 'not a number' }));
    expect(readActivityLastSeen('user-1')).toBeNull();

    window.localStorage.setItem(LAST_SEEN_KEY, JSON.stringify(null));
    expect(readActivityLastSeen('user-1')).toBeNull();
  });

  it('caps the number of tracked users, evicting the oldest bookmarks first', () => {
    for (let index = 0; index < 25; index += 1) {
      writeActivityLastSeen(`user-${index}`, index);
    }
    // The newest write, and the most recently written accounts, survive.
    expect(readActivityLastSeen('user-24')).toBe(24);
    expect(readActivityLastSeen('user-0')).toBeNull();

    const raw = window.localStorage.getItem(LAST_SEEN_KEY);
    const parsed = raw ? (JSON.parse(raw) as Record<string, number>) : {};
    expect(Object.keys(parsed).length).toBeLessThanOrEqual(20);
  });
});
