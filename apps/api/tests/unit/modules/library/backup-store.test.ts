import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type BackupEntry,
  type BackupManifest,
  type BackupStoreDeps,
  backupExistingResource,
  createBackupId,
  defaultBackupStoreDeps,
  discardBackupSet,
  listBackupSets,
  pruneBackupSets,
  purgeBackupSet,
  readBackupManifest,
  restoreBackupEntry,
  writeBackupManifest,
} from '../../../../src/modules/library/infrastructure/backup-store';

let root: string;
let backupRoot: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mango-backup-store-'));
  backupRoot = join(root, 'backups');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function deps(overrides: Partial<BackupStoreDeps> = {}): BackupStoreDeps {
  return {
    ...defaultBackupStoreDeps,
    backupDir: () => backupRoot,
    retentionCount: () => 10,
    retentionBytes: () => 1024 ** 3,
    now: () => new Date('2026-07-27T10:00:00.000Z'),
    randomSuffix: () => 'fixed',
    ...overrides,
  };
}

/** Creates a backup set shaped the way an apply writes one. */
function seedBackupSet(id: string, bytes: number, modifiedAtMs?: number): string {
  const setPath = join(backupRoot, id, 'claude-skills', 'gh');
  mkdirSync(setPath, { recursive: true });
  writeFileSync(join(setPath, 'SKILL.md'), 'x'.repeat(bytes));
  if (modifiedAtMs !== undefined) {
    const seconds = modifiedAtMs / 1000;
    utimesSync(join(backupRoot, id), seconds, seconds);
  }
  return join(backupRoot, id);
}

/** The same shape, plus the manifest a last-copy removal writes. */
function seedPinnedBackupSet(id: string, bytes: number, modifiedAtMs?: number): string {
  const setPath = seedBackupSet(id, bytes);
  seedManifest(setPath, id, {
    version: 2,
    operation: 'removal',
    pinned: true,
    lastCopyResourceKeys: ['skill:gh'],
  });
  if (modifiedAtMs !== undefined) {
    const seconds = modifiedAtMs / 1000;
    utimesSync(setPath, seconds, seconds);
  }
  return setPath;
}

/**
 * Writes a manifest over a seeded set. `version` and the entry shape are
 * parameters rather than constants because manifest compatibility — a v1
 * manifest still reading, still listing, still undoing — is the thing these
 * tests exist to hold.
 */
function seedManifest(
  setPath: string,
  id: string,
  manifest: {
    version: 1 | 2;
    operation?: 'propagation' | 'removal';
    pinned?: boolean;
    lastCopyResourceKeys?: string[];
    resourceKeys?: string[];
  }
): void {
  const {
    version,
    operation,
    pinned,
    lastCopyResourceKeys,
    resourceKeys = ['skill:gh'],
  } = manifest;
  writeFileSync(
    join(setPath, 'manifest.json'),
    JSON.stringify({
      version,
      backupId: id,
      createdAtMs: 1,
      ...(operation && { operation }),
      ...(pinned && { pinned }),
      ...(lastCopyResourceKeys && { lastCopyResourceKeys }),
      entries: resourceKeys.map((resourceKey) => ({
        locationId: 'claude-skills',
        slug: resourceKey.split(':')[1],
        kind: 'directory',
        destinationPath: `/home/test/.claude/skills/${resourceKey.split(':')[1]}`,
        resolvedPath: `/home/test/.claude/skills/${resourceKey.split(':')[1]}`,
        backupPath: join(setPath, 'claude-skills', 'gh'),
        writtenContentHash: 'hash',
        // A v1 manifest predates the field entirely.
        ...(version === 2 && { resourceKey }),
      })),
    })
  );
}

describe('createBackupId', () => {
  it('produces a single path segment that cannot escape the backup root', () => {
    const id = createBackupId(deps());

    expect(id).toBe('2026-07-27T10-00-00.000Z-fixed');
    expect(id).not.toContain('/');
    expect(id).not.toContain('..');
  });
});

describe('backupExistingResource', () => {
  it('copies the destination aside under its location and slug', async () => {
    const source = join(root, 'gh');
    mkdirSync(source);
    writeFileSync(join(source, 'SKILL.md'), 'original');

    const backupPath = await backupExistingResource(
      { resolvedPath: source, locationId: 'claude-skills', slug: 'gh', backupId: 'set-1' },
      deps()
    );

    expect(backupPath).toBe(join(backupRoot, 'set-1', 'claude-skills', 'gh'));
    expect(readFileSync(join(backupPath, 'SKILL.md'), 'utf8')).toBe('original');
  });

  it('refuses a backup id that would climb out of the backup root', async () => {
    const source = join(root, 'gh');
    mkdirSync(source);

    await expect(
      backupExistingResource(
        { resolvedPath: source, locationId: 'claude-skills', slug: 'gh', backupId: '../escape' },
        deps()
      )
    ).rejects.toBeInstanceOf(TypeError);
  });
});

describe('backup manifest', () => {
  const entry: BackupEntry = {
    locationId: 'claude-skills',
    slug: 'gh',
    kind: 'directory',
    destinationPath: '/home/test/.claude/skills/gh',
    resolvedPath: '/home/test/.claude/skills/gh',
    backupPath: '/backups/set-1/claude-skills/gh',
    writtenContentHash: 'hash-a',
  };

  it('round-trips what undo needs', async () => {
    await writeBackupManifest(
      { version: 2, backupId: 'set-1', createdAtMs: 5, entries: [entry], operation: 'removal' },
      deps()
    );

    expect(await readBackupManifest('set-1', deps())).toEqual({
      version: 2,
      backupId: 'set-1',
      createdAtMs: 5,
      entries: [entry],
      operation: 'removal',
    });
  });

  // Backups are files on disk: there is no migration and nothing to backfill,
  // so a manifest written before v2 has to keep resolving. Rejecting it would
  // strand the copies it points at behind a 404 from undo.
  it('reads a v1 manifest unchanged, so an older backup still undoes', async () => {
    const setPath = join(backupRoot, 'v1-set');
    mkdirSync(setPath, { recursive: true });
    const legacy = {
      version: 1,
      backupId: 'v1-set',
      createdAtMs: 5,
      entries: [entry],
    } satisfies BackupManifest;
    writeFileSync(join(setPath, 'manifest.json'), JSON.stringify(legacy));

    expect(await readBackupManifest('v1-set', deps())).toEqual(legacy);
  });

  it('rejects a manifest whose recorded origin is not one this app writes', async () => {
    const setPath = join(backupRoot, 'bogus');
    mkdirSync(setPath, { recursive: true });
    writeFileSync(
      join(setPath, 'manifest.json'),
      JSON.stringify({
        version: 2,
        backupId: 'bogus',
        createdAtMs: 5,
        entries: [entry],
        operation: 'unknown',
      })
    );

    // `unknown` is a read-time projection for a manifest that recorded nothing.
    // Accepting it as a written value would let a listed row claim an origin
    // the writer never asserted.
    expect(await readBackupManifest('bogus', deps())).toBeNull();
  });

  it('reports a missing or corrupt manifest as absent rather than throwing', async () => {
    expect(await readBackupManifest('never-written', deps())).toBeNull();

    mkdirSync(join(backupRoot, 'set-2'), { recursive: true });
    writeFileSync(join(backupRoot, 'set-2', 'manifest.json'), '{ not json');
    expect(await readBackupManifest('set-2', deps())).toBeNull();
  });

  // The backup id reaches here straight from an undo request body. Callers
  // reach for `.catch()` to turn "no such backup" into a 404, and a synchronous
  // throw would sail past that catch and surface as an unexpected 500.
  it('rejects rather than throws when the id could escape the backup root', async () => {
    // Written as a bare try/catch because a synchronous throw and a rejected
    // promise are what this is telling apart, and the matchers conflate them.
    let threwSynchronously = false;
    let settled: unknown;
    try {
      settled = await readBackupManifest('../escape', deps()).catch((error: unknown) => error);
    } catch {
      threwSynchronously = true;
    }

    expect(threwSynchronously).toBe(false);
    expect(settled).toBeInstanceOf(TypeError);
  });
});

describe('restoreBackupEntry', () => {
  it('puts the backed-up content back where it came from', async () => {
    const destination = join(root, 'gh');
    mkdirSync(destination);
    writeFileSync(join(destination, 'SKILL.md'), 'original');
    const backupPath = await backupExistingResource(
      { resolvedPath: destination, locationId: 'claude-skills', slug: 'gh', backupId: 'set-1' },
      deps()
    );
    writeFileSync(join(destination, 'SKILL.md'), 'replaced');

    await restoreBackupEntry(
      {
        locationId: 'claude-skills',
        slug: 'gh',
        kind: 'directory',
        destinationPath: destination,
        resolvedPath: destination,
        backupPath,
        writtenContentHash: 'irrelevant',
      },
      deps()
    );

    expect(readFileSync(join(destination, 'SKILL.md'), 'utf8')).toBe('original');
  });

  it('refuses an entry that recorded no backup to restore', async () => {
    await expect(
      restoreBackupEntry(
        {
          locationId: 'claude-skills',
          slug: 'gh',
          kind: 'directory',
          destinationPath: join(root, 'gh'),
          resolvedPath: join(root, 'gh'),
          writtenContentHash: 'irrelevant',
        },
        deps()
      )
    ).rejects.toBeInstanceOf(TypeError);
  });
});

describe('pruneBackupSets', () => {
  it('keeps the newest sets up to the retention count', async () => {
    seedBackupSet('old', 10, 1_000);
    seedBackupSet('newer', 10, 2_000);
    seedBackupSet('current', 10, 3_000);

    await pruneBackupSets('current', deps({ retentionCount: () => 2 }));

    expect(existsSync(join(backupRoot, 'current'))).toBe(true);
    expect(existsSync(join(backupRoot, 'newer'))).toBe(true);
    expect(existsSync(join(backupRoot, 'old'))).toBe(false);
  });

  it('stops retaining once the byte budget is spent', async () => {
    seedBackupSet('current', 100, 3_000);
    seedBackupSet('newer', 100, 2_000);
    seedBackupSet('old', 100, 1_000);

    // Room for the current set and one more, even though the count allows three.
    await pruneBackupSets('current', deps({ retentionCount: () => 10, retentionBytes: () => 250 }));

    expect(existsSync(join(backupRoot, 'current'))).toBe(true);
    expect(existsSync(join(backupRoot, 'newer'))).toBe(true);
    expect(existsSync(join(backupRoot, 'old'))).toBe(false);
  });

  it('always keeps the set the current apply just wrote', async () => {
    seedBackupSet('current', 5_000, 1_000);
    seedBackupSet('newer', 10, 9_000);

    await pruneBackupSets('current', deps({ retentionCount: () => 1, retentionBytes: () => 1 }));

    expect(existsSync(join(backupRoot, 'current'))).toBe(true);
    expect(existsSync(join(backupRoot, 'newer'))).toBe(false);
  });

  it('never deletes a directory that is not shaped like a backup set', async () => {
    seedBackupSet('current', 10, 2_000);
    const foreign = join(backupRoot, 'someones-photos');
    mkdirSync(foreign, { recursive: true });
    writeFileSync(join(foreign, 'holiday.jpg'), 'not a backup');

    await pruneBackupSets('current', deps({ retentionCount: () => 1 }));

    expect(existsSync(join(foreign, 'holiday.jpg'))).toBe(true);
  });

  it('does nothing when the backup root has never been created', async () => {
    await expect(pruneBackupSets('current', deps())).resolves.toBeUndefined();
  });

  it('keeps a pinned set that count-based eviction would otherwise drop', async () => {
    seedPinnedBackupSet('pinned', 10, 1_000);
    seedBackupSet('ordinary', 10, 2_000);
    seedBackupSet('current', 10, 3_000);

    await pruneBackupSets('current', deps({ retentionCount: () => 1 }));

    expect(existsSync(join(backupRoot, 'pinned'))).toBe(true);
    expect(existsSync(join(backupRoot, 'current'))).toBe(true);
    // The ordinary set is the one the count evicts; the pinned one is exempt.
    expect(existsSync(join(backupRoot, 'ordinary'))).toBe(false);
  });

  it('charges pinned bytes first, so ordinary sets are the ones the budget squeezes out', async () => {
    seedPinnedBackupSet('pinned', 200, 1_000);
    seedBackupSet('ordinary', 100, 2_000);
    seedBackupSet('current', 100, 3_000);

    await pruneBackupSets('current', deps({ retentionCount: () => 10, retentionBytes: () => 350 }));

    expect(existsSync(join(backupRoot, 'pinned'))).toBe(true);
    expect(existsSync(join(backupRoot, 'current'))).toBe(true);
    expect(existsSync(join(backupRoot, 'ordinary'))).toBe(false);
  });

  it('rejects a retention count that would retain nothing', async () => {
    seedBackupSet('current', 10);

    await expect(
      pruneBackupSets('current', deps({ retentionCount: () => 0 }))
    ).rejects.toBeInstanceOf(TypeError);
  });
});

describe('listBackupSets', () => {
  it('reports what each retained backup costs on disk', async () => {
    seedBackupSet('one', 100);
    seedBackupSet('two', 50);

    const sets = await listBackupSets(deps());

    expect(sets.map((set) => set.backupId).sort()).toEqual(['one', 'two']);
    expect(sets.reduce((total, set) => total + set.sizeBytes, 0)).toBe(150);
    expect(sets.every((set) => !set.pinned)).toBe(true);
  });

  it('reports nothing when no backup has ever been taken', async () => {
    expect(await listBackupSets(deps())).toEqual([]);
  });

  it('reports a set as pinned when its manifest says it holds a last copy', async () => {
    seedPinnedBackupSet('pinned', 10, 1_000);

    const [set] = await listBackupSets(deps());

    expect(set.pinned).toBe(true);
    expect(set.lastCopyResourceKeys).toEqual(['skill:gh']);
  });

  it('names what each set holds, deduped and ordered', async () => {
    const setPath = seedBackupSet('set-1', 10);
    seedManifest(setPath, 'set-1', {
      version: 2,
      operation: 'propagation',
      resourceKeys: ['skill:release', 'skill:gh', 'skill:gh'],
    });

    const [set] = await listBackupSets(deps());

    expect(set.resourceKeys).toEqual(['skill:gh', 'skill:release']);
    expect(set.operation).toBe('propagation');
  });

  // Undo means opposite things by origin — a removal set puts content back, a
  // propagation set can delete what the apply created — so a v1 manifest must
  // report `unknown` and let the UI stay neutral rather than pick a verb.
  it('reports a v1 manifest as unknown with no resource names, never a guess', async () => {
    const setPath = seedBackupSet('legacy', 10);
    seedManifest(setPath, 'legacy', { version: 1 });

    const [set] = await listBackupSets(deps());

    expect(set.operation).toBe('unknown');
    expect(set.resourceKeys).toEqual([]);
    expect(set.entryCount).toBe(1);
  });

  it('still lists a set whose manifest is unreadable, with its size', async () => {
    const setPath = seedBackupSet('corrupt', 120);
    writeFileSync(join(setPath, 'manifest.json'), '{ not json');

    const [set] = await listBackupSets(deps());

    expect(set.backupId).toBe('corrupt');
    expect(set.sizeBytes).toBeGreaterThanOrEqual(120);
    expect(set.operation).toBe('unknown');
    expect(set.pinned).toBe(false);
  });

  it('marks exactly the sets the next prune would drop', async () => {
    seedBackupSet('oldest', 10, 1_000);
    seedBackupSet('older', 10, 2_000);
    seedBackupSet('newer', 10, 3_000);
    seedBackupSet('newest', 10, 4_000);

    const sets = await listBackupSets(deps({ retentionCount: () => 3 }));

    expect(sets.filter((set) => set.evictsNext).map((set) => set.backupId)).toEqual(['oldest']);
  });

  // The flag is only worth showing if it agrees with the code that does the
  // deleting. Asserted by running the prune and comparing, rather than by
  // re-deriving the retention rule here — a test that restates the rule cannot
  // catch the two copies drifting apart.
  it('agrees with what pruneBackupSets actually removes', async () => {
    seedBackupSet('oldest', 100, 1_000);
    seedBackupSet('older', 100, 2_000);
    seedBackupSet('newer', 100, 3_000);
    seedBackupSet('newest', 100, 4_000);
    const store = deps({ retentionCount: () => 10, retentionBytes: () => 350 });

    const flagged = (await listBackupSets(store))
      .filter((set) => set.evictsNext)
      .map((set) => set.backupId)
      .sort();

    await pruneBackupSets('newest', store);
    const deleted = ['oldest', 'older', 'newer', 'newest']
      .filter((id) => !existsSync(join(backupRoot, id)))
      .sort();

    expect(flagged).toEqual(deleted);
    expect(deleted).not.toEqual([]);
  });

  it('never marks a pinned set as evicting, at any budget', async () => {
    seedPinnedBackupSet('pinned', 500, 1_000);
    seedBackupSet('ordinary', 10, 2_000);

    const sets = await listBackupSets(deps({ retentionCount: () => 1, retentionBytes: () => 1 }));

    expect(sets.find((set) => set.backupId === 'pinned')?.evictsNext).toBe(false);
    expect(sets.find((set) => set.backupId === 'ordinary')?.evictsNext).toBe(true);
  });
});

describe('purgeBackupSet', () => {
  it('removes a pinned set on an explicit request and reports it was there', async () => {
    seedPinnedBackupSet('pinned', 10, 1_000);

    expect(await purgeBackupSet('pinned', deps())).toBe(true);
    expect(existsSync(join(backupRoot, 'pinned'))).toBe(false);
  });

  it('treats purging a set that is already gone as the state the caller asked for', async () => {
    expect(await purgeBackupSet('never-existed', deps())).toBe(false);
  });
});

describe('discardBackupSet', () => {
  it('removes one set without touching the others', async () => {
    seedBackupSet('keep', 10);
    seedBackupSet('drop', 10);

    await discardBackupSet('drop', deps());

    expect(existsSync(join(backupRoot, 'keep'))).toBe(true);
    expect(existsSync(join(backupRoot, 'drop'))).toBe(false);
  });
});
