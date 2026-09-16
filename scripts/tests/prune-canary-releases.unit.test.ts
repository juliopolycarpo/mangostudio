import { describe, expect, test } from 'bun:test';

import {
  type ReleaseListEntry,
  selectCanaryReleasesToPrune,
} from '../release/prune-canary-releases';

function canary(tagName: string, createdAt: string): ReleaseListEntry {
  return { tagName, isPrerelease: true, createdAt };
}

describe('selectCanaryReleasesToPrune', () => {
  test('keeps the newest N and returns the rest', () => {
    const entries = [
      canary('v0.1.1-canary.1111111', '2026-09-10T00:00:00Z'),
      canary('v0.1.1-canary.3333333', '2026-09-12T00:00:00Z'),
      canary('v0.1.1-canary.2222222', '2026-09-11T00:00:00Z'),
    ];

    expect(selectCanaryReleasesToPrune(entries, 2)).toEqual(['v0.1.1-canary.1111111']);
  });

  test('orders by creation time, not by the order GitHub listed them', () => {
    const entries = [
      canary('v0.1.1-canary.aaaaaaa', '2026-09-01T00:00:00Z'),
      canary('v0.1.1-canary.bbbbbbb', '2026-09-09T00:00:00Z'),
    ];

    expect(selectCanaryReleasesToPrune(entries, 1)).toEqual(['v0.1.1-canary.aaaaaaa']);
  });

  test('never touches the frozen rolling tag or a stable release', () => {
    const entries: ReleaseListEntry[] = [
      canary('v0.1.1-canary.9999999', '2026-09-12T00:00:00Z'),
      // The pre-immutability rolling tag: no sha, still serving old launchers.
      canary('v0.1.1-canary', '2026-07-05T00:00:00Z'),
      { tagName: 'v0.1.1', isPrerelease: false, createdAt: '2026-07-05T00:00:00Z' },
      { tagName: 'protocol-v0.2.0', isPrerelease: false, createdAt: '2026-09-10T00:00:00Z' },
    ];

    expect(selectCanaryReleasesToPrune(entries, 0)).toEqual(['v0.1.1-canary.9999999']);
  });

  test('matches a git-describe style sha identifier', () => {
    // A short sha that is all digits with a leading zero is an illegal semver
    // numeric identifier, so the release scripts write it `g`-prefixed.
    const entries = [
      canary('v0.1.1-canary.g0123456', '2026-09-12T00:00:00Z'),
      canary('v0.1.1-canary.g0999999', '2026-09-11T00:00:00Z'),
    ];

    expect(selectCanaryReleasesToPrune(entries, 1)).toEqual(['v0.1.1-canary.g0999999']);
  });

  test('keeps everything when there are fewer releases than the window', () => {
    const entries = [canary('v0.1.1-canary.1234567', '2026-09-12T00:00:00Z')];

    expect(selectCanaryReleasesToPrune(entries, 10)).toEqual([]);
  });

  test('refuses a negative keep-window rather than deleting everything', () => {
    expect(() => selectCanaryReleasesToPrune([], -1)).toThrow(/must not be negative/);
  });
});
