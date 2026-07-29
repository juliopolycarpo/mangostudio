/**
 * The removal wizard's decision logic against the apply contract.
 *
 * Every assertion here mirrors a rule the removal API enforces, so a user is
 * never walked into a 422 the form could have prevented — and, in the one place
 * the two could disagree, the form is the stricter of the pair.
 */

import type {
  LibraryLocationId,
  RemovalLocation,
  RemovalPreview,
  RemovalPreviewEntry,
} from '@mangostudio/shared/library';
import { describe, expect, it } from 'vitest';
import {
  acknowledgedLastCopyKeys,
  buildRemovalDecisions,
  eliminatedGroups,
  initialRemovalDraft,
  isEmptySelection,
  lastCopyEntries,
  pendingAcknowledgements,
  plannedRemovals,
  type RemovalDraft,
  removalKey,
} from '../../../../src/features/library/removal';

function location(
  locationId: LibraryLocationId,
  overrides: Partial<RemovalLocation> = {}
): RemovalLocation {
  return {
    locationId,
    targetIds: [],
    operation: 'remove',
    path: `/home/dev/${locationId}/gh`,
    contentHash: 'a3f9c1',
    modifiedAtMs: 1_700_000_000_000,
    eliminatesContentGroup: false,
    ...overrides,
  };
}

function entry(overrides: Partial<RemovalPreviewEntry> = {}): RemovalPreviewEntry {
  const locations = overrides.locations ?? [location('agents-skills'), location('claude-skills')];
  return {
    resourceKey: 'skill:gh',
    ref: { kind: 'skill', slug: 'gh' },
    divergence: 'uniform',
    locations,
    instanceLocationIds: locations.map((row) => row.locationId),
    wouldRemoveLastCopy: true,
    ...overrides,
  };
}

function preview(entries: RemovalPreviewEntry[] = [entry()]): RemovalPreview {
  return { previewToken: 'token', stateHash: 'state', entries, staleStagedRemovals: [] };
}

function removing(...keys: string[]): RemovalDraft {
  return { removing: new Set(keys), acknowledged: new Set() };
}

describe('initialRemovalDraft', () => {
  it('marks nothing, so the safe path is the one that needs no effort', () => {
    const draft = initialRemovalDraft();

    expect(draft.removing.size).toBe(0);
    expect(isEmptySelection(preview(), draft)).toBe(true);
  });
});

describe('plannedRemovals', () => {
  it('ignores a marked location the preview did not classify removable', () => {
    const blocked = preview([
      entry({
        locations: [
          location('claude-skills'),
          location('cursor-skills-builtin', {
            operation: 'blocked',
            blockedReason: 'read-only-location',
          }),
        ],
      }),
    ]);
    const draft = removing(
      removalKey('skill:gh', 'claude-skills'),
      removalKey('skill:gh', 'cursor-skills-builtin')
    );

    expect(plannedRemovals(blocked, draft).map(({ location: row }) => row.locationId)).toEqual([
      'claude-skills',
    ]);
  });
});

describe('lastCopyEntries', () => {
  it('reports a resource whose every copy is marked', () => {
    const draft = removing(
      removalKey('skill:gh', 'agents-skills'),
      removalKey('skill:gh', 'claude-skills')
    );

    expect(lastCopyEntries(preview(), draft)).toHaveLength(1);
  });

  it('does not report one while a copy survives', () => {
    const draft = removing(removalKey('skill:gh', 'claude-skills'));

    expect(lastCopyEntries(preview(), draft)).toEqual([]);
  });

  it('counts copies the preview does not offer, so a scoped preview cannot claim a last copy', () => {
    // Two copies exist; only one is on screen. Removing it leaves one behind.
    const scoped = preview([
      entry({
        locations: [location('claude-skills')],
        instanceLocationIds: ['claude-skills', 'mango-skills'],
      }),
    ]);
    const draft = removing(removalKey('skill:gh', 'claude-skills'));

    expect(lastCopyEntries(scoped, draft)).toEqual([]);
  });
});

describe('pendingAcknowledgements', () => {
  it('blocks until the last-copy removal is signed off', () => {
    const all = preview();
    const draft = removing(
      removalKey('skill:gh', 'agents-skills'),
      removalKey('skill:gh', 'claude-skills')
    );

    expect(pendingAcknowledgements(all, draft)).toHaveLength(1);
    expect(pendingAcknowledgements(all, { ...draft, acknowledged: new Set(['skill:gh']) })).toEqual(
      []
    );
  });

  it('needs no sign-off for an ordinary removal', () => {
    const draft = removing(removalKey('skill:gh', 'claude-skills'));

    expect(pendingAcknowledgements(preview(), draft)).toEqual([]);
  });
});

describe('eliminatedGroups', () => {
  it('flags a marked copy that takes the only copy of its version', () => {
    const divergent = preview([
      entry({
        locations: [
          location('agents-skills'),
          location('claude-skills', {
            contentHash: '7c21e8',
            eliminatesContentGroup: true,
          }),
        ],
      }),
    ]);
    const draft = removing(removalKey('skill:gh', 'claude-skills'));

    expect(eliminatedGroups(divergent, draft)).toHaveLength(1);
  });

  // The preview answers this for every removable copy at once, before the user
  // has chosen anything, so two locations holding the same bytes are both
  // flagged. Repeating that verbatim would warn someone that they are
  // destroying a version they are in fact keeping.
  it('stays quiet when another copy of the same version is being kept', () => {
    const twins = preview([
      entry({
        locations: [
          location('agents-skills', { contentHash: '7c21e8', eliminatesContentGroup: true }),
          location('claude-skills', { contentHash: '7c21e8', eliminatesContentGroup: true }),
        ],
      }),
    ]);

    expect(eliminatedGroups(twins, removing(removalKey('skill:gh', 'claude-skills')))).toEqual([]);
    expect(
      eliminatedGroups(
        twins,
        removing(removalKey('skill:gh', 'claude-skills'), removalKey('skill:gh', 'agents-skills'))
      )
    ).toHaveLength(2);
  });
});

describe('buildRemovalDecisions', () => {
  it('decides every location the preview offered, removed or kept', () => {
    const draft = removing(removalKey('skill:gh', 'claude-skills'));

    expect(buildRemovalDecisions(preview(), draft)).toEqual([
      {
        resourceKey: 'skill:gh',
        locations: [
          { locationId: 'agents-skills', action: 'keep' },
          { locationId: 'claude-skills', action: 'remove' },
        ],
      },
    ]);
  });

  it('keeps a blocked location whatever the draft says', () => {
    const blocked = preview([
      entry({
        locations: [
          location('cursor-skills-builtin', {
            operation: 'blocked',
            blockedReason: 'read-only-location',
          }),
        ],
      }),
    ]);
    const draft = removing(removalKey('skill:gh', 'cursor-skills-builtin'));

    expect(buildRemovalDecisions(blocked, draft)[0].locations).toEqual([
      { locationId: 'cursor-skills-builtin', action: 'keep' },
    ]);
  });
});

describe('acknowledgedLastCopyKeys', () => {
  it('sends a sign-off only while the selection still zeroes the resource', () => {
    const all = preview();
    const acknowledged = new Set(['skill:gh']);

    expect(
      acknowledgedLastCopyKeys(all, {
        removing: new Set([
          removalKey('skill:gh', 'agents-skills'),
          removalKey('skill:gh', 'claude-skills'),
        ]),
        acknowledged,
      })
    ).toEqual(['skill:gh']);

    // One copy unchecked: the API would reject an acknowledgement for a
    // resource this request no longer zeroes, and rightly so.
    expect(
      acknowledgedLastCopyKeys(all, {
        removing: new Set([removalKey('skill:gh', 'claude-skills')]),
        acknowledged,
      })
    ).toEqual([]);
  });
});
