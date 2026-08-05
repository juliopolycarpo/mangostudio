import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  backupExistingResource,
  collectBackupGarbage,
  createBackupId,
  createBackupStoreDeps,
  listBackupSets,
  pruneBackupSets,
  readBackupManifest,
  writeBackupManifest,
} from '../../../../src/services/library/backup-store';

let root: string;
let backupRoot: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mango-runtime-backup-'));
  backupRoot = join(root, 'backups');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('createBackupStoreDeps', () => {
  it('never invents a backup root — callers must supply one', async () => {
    const deps = createBackupStoreDeps({
      backupRoot,
      retentionCount: 2,
      retentionBytes: 1024 ** 3,
      now: () => new Date('2026-08-02T10:00:00.000Z'),
      randomSuffix: () => 'abcd',
    });
    expect(deps.backupDir()).toBe(backupRoot);

    const id = createBackupId(deps);
    expect(id).toBe('2026-08-02T10-00-00.000Z-abcd');

    const resource = join(root, 'skill');
    mkdirSync(resource);
    writeFileSync(join(resource, 'SKILL.md'), 'body');
    const backupPath = await backupExistingResource(
      {
        resolvedPath: resource,
        locationId: 'claude-skills',
        slug: 'gh',
        backupId: id,
      },
      deps
    );
    expect(readFileSync(join(backupPath, 'SKILL.md'), 'utf8')).toBe('body');

    await writeBackupManifest(
      {
        version: 2,
        backupId: id,
        createdAtMs: deps.now().getTime(),
        entries: [],
        operation: 'propagation',
      },
      deps
    );
    expect(await readBackupManifest(id, deps)).toMatchObject({ backupId: id });
    await pruneBackupSets(id, deps);
    expect(await listBackupSets(deps)).toHaveLength(1);
  });
});

describe('manifest v3', () => {
  it('reads v1 and v2 manifests as sets with no environment of their own', async () => {
    const deps = createBackupStoreDeps({ backupRoot });
    mkdirSync(join(backupRoot, 'v1-set'), { recursive: true });
    writeFileSync(
      join(backupRoot, 'v1-set', 'manifest.json'),
      JSON.stringify({ version: 1, backupId: 'v1-set', createdAtMs: 1, entries: [] })
    );
    mkdirSync(join(backupRoot, 'v2-set'), { recursive: true });
    writeFileSync(
      join(backupRoot, 'v2-set', 'manifest.json'),
      JSON.stringify({
        version: 2,
        backupId: 'v2-set',
        createdAtMs: 2,
        entries: [],
        operation: 'propagation',
      })
    );

    // Backups are files on disk: there is no migration, so a manifest written
    // before the field existed has to keep answering rather than strand the
    // copies it points at.
    const v1 = await readBackupManifest('v1-set', deps);
    const v2 = await readBackupManifest('v2-set', deps);
    expect(v1?.version).toBe(1);
    expect(v1?.environmentId).toBeUndefined();
    expect(v2?.version).toBe(2);
    expect(v2?.environmentId).toBeUndefined();

    const sets = await listBackupSets(deps);
    expect(sets.every((set) => set.manifestReadable)).toBe(true);
  });

  it('round-trips the environment a v3 manifest was written for', async () => {
    const deps = createBackupStoreDeps({ backupRoot });
    await writeBackupManifest(
      {
        version: 3,
        backupId: 'v3-set',
        createdAtMs: 3,
        entries: [],
        operation: 'propagation',
        environmentId: 'wsl-ubuntu',
      },
      deps
    );

    expect((await readBackupManifest('v3-set', deps))?.environmentId).toBe('wsl-ubuntu');
  });

  it('lists a set whose manifest cannot be read, and says so', async () => {
    const deps = createBackupStoreDeps({ backupRoot });
    // A real backup directory with a corrupt manifest still costs disk and can
    // still be purged — but nothing can be restored from it, so the row has to
    // be able to say that instead of offering an undo that fails on click.
    mkdirSync(join(backupRoot, 'broken-set', 'claude-skills', 'gh'), { recursive: true });
    writeFileSync(join(backupRoot, 'broken-set', 'manifest.json'), '{ not json');

    const sets = await listBackupSets(deps);
    expect(sets).toHaveLength(1);
    expect(sets[0].backupId).toBe('broken-set');
    expect(sets[0].manifestReadable).toBe(false);
    expect(sets[0].operation).toBe('unknown');
  });
});

describe('collectBackupGarbage', () => {
  it('purges named sets and reports what retention took with them', async () => {
    const deps = createBackupStoreDeps({
      backupRoot,
      retentionCount: 1,
      retentionBytes: 1024 ** 3,
    });
    for (const id of ['set-a', 'set-b', 'set-c']) {
      mkdirSync(join(backupRoot, id, 'claude-skills', 'gh'), { recursive: true });
      writeFileSync(join(backupRoot, id, 'claude-skills', 'gh', 'SKILL.md'), id);
      await writeBackupManifest(
        { version: 3, backupId: id, createdAtMs: 1, entries: [], operation: 'propagation' },
        deps
      );
    }

    const result = await collectBackupGarbage({ purgeBackupIds: ['set-a'] }, deps);

    expect(result.purged).toEqual(['set-a']);
    // Retention keeps one ordinary set, so exactly one of the two survivors is
    // reported pruned — and the hub deletes its index row in the same pass.
    expect(result.pruned).toHaveLength(1);
    expect(await listBackupSets(deps)).toHaveLength(1);
  });

  it('purging a set that is already gone is the state the caller asked for', async () => {
    const deps = createBackupStoreDeps({ backupRoot });
    mkdirSync(backupRoot, { recursive: true });

    const result = await collectBackupGarbage({ purgeBackupIds: ['never-existed'] }, deps);

    expect(result.purged).toEqual(['never-existed']);
    expect(result.pruned).toEqual([]);
  });

  it('keeps every set when no bounds are exceeded', async () => {
    const deps = createBackupStoreDeps({
      backupRoot,
      retentionCount: 5,
      retentionBytes: 1024 ** 3,
    });
    for (const id of ['keep-a', 'keep-b']) {
      mkdirSync(join(backupRoot, id, 'claude-skills', 'gh'), { recursive: true });
      await writeBackupManifest(
        { version: 3, backupId: id, createdAtMs: 1, entries: [], operation: 'removal' },
        deps
      );
    }

    const result = await collectBackupGarbage({}, deps);

    expect(result.pruned).toEqual([]);
    expect(await listBackupSets(deps)).toHaveLength(2);
  });
});
