import { describe, expect, it } from 'bun:test';
import type {
  LibraryInstance,
  LibraryLocationId,
  LibraryResource,
} from '@mangostudio/shared/library';
import {
  acknowledgeDivergence,
  acknowledgedResourceKeys,
  type DivergenceAckDeps,
  divergenceKeyFor,
  forgetDivergenceAck,
  listDivergenceAcks,
  readableContentHashes,
} from '../../../../src/modules/library/application/conflict-resolution';
import type {
  DivergenceAckRecord,
  DivergenceAckRepository,
} from '../../../../src/modules/library/infrastructure/divergence-ack-repository';

function instance(locationId: LibraryLocationId, contentHash: string): LibraryInstance {
  return {
    locationId,
    path: `/home/test/${locationId}/gh`,
    modifiedAtMs: 1,
    format: 'markdown-frontmatter',
    valid: true,
    contentHash,
    sizeBytes: 4,
  };
}

function ghSkill(instances: LibraryInstance[]): LibraryResource {
  return {
    ref: { kind: 'skill', slug: 'gh' },
    key: 'skill:gh',
    instances,
    coverage: [],
    divergence: 'divergent',
    whitespaceOnlyDivergence: false,
    contentGroups: [],
  };
}

interface MemoryRepository extends DivergenceAckRepository {
  readonly rows: Map<string, DivergenceAckRecord>;
}

function memoryRepository(seed: DivergenceAckRecord[] = []): MemoryRepository {
  const rows = new Map(seed.map((record) => [record.resourceKey, record] as const));
  return {
    rows,
    list: () => Promise.resolve([...rows.values()]),
    listFor: (_userId, _profileId, resourceKeys) =>
      Promise.resolve(
        resourceKeys.flatMap((key) => {
          const record = rows.get(key);
          return record ? [record] : [];
        })
      ),
    upsert: (_userId, _profileId, record) => {
      rows.set(record.resourceKey, record);
      return Promise.resolve();
    },
    remove: (_userId, _profileId, resourceKeys) => {
      for (const key of resourceKeys) rows.delete(key);
      return Promise.resolve();
    },
  };
}

function deps(
  repository: DivergenceAckRepository,
  resources: LibraryResource[] = []
): Partial<DivergenceAckDeps> {
  return { repository, discover: () => Promise.resolve(resources), now: () => 1_700_000 };
}

describe('divergenceKeyFor', () => {
  it('is independent of order and duplication', () => {
    expect(divergenceKeyFor(['b', 'a'])).toBe(divergenceKeyFor(['a', 'b', 'a']));
  });

  it('changes when any accepted hash changes', () => {
    expect(divergenceKeyFor(['a', 'b'])).not.toBe(divergenceKeyFor(['a', 'c']));
  });
});

describe('readableContentHashes', () => {
  it('leaves out copies the scanner could not read', () => {
    const resource = ghSkill([
      instance('mango-skills', 'hash-a'),
      {
        locationId: 'claude-skills',
        path: '/home/test/claude-skills/gh',
        modifiedAtMs: 1,
        format: 'markdown-frontmatter',
        valid: false,
        invalidReason: 'unreadable',
      },
    ]);

    expect(readableContentHashes(resource)).toEqual(['hash-a']);
  });
});

describe('acknowledgeDivergence', () => {
  const divergent = ghSkill([
    instance('mango-skills', 'hash-a'),
    instance('claude-skills', 'hash-b'),
  ]);

  it('records the accepted hash set', async () => {
    const repository = memoryRepository();
    const ack = await acknowledgeDivergence(
      'user-1',
      { resourceKey: 'skill:gh', contentHashes: ['hash-b', 'hash-a'] },
      deps(repository, [divergent])
    );

    expect(ack).toEqual({
      resourceKey: 'skill:gh',
      contentHashes: ['hash-a', 'hash-b'],
      acknowledgedAtMs: 1_700_000,
    });
    expect(repository.rows.get('skill:gh')?.divergenceKey).toBe(
      divergenceKeyFor(['hash-a', 'hash-b'])
    );
  });

  it('refuses to accept a divergence the client did not see', async () => {
    const repository = memoryRepository();
    const failure = acknowledgeDivergence(
      'user-1',
      { resourceKey: 'skill:gh', contentHashes: ['hash-a', 'hash-stale'] },
      deps(repository, [divergent])
    );

    await expect(failure).rejects.toMatchObject({ status: 409 });
    expect(repository.rows.size).toBe(0);
  });

  it('refuses a resource that is not divergent', async () => {
    const uniform = ghSkill([instance('mango-skills', 'hash-a')]);
    const failure = acknowledgeDivergence(
      'user-1',
      { resourceKey: 'skill:gh', contentHashes: ['hash-a', 'hash-b'] },
      deps(memoryRepository(), [uniform])
    );

    await expect(failure).rejects.toMatchObject({ status: 422 });
  });

  it('reports a resource the rescan no longer finds', async () => {
    const failure = acknowledgeDivergence(
      'user-1',
      { resourceKey: 'skill:gh', contentHashes: ['hash-a', 'hash-b'] },
      deps(memoryRepository(), [])
    );

    await expect(failure).rejects.toMatchObject({ status: 404 });
  });

  it('rejects a malformed resource key before scanning', async () => {
    let scanned = false;
    const failure = acknowledgeDivergence(
      'user-1',
      { resourceKey: 'not-a-key', contentHashes: ['hash-a', 'hash-b'] },
      {
        repository: memoryRepository(),
        discover: () => {
          scanned = true;
          return Promise.resolve([]);
        },
      }
    );

    await expect(failure).rejects.toMatchObject({ status: 422 });
    expect(scanned).toBe(false);
  });

  it('replaces the previous acknowledgement instead of stacking rows', async () => {
    const repository = memoryRepository();
    await acknowledgeDivergence(
      'user-1',
      { resourceKey: 'skill:gh', contentHashes: ['hash-a', 'hash-b'] },
      deps(repository, [divergent])
    );
    await acknowledgeDivergence(
      'user-1',
      { resourceKey: 'skill:gh', contentHashes: ['hash-a', 'hash-b'] },
      deps(repository, [divergent])
    );

    expect(repository.rows.size).toBe(1);
  });
});

describe('acknowledgedResourceKeys', () => {
  const record: DivergenceAckRecord = {
    resourceKey: 'skill:gh',
    divergenceKey: divergenceKeyFor(['hash-a', 'hash-b']),
    contentHashes: ['hash-a', 'hash-b'],
    acknowledgedAtMs: 1,
  };

  it('honours an acknowledgement while the accepted hashes still hold', async () => {
    const repository = memoryRepository([record]);
    const resource = ghSkill([
      instance('mango-skills', 'hash-a'),
      instance('claude-skills', 'hash-b'),
    ]);

    expect([...(await acknowledgedResourceKeys('user-1', [resource], deps(repository)))]).toEqual([
      'skill:gh',
    ]);
  });

  it('retires an acknowledgement once a copy changes, and forgets the row', async () => {
    const repository = memoryRepository([record]);
    const edited = ghSkill([
      instance('mango-skills', 'hash-a'),
      instance('claude-skills', 'hash-edited'),
    ]);

    expect([...(await acknowledgedResourceKeys('user-1', [edited], deps(repository)))]).toEqual([]);
    expect(repository.rows.size).toBe(0);
  });

  it('retires an acknowledgement when the divergence resolves entirely', async () => {
    const repository = memoryRepository([record]);
    const converged = ghSkill([
      instance('mango-skills', 'hash-a'),
      instance('claude-skills', 'hash-a'),
    ]);

    expect([...(await acknowledgedResourceKeys('user-1', [converged], deps(repository)))]).toEqual(
      []
    );
    expect(repository.rows.size).toBe(0);
  });
});

describe('listDivergenceAcks and forgetDivergenceAck', () => {
  it('lists stored acknowledgements without the internal digest', async () => {
    const repository = memoryRepository([
      {
        resourceKey: 'skill:gh',
        divergenceKey: 'digest',
        contentHashes: ['hash-a', 'hash-b'],
        acknowledgedAtMs: 42,
      },
    ]);

    expect(await listDivergenceAcks('user-1', deps(repository))).toEqual([
      { resourceKey: 'skill:gh', contentHashes: ['hash-a', 'hash-b'], acknowledgedAtMs: 42 },
    ]);
  });

  it('forgets one resource and leaves the rest alone', async () => {
    const repository = memoryRepository([
      {
        resourceKey: 'skill:gh',
        divergenceKey: 'digest',
        contentHashes: ['hash-a', 'hash-b'],
        acknowledgedAtMs: 1,
      },
      {
        resourceKey: 'skill:review',
        divergenceKey: 'digest',
        contentHashes: ['hash-c', 'hash-d'],
        acknowledgedAtMs: 1,
      },
    ]);

    await forgetDivergenceAck('user-1', 'skill:gh', deps(repository));

    expect([...repository.rows.keys()]).toEqual(['skill:review']);
  });
});
