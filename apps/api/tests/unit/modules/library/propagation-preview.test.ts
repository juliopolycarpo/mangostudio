import { describe, expect, it } from 'bun:test';
import type {
  AdapterStrategy,
  LibraryInstance,
  LibraryLocationId,
  LibraryLocationStatus,
  LibraryResource,
  PropagationDestination,
  PropagationPreviewEntry,
  ResourceFormat,
  ResourceKind,
} from '@mangostudio/shared/library';
import { previewLibraryPropagation } from '../../../../src/modules/library/application/propagation-preview';
import type { AdapterCatalog } from '../../../../src/modules/library/domain/format-adapters';
import { LibraryRequestError } from '../../../../src/modules/library/domain/library-request-error';
import { getLibraryLocation } from '../../../../src/modules/library/domain/registry';

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

function resource(
  key: string,
  kind: ResourceKind,
  slug: string,
  instances: LibraryInstance[]
): LibraryResource {
  return {
    ref: { kind, slug },
    key,
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
  readonly adapters?: AdapterCatalog;
  readonly acknowledged?: string[];
  readonly onDiscover?: (kinds: readonly ResourceKind[]) => void;
  /** Defaults to "every requested location is enabled" so cases opt in explicitly. */
  readonly enabledLocationIds?: readonly LibraryLocationId[];
}

function preview(
  resourceKeys: string[],
  targetLocationIds: LibraryLocationId[],
  harness: PreviewHarness = {}
) {
  return previewLibraryPropagation(
    'user-1',
    { resourceKeys, targetLocationIds },
    {
      discover: (_userId, kinds) => {
        harness.onDiscover?.(kinds);
        return Promise.resolve(harness.resources ?? []);
      },
      describeLocation: (id) => harness.statuses?.[id] ?? status(id),
      acknowledgedKeys: () => Promise.resolve(new Set(harness.acknowledged ?? [])),
      enabledLocationIds: () =>
        Promise.resolve(new Set(harness.enabledLocationIds ?? targetLocationIds)),
      agentAvailable: () => Promise.resolve(false),
      ...(harness.adapters && { adapters: harness.adapters }),
    }
  );
}

function destinationAt(
  entry: PropagationPreviewEntry,
  locationId: LibraryLocationId
): PropagationDestination {
  const destination = entry.destinations.find((candidate) => candidate.locationId === locationId);
  if (!destination) throw new Error(`No destination for ${locationId}`);
  return destination;
}

function firstEntry(result: { entries: PropagationPreviewEntry[] }): PropagationPreviewEntry {
  const entry = result.entries[0];
  if (!entry) throw new Error('Preview returned no entries.');
  return entry;
}

const ghSkill = resource('skill:gh', 'skill', 'gh', [
  instance('mango-skills', 'hash-a'),
  instance('claude-skills', 'hash-b'),
]);

describe('previewLibraryPropagation — operation classification', () => {
  it('classifies create, overwrite, and noop against real destination hashes', async () => {
    const result = await preview(['skill:gh'], ['mango-skills', 'claude-skills', 'agents-skills'], {
      resources: [
        resource('skill:gh', 'skill', 'gh', [
          instance('mango-skills', 'hash-a'),
          instance('claude-skills', 'hash-b'),
        ]),
      ],
    });

    const entry = firstEntry(result);
    const operationsFor = (id: LibraryLocationId) =>
      Object.fromEntries(
        destinationAt(entry, id).outcomes.map((outcome) => [
          outcome.winnerContentHash,
          outcome.operation,
        ])
      );

    expect(operationsFor('mango-skills')).toEqual({ 'hash-a': 'noop', 'hash-b': 'overwrite' });
    expect(operationsFor('claude-skills')).toEqual({ 'hash-a': 'overwrite', 'hash-b': 'noop' });
    expect(operationsFor('agents-skills')).toEqual({ 'hash-a': 'create', 'hash-b': 'create' });
  });

  it('reports every candidate winner instead of picking one', async () => {
    const entry = firstEntry(
      await preview(['skill:gh'], ['agents-skills'], { resources: [ghSkill] })
    );

    expect(entry.requiresWinnerSelection).toBe(true);
    expect(entry.sourceGroups.map((group) => group.contentHash).sort()).toEqual([
      'hash-a',
      'hash-b',
    ]);
    expect(destinationAt(entry, 'agents-skills').outcomes).toHaveLength(2);
  });

  it('does not require a winner when every readable copy agrees', async () => {
    const entry = firstEntry(
      await preview(['skill:gh'], ['agents-skills'], {
        resources: [
          resource('skill:gh', 'skill', 'gh', [
            instance('mango-skills', 'same'),
            instance('claude-skills', 'same'),
          ]),
        ],
      })
    );

    expect(entry.requiresWinnerSelection).toBe(false);
    expect(entry.sourceGroups).toHaveLength(1);
    expect(entry.sourceGroups[0]).toMatchObject({
      instanceCount: 2,
      locationIds: ['claude-skills', 'mango-skills'],
      contentLocationId: 'claude-skills',
      sizeBytes: 12,
    });
  });

  it('reports the newest modification time and format per candidate winner', async () => {
    const entry = firstEntry(
      await preview(['skill:gh'], ['agents-skills'], {
        resources: [
          resource('skill:gh', 'skill', 'gh', [
            instance('mango-skills', 'same', { modifiedAtMs: 10 }),
            instance('claude-skills', 'same', { modifiedAtMs: 4_000 }),
          ]),
        ],
      })
    );

    expect(entry.sourceGroups[0]?.newestModifiedAtMs).toBe(4_000);
    expect(entry.sourceGroups[0]?.formats).toEqual(['markdown-frontmatter']);
  });

  it('scans only the kinds the request needs', async () => {
    const kinds: ResourceKind[][] = [];
    await preview(['skill:gh'], ['agents-skills'], {
      resources: [ghSkill],
      onDiscover: (requested) => kinds.push([...requested]),
    });

    expect(kinds).toEqual([['skill']]);
  });
});

describe('previewLibraryPropagation — blocked destinations', () => {
  const blockedReasonFor = async (
    locationId: LibraryLocationId,
    harness: PreviewHarness
  ): Promise<string | undefined> => {
    const entry = firstEntry(await preview(['skill:gh'], [locationId], harness));
    return destinationAt(entry, locationId).blockedReason;
  };

  it('blocks a read-only vendor location', async () => {
    expect(await blockedReasonFor('cursor-skills-builtin', { resources: [ghSkill] })).toBe(
      'read-only-location'
    );
  });

  it('blocks a location unsupported on this platform', async () => {
    expect(
      await blockedReasonFor('cursor-skills', {
        resources: [ghSkill],
        statuses: { 'cursor-skills': status('cursor-skills', { path: null, exists: false }) },
      })
    ).toBe('unsupported-location');
  });

  it('blocks a destination whose nearest existing ancestor is not writable', async () => {
    expect(
      await blockedReasonFor('cursor-skills', {
        resources: [ghSkill],
        statuses: { 'cursor-skills': status('cursor-skills', { writable: false }) },
      })
    ).toBe('location-unwritable');
  });

  it('blocks rather than overwriting a destination the scanner could not read', async () => {
    expect(
      await blockedReasonFor('claude-skills', {
        resources: [
          resource('skill:gh', 'skill', 'gh', [
            instance('mango-skills', 'hash-a'),
            {
              locationId: 'claude-skills',
              path: '/home/test/claude-skills/gh',
              modifiedAtMs: 1,
              format: 'markdown-frontmatter',
              valid: false,
              invalidReason: 'unreadable',
            },
          ]),
        ],
      })
    ).toBe('invalid-destination');
  });

  it('blocks when no copy of the resource could be hashed', async () => {
    expect(
      await blockedReasonFor('claude-skills', {
        resources: [
          resource('skill:gh', 'skill', 'gh', [
            {
              locationId: 'mango-skills',
              path: '/home/test/mango-skills/gh',
              modifiedAtMs: 1,
              format: 'markdown-frontmatter',
              valid: false,
              invalidReason: 'missing-entrypoint',
            },
          ]),
        ],
      })
    ).toBe('no-source-content');
  });

  it('blocks a single-file destination that stores a different named resource', async () => {
    const entry = firstEntry(
      await preview(['instruction:project'], ['claude-instructions'], {
        resources: [
          resource('instruction:project', 'instruction', 'project', [
            instance('cursor-rules', 'hash-a'),
          ]),
        ],
      })
    );

    expect(destinationAt(entry, 'claude-instructions').blockedReason).toBe('slug-mismatch');
  });

  it('leaves a blocked destination with no outcomes to act on', async () => {
    const entry = firstEntry(
      await preview(['skill:gh'], ['cursor-skills-builtin'], { resources: [ghSkill] })
    );

    expect(destinationAt(entry, 'cursor-skills-builtin').outcomes).toEqual([]);
  });

  it('offers only destinations that store the same resource kind', async () => {
    const entry = firstEntry(
      await preview(['skill:gh'], ['claude-skills', 'claude-agents'], { resources: [ghSkill] })
    );

    expect(entry.destinations.map((destination) => destination.locationId)).toEqual([
      'claude-skills',
    ]);
  });
});

describe('previewLibraryPropagation — format adaptation', () => {
  const mdcAdapters: AdapterCatalog = {
    strategiesFor: ({ from, to }): AdapterStrategy[] => {
      if (from === to) return ['verbatim'];
      return from === 'markdown-plain' && to === 'mdc' ? ['agent', 'mechanical'] : [];
    },
  };

  const globalInstruction = (extra: LibraryInstance[] = []) =>
    resource('instruction:global', 'instruction', 'global', [
      instance('claude-instructions', 'hash-a', { format: 'markdown-plain' as ResourceFormat }),
      ...extra,
    ]);

  it('classifies a format change as adapt-create and recommends the most faithful strategy', async () => {
    const entry = firstEntry(
      await preview(['instruction:global'], ['cursor-rules'], {
        resources: [globalInstruction()],
        adapters: mdcAdapters,
      })
    );

    const [outcome] = destinationAt(entry, 'cursor-rules').outcomes;
    expect(outcome?.operation).toBe('adapt-create');
    expect(outcome?.adaptation).toEqual({
      fromFormat: 'markdown-plain',
      toFormat: 'mdc',
      availableStrategies: ['mechanical', 'agent'],
      recommendedStrategy: 'mechanical',
    });
  });

  it('classifies a format change over existing content as adapt-overwrite', async () => {
    const entry = firstEntry(
      await preview(['instruction:global'], ['cursor-rules'], {
        resources: [
          globalInstruction([
            instance('cursor-rules', 'hash-b', { format: 'mdc' as ResourceFormat }),
          ]),
        ],
        adapters: mdcAdapters,
      })
    );

    const outcomes = destinationAt(entry, 'cursor-rules').outcomes;
    expect(outcomes.find((outcome) => outcome.winnerContentHash === 'hash-a')?.operation).toBe(
      'adapt-overwrite'
    );
    // The winner already stored as `mdc` needs no conversion at all.
    expect(outcomes.find((outcome) => outcome.winnerContentHash === 'hash-b')?.operation).toBe(
      'noop'
    );
  });

  it('blocks a format change no adapter can perform', async () => {
    const entry = firstEntry(
      await preview(['instruction:global'], ['cursor-rules'], {
        resources: [globalInstruction()],
        adapters: { strategiesFor: () => [] },
      })
    );

    const [outcome] = destinationAt(entry, 'cursor-rules').outcomes;
    expect(outcome?.operation).toBe('blocked');
    expect(outcome?.blockedReason).toBe('no-adapter-strategy');
    expect(outcome?.adaptation?.availableStrategies).toEqual([]);
  });
});

describe('previewLibraryPropagation — staleness binding', () => {
  const previewGh = (instances: LibraryInstance[], statuses?: PreviewHarness['statuses']) =>
    preview(['skill:gh'], ['claude-skills'], {
      resources: [resource('skill:gh', 'skill', 'gh', instances)],
      ...(statuses && { statuses }),
    });

  it('produces a stable token and hash for unchanged state', async () => {
    const first = await previewGh([instance('mango-skills', 'hash-a')]);
    const second = await previewGh([instance('mango-skills', 'hash-a')]);

    expect(second.stateHash).toBe(first.stateHash);
    expect(second.previewToken).toBe(first.previewToken);
  });

  it('changes the state hash when a source file changes', async () => {
    const before = await previewGh([instance('mango-skills', 'hash-a')]);
    const after = await previewGh([instance('mango-skills', 'hash-z')]);

    expect(after.stateHash).not.toBe(before.stateHash);
  });

  it('changes the state hash when the destination changes', async () => {
    const before = await previewGh([instance('mango-skills', 'hash-a')]);
    const after = await previewGh([
      instance('mango-skills', 'hash-a'),
      instance('claude-skills', 'hash-c'),
    ]);

    expect(after.stateHash).not.toBe(before.stateHash);
  });

  it('changes the state hash when a destination stops being writable', async () => {
    const before = await previewGh([instance('mango-skills', 'hash-a')]);
    const after = await previewGh([instance('mango-skills', 'hash-a')], {
      'claude-skills': status('claude-skills', { writable: false }),
    });

    expect(after.stateHash).not.toBe(before.stateHash);
  });

  it('binds the token to the requested destinations, not just to disk state', async () => {
    const narrow = await preview(['skill:gh'], ['claude-skills'], { resources: [ghSkill] });
    const wide = await preview(['skill:gh'], ['claude-skills', 'agents-skills'], {
      resources: [ghSkill],
    });

    expect(wide.previewToken).not.toBe(narrow.previewToken);
  });
});

describe('previewLibraryPropagation — request validation', () => {
  it('rejects a malformed resource key', async () => {
    const failure = preview(['not-a-key'], ['claude-skills'], { resources: [ghSkill] });
    await expect(failure).rejects.toBeInstanceOf(LibraryRequestError);
    await expect(failure).rejects.toMatchObject({ status: 422 });
  });

  it('rejects an unknown location id', async () => {
    const failure = preview(['skill:gh'], ['not-a-location' as LibraryLocationId], {
      resources: [ghSkill],
    });
    await expect(failure).rejects.toMatchObject({ status: 422 });
  });

  it('reports a resource that the rescan did not find', async () => {
    const failure = preview(['skill:missing'], ['claude-skills'], { resources: [ghSkill] });
    await expect(failure).rejects.toMatchObject({ status: 404 });
  });

  it('deduplicates repeated keys and locations', async () => {
    const result = await preview(['skill:gh', 'skill:gh'], ['claude-skills', 'claude-skills'], {
      resources: [ghSkill],
    });

    expect(result.entries).toHaveLength(1);
    expect(firstEntry(result).destinations).toHaveLength(1);
  });
});
