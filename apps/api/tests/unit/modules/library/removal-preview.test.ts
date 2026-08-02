import { describe, expect, it } from 'bun:test';
import type {
  LibraryInstance,
  LibraryLocationId,
  LibraryLocationStatus,
  LibraryResource,
  RemovalLocation,
  RemovalPreviewEntry,
  ResourceKind,
} from '@mangostudio/shared/library';
import { getLibraryLocation } from '@mangostudio/shared/library/host';
import { previewLibraryRemoval } from '../../../../src/modules/library/application/removal-preview';
import { LibraryRequestError } from '../../../../src/modules/library/domain/library-request-error';

function instance(
  locationId: LibraryLocationId,
  contentHash: string,
  overrides: Partial<LibraryInstance> = {}
): LibraryInstance {
  return {
    locationId,
    path: `/home/test/${locationId}/gh`,
    modifiedAtMs: 1,
    format: getLibraryLocation(locationId)?.format ?? 'markdown-frontmatter',
    valid: true,
    contentHash,
    sizeBytes: 12,
    ...overrides,
  } as LibraryInstance;
}

function resource(instances: LibraryInstance[], kind: ResourceKind = 'skill'): LibraryResource {
  return {
    ref: { kind, slug: 'gh' },
    key: `${kind}:gh`,
    instances,
    coverage: [],
    divergence: 'uniform',
    whitespaceOnlyDivergence: false,
    contentGroups: [],
  };
}

function status(
  id: LibraryLocationId,
  overrides: Partial<LibraryLocationStatus> = {}
): LibraryLocationStatus {
  const location = getLibraryLocation(id);
  if (!location) throw new Error(`Unknown test location: ${id}`);
  return {
    id,
    kind: location.kind,
    scope: location.scope,
    path: `/home/test/${id}`,
    access: location.access,
    exists: true,
    readable: true,
    writable: location.access === 'read-write',
    targetIds: [...location.readBy],
    ...overrides,
  };
}

interface PreviewHarness {
  readonly resources?: LibraryResource[];
  readonly statuses?: Partial<Record<LibraryLocationId, LibraryLocationStatus>>;
  readonly enabledLocationIds?: readonly LibraryLocationId[];
  readonly staleStagedRemovals?: { locationId: string; path: string; modifiedAtMs: number }[];
}

function preview(
  resourceKeys: string[],
  locationIds: LibraryLocationId[],
  harness: PreviewHarness = {}
) {
  return previewLibraryRemoval(
    'user-1',
    { resourceKeys, locationIds },
    {
      discover: () => Promise.resolve(harness.resources ?? []),
      describeLocation: (id) => harness.statuses?.[id] ?? status(id),
      enabledLocationIds: () => Promise.resolve(new Set(harness.enabledLocationIds ?? locationIds)),
      pathEnv: () => ({ homeDir: '/home/test', platform: 'linux', env: {} }),
      staleStagedRemovals: () => Promise.resolve(harness.staleStagedRemovals ?? []),
    }
  );
}

function firstEntry(result: { entries: RemovalPreviewEntry[] }): RemovalPreviewEntry {
  const entry = result.entries[0];
  if (!entry) throw new Error('Preview returned no entries.');
  return entry;
}

function locationAt(entry: RemovalPreviewEntry, locationId: LibraryLocationId): RemovalLocation {
  const location = entry.locations.find((candidate) => candidate.locationId === locationId);
  if (!location) throw new Error(`No row for ${locationId}`);
  return location;
}

describe('previewLibraryRemoval classification', () => {
  it('classifies a readable copy in a writable location as removable', async () => {
    const result = await preview(['skill:gh'], ['claude-skills'], {
      resources: [resource([instance('claude-skills', 'hash-a')])],
    });

    const row = locationAt(firstEntry(result), 'claude-skills');
    expect(row.operation).toBe('remove');
    expect(row.path).toBe('/home/test/claude-skills/gh');
    expect(row.contentHash).toBe('hash-a');
  });

  it('shows a location with no copy rather than hiding it', async () => {
    const result = await preview(['skill:gh'], ['claude-skills', 'mango-skills'], {
      resources: [resource([instance('claude-skills', 'hash-a')])],
    });

    const row = locationAt(firstEntry(result), 'mango-skills');
    expect(row.operation).toBe('absent');
    expect(row.path).toBeNull();
  });

  it('blocks removal from a read-only location', async () => {
    const result = await preview(['skill:gh'], ['cursor-skills-builtin'], {
      resources: [resource([instance('cursor-skills-builtin', 'hash-a')])],
    });

    const row = locationAt(firstEntry(result), 'cursor-skills-builtin');
    expect(row.operation).toBe('blocked');
    expect(row.blockedReason).toBe('read-only-location');
  });

  it('blocks removal from an unwritable location', async () => {
    const result = await preview(['skill:gh'], ['claude-skills'], {
      resources: [resource([instance('claude-skills', 'hash-a')])],
      statuses: { 'claude-skills': status('claude-skills', { writable: false }) },
    });

    expect(locationAt(firstEntry(result), 'claude-skills').blockedReason).toBe(
      'location-unwritable'
    );
  });

  it('blocks an instance the scanner could not read, never classifying it removable', async () => {
    const result = await preview(['skill:gh'], ['claude-skills'], {
      resources: [
        resource([
          instance('claude-skills', 'hash-a', {
            valid: false,
            invalidReason: 'unreadable',
          } as Partial<LibraryInstance>),
        ]),
      ],
    });

    const row = locationAt(firstEntry(result), 'claude-skills');
    expect(row.operation).toBe('blocked');
    expect(row.blockedReason).toBe('invalid-instance');
  });

  it('offers only locations that store the resource kind', async () => {
    const result = await preview(['skill:gh'], ['claude-skills', 'claude-agents'], {
      resources: [resource([instance('claude-skills', 'hash-a')])],
    });

    expect(firstEntry(result).locations.map((row) => row.locationId)).toEqual(['claude-skills']);
  });

  it('refuses a location the scanner is not allowed to see', async () => {
    await expect(
      preview(['skill:gh'], ['claude-skills'], {
        resources: [resource([instance('claude-skills', 'hash-a')])],
        enabledLocationIds: [],
      })
    ).rejects.toBeInstanceOf(LibraryRequestError);
  });
});

describe('previewLibraryRemoval last-copy detection', () => {
  it('reports the last copy when every location holding one is on offer', async () => {
    const result = await preview(['skill:gh'], ['claude-skills', 'mango-skills'], {
      resources: [
        resource([instance('claude-skills', 'hash-a'), instance('mango-skills', 'hash-a')]),
      ],
    });

    expect(firstEntry(result).wouldRemoveLastCopy).toBe(true);
  });

  it('does not report a last copy while one location is left out', async () => {
    const result = await preview(['skill:gh'], ['claude-skills'], {
      resources: [
        resource([instance('claude-skills', 'hash-a'), instance('mango-skills', 'hash-a')]),
      ],
    });

    const entry = firstEntry(result);
    expect(entry.wouldRemoveLastCopy).toBe(false);
    // The guard is decided against every copy, including ones not on offer.
    expect(entry.instanceLocationIds).toEqual(['claude-skills', 'mango-skills']);
  });

  it('does not report a last copy when a blocked instance survives', async () => {
    const result = await preview(['skill:gh'], ['claude-skills', 'cursor-skills-builtin'], {
      resources: [
        resource([
          instance('claude-skills', 'hash-a'),
          instance('cursor-skills-builtin', 'hash-a'),
        ]),
      ],
    });

    expect(firstEntry(result).wouldRemoveLastCopy).toBe(false);
  });

  it('reports no last copy when nothing on offer can be removed', async () => {
    const result = await preview(['skill:gh'], ['cursor-skills-builtin'], {
      resources: [resource([instance('cursor-skills-builtin', 'hash-a')])],
    });

    expect(firstEntry(result).wouldRemoveLastCopy).toBe(false);
  });
});

describe('previewLibraryRemoval content groups', () => {
  it('marks a removal that would take the only copy of its version', async () => {
    const result = await preview(['skill:gh'], ['claude-skills', 'mango-skills'], {
      resources: [
        resource([instance('claude-skills', 'hash-a'), instance('mango-skills', 'hash-b')]),
      ],
    });

    const entry = firstEntry(result);
    expect(locationAt(entry, 'claude-skills').eliminatesContentGroup).toBe(true);
    expect(locationAt(entry, 'mango-skills').eliminatesContentGroup).toBe(true);
  });

  it('does not mark a removal whose version survives elsewhere', async () => {
    const result = await preview(['skill:gh'], ['claude-skills'], {
      resources: [
        resource([instance('claude-skills', 'hash-a'), instance('mango-skills', 'hash-a')]),
      ],
    });

    expect(locationAt(firstEntry(result), 'claude-skills').eliminatesContentGroup).toBe(false);
  });
});

describe('previewLibraryRemoval tokens', () => {
  it('binds the token to the observation, so an edited copy mints a different one', async () => {
    const before = await preview(['skill:gh'], ['claude-skills'], {
      resources: [resource([instance('claude-skills', 'hash-a')])],
    });
    const after = await preview(['skill:gh'], ['claude-skills'], {
      resources: [resource([instance('claude-skills', 'hash-b')])],
    });

    expect(after.previewToken).not.toBe(before.previewToken);
    expect(after.stateHash).not.toBe(before.stateHash);
  });

  it('surfaces temp trees an interrupted removal left behind', async () => {
    const result = await preview(['skill:gh'], ['claude-skills'], {
      resources: [resource([instance('claude-skills', 'hash-a')])],
      staleStagedRemovals: [
        {
          locationId: 'claude-skills',
          path: '/home/test/claude-skills/.gh.abc.removing',
          modifiedAtMs: 5,
        },
      ],
    });

    expect(result.staleStagedRemovals).toHaveLength(1);
  });
});
