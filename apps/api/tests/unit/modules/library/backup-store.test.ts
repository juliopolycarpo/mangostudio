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
  writeFileSync(
    join(setPath, 'manifest.json'),
    JSON.stringify({
      version: 1,
      backupId: id,
      createdAtMs: 1,
      pinned: true,
      lastCopyResourceKeys: ['skill:gh'],
      entries: [
        {
          locationId: 'claude-skills',
          slug: 'gh',
          kind: 'directory',
          destinationPath: '/home/test/.claude/skills/gh',
          resolvedPath: '/home/test/.claude/skills/gh',
          backupPath: join(setPath, 'claude-skills', 'gh'),
          writtenContentHash: 'hash',
        },
      ],
    })
  );
  if (modifiedAtMs !== undefined) {
    const seconds = modifiedAtMs / 1000;
    utimesSync(setPath, seconds, seconds);
  }
  return setPath;
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
      { version: 1, backupId: 'set-1', createdAtMs: 5, entries: [entry] },
      deps()
    );

    expect(await readBackupManifest('set-1', deps())).toEqual({
      version: 1,
      backupId: 'set-1',
      createdAtMs: 5,
      entries: [entry],
    });
  });

  it('reports a missing or corrupt manifest as absent rather than throwing', async () => {
    expect(await readBackupManifest('never-written', deps())).toBeNull();

    mkdirSync(join(backupRoot, 'set-2'), { recursive: true });
    writeFileSync(join(backupRoot, 'set-2', 'manifest.json'), '{ not json');
    expect(await readBackupManifest('set-2', deps())).toBeNull();
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
