import { describe, expect, test } from 'bun:test';

import {
  deleteArgs,
  listArgs,
  type ReleaseListEntry,
  selectCanaryReleasesToPrune,
} from '../release/prune-canary-releases';

function canary(
  tagName: string,
  createdAt: string,
  overrides: Partial<ReleaseListEntry> = {}
): ReleaseListEntry {
  return { tagName, isPrerelease: true, isDraft: false, createdAt, ...overrides };
}

const tagsOf = (entries: readonly ReleaseListEntry[]) => entries.map((entry) => entry.tagName);

describe('selectCanaryReleasesToPrune', () => {
  test('keeps the newest N and returns the rest', () => {
    const entries = [
      canary('v0.1.1-canary.1111111', '2026-09-10T00:00:00Z'),
      canary('v0.1.1-canary.3333333', '2026-09-12T00:00:00Z'),
      canary('v0.1.1-canary.2222222', '2026-09-11T00:00:00Z'),
    ];

    expect(tagsOf(selectCanaryReleasesToPrune(entries, 2))).toEqual(['v0.1.1-canary.1111111']);
  });

  test('orders by creation time, not by the order GitHub listed them', () => {
    const entries = [
      canary('v0.1.1-canary.aaaaaaa', '2026-09-01T00:00:00Z'),
      canary('v0.1.1-canary.bbbbbbb', '2026-09-09T00:00:00Z'),
    ];

    expect(tagsOf(selectCanaryReleasesToPrune(entries, 1))).toEqual(['v0.1.1-canary.aaaaaaa']);
  });

  test('does not let a newer interrupted-publish draft consume the keep-window', () => {
    const entries = [
      canary('v0.1.1-canary.aaaaaaa', '2026-09-10T00:00:00Z'),
      canary('v0.1.1-canary.bbbbbbb', '2026-09-11T00:00:00Z'),
      // A failed upload can leave this newer release unpublished. It cannot
      // displace a published canary from the retention window…
      canary('v0.1.1-canary.ccccccc', '2026-09-12T00:00:00Z', { isDraft: true }),
    ];

    // …and it is deleted anyway: nothing will ever finish it, and it holds a
    // partial copy of a full asset set. Stale published history comes first.
    expect(tagsOf(selectCanaryReleasesToPrune(entries, 1))).toEqual([
      'v0.1.1-canary.aaaaaaa',
      'v0.1.1-canary.ccccccc',
    ]);
  });

  test('deletes a leftover draft that the keep-window would otherwise cover', () => {
    const entries = [
      canary('v0.1.1-canary.aaaaaaa', '2026-09-10T00:00:00Z'),
      canary('v0.1.1-canary.ccccccc', '2026-09-12T00:00:00Z', { isDraft: true }),
    ];

    expect(tagsOf(selectCanaryReleasesToPrune(entries, 14))).toEqual(['v0.1.1-canary.ccccccc']);
  });

  test('deletes a draft whose prerelease flag is not set yet', () => {
    // `gh release create` sets the release's flags as it goes; only the tag
    // name is fixed when the draft is opened, so the draft rule keys on that.
    const entries = [
      canary('v0.1.1-canary.ddddddd', '2026-09-12T00:00:00Z', {
        isDraft: true,
        isPrerelease: false,
      }),
    ];

    expect(tagsOf(selectCanaryReleasesToPrune(entries, 14))).toEqual(['v0.1.1-canary.ddddddd']);
  });

  test('orders drafts newest first among themselves', () => {
    const entries = [
      canary('v0.1.1-canary.1111111', '2026-09-10T00:00:00Z', { isDraft: true }),
      canary('v0.1.1-canary.2222222', '2026-09-12T00:00:00Z', { isDraft: true }),
    ];

    expect(tagsOf(selectCanaryReleasesToPrune(entries, 14))).toEqual([
      'v0.1.1-canary.2222222',
      'v0.1.1-canary.1111111',
    ]);
  });

  test('never touches the frozen rolling tag or a stable release', () => {
    const entries: ReleaseListEntry[] = [
      canary('v0.1.1-canary.9999999', '2026-09-12T00:00:00Z'),
      // The pre-immutability rolling tag: no sha, still serving old launchers.
      canary('v0.1.1-canary', '2026-07-05T00:00:00Z'),
      // A stable draft is not this script's to delete either.
      { tagName: 'v0.1.2', isPrerelease: false, isDraft: true, createdAt: '2026-09-12T00:00:00Z' },
      { tagName: 'v0.1.1', isPrerelease: false, isDraft: false, createdAt: '2026-07-05T00:00:00Z' },
      {
        tagName: 'protocol-v0.2.0',
        isPrerelease: false,
        isDraft: false,
        createdAt: '2026-09-10T00:00:00Z',
      },
    ];

    expect(tagsOf(selectCanaryReleasesToPrune(entries, 0))).toEqual(['v0.1.1-canary.9999999']);
  });

  test('matches a git-describe style sha identifier', () => {
    // A short sha that is all digits with a leading zero is an illegal semver
    // numeric identifier, so the release scripts write it `g`-prefixed.
    const entries = [
      canary('v0.1.1-canary.g0123456', '2026-09-12T00:00:00Z'),
      canary('v0.1.1-canary.g0999999', '2026-09-11T00:00:00Z'),
    ];

    expect(tagsOf(selectCanaryReleasesToPrune(entries, 1))).toEqual(['v0.1.1-canary.g0999999']);
  });

  test('keeps everything when there are fewer releases than the window', () => {
    const entries = [canary('v0.1.1-canary.1234567', '2026-09-12T00:00:00Z')];

    expect(selectCanaryReleasesToPrune(entries, 10)).toEqual([]);
  });

  test('refuses a negative keep-window rather than deleting everything', () => {
    expect(() => selectCanaryReleasesToPrune([], -1)).toThrow(/must not be negative/);
  });
});

describe('deleteArgs', () => {
  test('retires the tag with a published release', () => {
    // A tag per green commit accumulates forever otherwise. This is deletable
    // only because the `release tags` ruleset excludes `refs/tags/v*-canary.*`;
    // the frozen `v<root>-canary` tag carries no dot and stays protected.
    expect(deleteArgs({ tagName: 'v0.1.1-canary.0a1b2c3', isDraft: false })).toEqual([
      'gh',
      'release',
      'delete',
      'v0.1.1-canary.0a1b2c3',
      '--yes',
      '--cleanup-tag',
    ]);
  });

  test('leaves the ref alone for a draft', () => {
    // A draft's ref may not exist, and a cleanup that 422s would abort the rest
    // of the prune. An orphan canary ref is free; its name is reserved anyway.
    expect(deleteArgs({ tagName: 'v0.1.1-canary.0a1b2c3', isDraft: true })).toEqual([
      'gh',
      'release',
      'delete',
      'v0.1.1-canary.0a1b2c3',
      '--yes',
    ]);
  });
});

describe('listArgs', () => {
  test('lists drafts so retention can delete them', () => {
    expect(listArgs()).toEqual([
      'gh',
      'release',
      'list',
      '--limit',
      '200',
      '--json',
      'tagName,isPrerelease,isDraft,createdAt',
    ]);
    expect(listArgs()).not.toContain('--exclude-drafts');
  });
});
