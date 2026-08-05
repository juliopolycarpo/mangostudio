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
    environmentId: 'local',
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
    instancePlacements: locations.map((row) => ({
      environmentId: row.environmentId,
      locationId: row.locationId,
    })),
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
      removalKey('skill:gh', 'local', 'claude-skills'),
      removalKey('skill:gh', 'local', 'cursor-skills-builtin')
    );

    expect(plannedRemovals(blocked, draft).map(({ location: row }) => row.locationId)).toEqual([
      'claude-skills',
    ]);
  });
});

describe('lastCopyEntries', () => {
  it('reports a resource whose every copy is marked', () => {
    const draft = removing(
      removalKey('skill:gh', 'local', 'agents-skills'),
      removalKey('skill:gh', 'local', 'claude-skills')
    );

    expect(lastCopyEntries(preview(), draft)).toHaveLength(1);
  });

  it('does not report one while a copy survives', () => {
    const draft = removing(removalKey('skill:gh', 'local', 'claude-skills'));

    expect(lastCopyEntries(preview(), draft)).toEqual([]);
  });

  it('counts copies the preview does not offer, so a scoped preview cannot claim a last copy', () => {
    // Two copies exist; only one is on screen. Removing it leaves one behind.
    const scoped = preview([
      entry({
        locations: [location('claude-skills')],
        instancePlacements: [
          { environmentId: 'local', locationId: 'claude-skills' },
          { environmentId: 'local', locationId: 'mango-skills' },
        ],
      }),
    ]);
    const draft = removing(removalKey('skill:gh', 'local', 'claude-skills'));

    expect(lastCopyEntries(scoped, draft)).toEqual([]);
  });
});

describe('pendingAcknowledgements', () => {
  it('blocks until the last-copy removal is signed off', () => {
    const all = preview();
    const draft = removing(
      removalKey('skill:gh', 'local', 'agents-skills'),
      removalKey('skill:gh', 'local', 'claude-skills')
    );

    expect(pendingAcknowledgements(all, draft)).toHaveLength(1);
    expect(pendingAcknowledgements(all, { ...draft, acknowledged: new Set(['skill:gh']) })).toEqual(
      []
    );
  });

  it('needs no sign-off for an ordinary removal', () => {
    const draft = removing(removalKey('skill:gh', 'local', 'claude-skills'));

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
    const draft = removing(removalKey('skill:gh', 'local', 'claude-skills'));

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

    expect(
      eliminatedGroups(twins, removing(removalKey('skill:gh', 'local', 'claude-skills')))
    ).toEqual([]);
    expect(
      eliminatedGroups(
        twins,
        removing(
          removalKey('skill:gh', 'local', 'claude-skills'),
          removalKey('skill:gh', 'local', 'agents-skills')
        )
      )
    ).toHaveLength(2);
  });
});

describe('buildRemovalDecisions', () => {
  it('decides every location the preview offered, removed or kept', () => {
    const draft = removing(removalKey('skill:gh', 'local', 'claude-skills'));

    expect(buildRemovalDecisions(preview(), draft)).toEqual([
      {
        resourceKey: 'skill:gh',
        locations: [
          { environmentId: 'local', locationId: 'agents-skills', action: 'keep' },
          { environmentId: 'local', locationId: 'claude-skills', action: 'remove' },
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
    const draft = removing(removalKey('skill:gh', 'local', 'cursor-skills-builtin'));

    expect(buildRemovalDecisions(blocked, draft)[0].locations).toEqual([
      { environmentId: 'local', locationId: 'cursor-skills-builtin', action: 'keep' },
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
          removalKey('skill:gh', 'local', 'agents-skills'),
          removalKey('skill:gh', 'local', 'claude-skills'),
        ]),
        acknowledged,
      })
    ).toEqual(['skill:gh']);

    // One copy unchecked: the API would reject an acknowledgement for a
    // resource this request no longer zeroes, and rightly so.
    expect(
      acknowledgedLastCopyKeys(all, {
        removing: new Set([removalKey('skill:gh', 'local', 'claude-skills')]),
        acknowledged,
      })
    ).toEqual([]);
  });
});

/*
  The machine dimension in the wizard's own reasoning.

  Marking `claude-skills` must mean one machine's copy, not every machine's —
  and the last-copy sign-off has to count copies on machines whose rows the user
  never touched, or it asks for the wrong thing.
*/
describe('removal across machines', () => {
  const onTwoMachines = () =>
    preview([
      entry({
        locations: [
          location('claude-skills'),
          location('claude-skills', { environmentId: 'wsl-ubuntu' }),
        ],
        instancePlacements: [
          { environmentId: 'local', locationId: 'claude-skills' },
          { environmentId: 'wsl-ubuntu', locationId: 'claude-skills' },
        ],
      }),
    ]);

  it('marks one copy on one machine, not the same location everywhere', () => {
    const draft = removing(removalKey('skill:gh', 'local', 'claude-skills'));

    const planned = plannedRemovals(onTwoMachines(), draft);
    expect(planned).toHaveLength(1);
    expect(planned[0].location.environmentId).toBe('local');
  });

  it('is not a last copy while another machine still has one', () => {
    const draft = removing(removalKey('skill:gh', 'local', 'claude-skills'));

    expect(lastCopyEntries(onTwoMachines(), draft)).toEqual([]);
  });

  it('is a last copy once every machine has its copy marked', () => {
    const draft = removing(
      removalKey('skill:gh', 'local', 'claude-skills'),
      removalKey('skill:gh', 'wsl-ubuntu', 'claude-skills')
    );

    expect(lastCopyEntries(onTwoMachines(), draft)).toHaveLength(1);
    expect(pendingAcknowledgements(onTwoMachines(), draft)).toHaveLength(1);
  });

  it('sends a decision per machine, so the API can tell the copies apart', () => {
    const draft = removing(removalKey('skill:gh', 'wsl-ubuntu', 'claude-skills'));

    const [decision] = buildRemovalDecisions(onTwoMachines(), draft);
    expect(decision.locations).toEqual([
      { environmentId: 'local', locationId: 'claude-skills', action: 'keep' },
      { environmentId: 'wsl-ubuntu', locationId: 'claude-skills', action: 'remove' },
    ]);
  });
});
