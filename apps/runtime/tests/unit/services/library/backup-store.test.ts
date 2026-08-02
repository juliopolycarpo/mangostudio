import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  backupExistingResource,
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
