import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executePropagationWrites } from '../../../../src/services/library/apply-writes';
import { hashResourceAt } from '../../../../src/services/library/instance-reader';
import { executeLibraryUndo } from '../../../../src/services/library/undo-writes';

let home: string;
let backupRoot: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mango-runtime-apply-'));
  backupRoot = join(home, 'backups');
  mkdirSync(join(home, '.claude', 'skills'), { recursive: true });
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('executePropagationWrites', () => {
  it('writes through an injected backupRoot and supports undo', async () => {
    const sourceDir = join(home, 'source');
    mkdirSync(sourceDir);
    writeFileSync(join(sourceDir, 'SKILL.md'), '---\nname: gh\ndescription: d\n---\nbody\n');
    const env = { platform: 'linux' as const, homeDir: home, env: {} };
    const expected = await hashResourceAt(sourceDir, 'directory');

    const result = await executePropagationWrites({
      backupRoot,
      retentionCount: 10,
      retentionBytes: 1024 ** 3,
      pathEnv: env,
      operations: [
        {
          resourceKey: 'skill:gh',
          locationId: 'claude-skills',
          slug: 'gh',
          operation: 'create',
          kind: 'directory',
          expectedContentHash: expected,
          destinationPath: join(home, '.claude', 'skills', 'gh'),
          sourceDir,
        },
      ],
    });

    expect(result.failed).toEqual([]);
    expect(result.backupId).toBeString();
    expect(existsSync(join(home, '.claude', 'skills', 'gh', 'SKILL.md'))).toBe(true);
    expect(readFileSync(join(home, '.claude', 'skills', 'gh', 'SKILL.md'), 'utf8')).toContain(
      'body'
    );

    const undone = await executeLibraryUndo({
      backupRoot,
      backupId: result.backupId ?? '',
      pathEnv: env,
    });
    expect(undone.removed).toHaveLength(1);
    expect(existsSync(join(home, '.claude', 'skills', 'gh'))).toBe(false);
  });

  it('refuses a manifest entry that points outside the location it names', async () => {
    const sourceDir = join(home, 'source');
    mkdirSync(sourceDir);
    writeFileSync(join(sourceDir, 'SKILL.md'), '---\nname: gh\ndescription: d\n---\nbody\n');
    const env = { platform: 'linux' as const, homeDir: home, env: {} };
    const expected = await hashResourceAt(sourceDir, 'directory');

    const result = await executePropagationWrites({
      backupRoot,
      pathEnv: env,
      operations: [
        {
          resourceKey: 'skill:gh',
          locationId: 'claude-skills',
          slug: 'gh',
          operation: 'create',
          kind: 'directory',
          expectedContentHash: expected,
          destinationPath: join(home, '.claude', 'skills', 'gh'),
          sourceDir,
        },
      ],
    });

    // Stand in for a hand-edited or forged manifest: the entry now names a
    // path no registry location contains, which undo would otherwise `rm -rf`.
    const outsider = join(home, 'not-a-library-path');
    mkdirSync(outsider, { recursive: true });
    const manifestPath = join(backupRoot, result.backupId ?? '', 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.entries[0].resolvedPath = outsider;
    writeFileSync(manifestPath, JSON.stringify(manifest));

    await expect(
      executeLibraryUndo({ backupRoot, backupId: result.backupId ?? '', pathEnv: env })
    ).rejects.toThrow(/outside location "claude-skills"/);
    expect(existsSync(outsider)).toBe(true);
  });
});
