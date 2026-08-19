import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createPropagationWriteEngineDeps,
  executePropagationWrites,
} from '../../../../src/services/library/apply-writes';
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
          destinationRoot: join(home, '.claude', 'skills'),
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

  it('refuses a write whose destination is not the one the preview showed', async () => {
    const sourceDir = join(home, 'source');
    mkdirSync(sourceDir);
    writeFileSync(join(sourceDir, 'SKILL.md'), '---\nname: gh\ndescription: d\n---\nbody\n');
    const env = { platform: 'linux' as const, homeDir: home, env: {} };
    const expected = await hashResourceAt(sourceDir, 'directory');

    // What a runtime whose location resolution disagrees with the hub's looks
    // like: the previewed path is somebody else's home, and nothing but this
    // guard stands between that and a write into this one.
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
          destinationRoot: join('/somebody', 'else', '.claude', 'skills'),
          sourceDir,
        },
      ],
    });

    expect(result.failed[0]).toMatchObject({ reason: 'guard-rejected' });
    expect(result.applied).toEqual([]);
    expect(existsSync(join(home, '.claude', 'skills', 'gh'))).toBe(false);
  });

  it('stops and rolls back when the hub cancels mid-apply', async () => {
    const sourceDir = join(home, 'source');
    mkdirSync(sourceDir);
    writeFileSync(join(sourceDir, 'SKILL.md'), '---\nname: gh\ndescription: d\n---\nbody\n');
    mkdirSync(join(home, '.agents', 'skills'), { recursive: true });
    const env = { platform: 'linux' as const, homeDir: home, env: {} };
    const expected = await hashResourceAt(sourceDir, 'directory');
    const controller = new AbortController();

    const operation = (locationId: 'claude-skills' | 'agents-skills', root: string) => ({
      resourceKey: 'skill:gh',
      locationId,
      slug: 'gh',
      operation: 'create' as const,
      kind: 'directory' as const,
      expectedContentHash: expected,
      destinationRoot: root,
      sourceDir,
    });

    // Aborts the way the hub's RPC deadline does: after the first destination
    // is written and before the loop reaches the second.
    const result = await executePropagationWrites(
      {
        backupRoot,
        pathEnv: env,
        signal: controller.signal,
        operations: [
          operation('claude-skills', join(home, '.claude', 'skills')),
          operation('agents-skills', join(home, '.agents', 'skills')),
        ],
      },
      {
        ...createPropagationWriteEngineDeps({ backupRoot }),
        hashAt: async (path, kind) => {
          const hash = await hashResourceAt(path, kind);
          controller.abort();
          return hash;
        },
      }
    );

    expect(result.failed[0]).toMatchObject({
      locationId: 'agents-skills',
      message: expect.stringContaining('cancelled'),
    });
    expect(result.applied).toEqual([]);
    expect(existsSync(join(home, '.claude', 'skills', 'gh'))).toBe(false);
    expect(existsSync(join(home, '.agents', 'skills', 'gh'))).toBe(false);
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
          destinationRoot: join(home, '.claude', 'skills'),
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

  it('refuses a write whose on-disk hash is not the one the preview described', async () => {
    const sourceDir = join(home, 'source');
    mkdirSync(sourceDir);
    writeFileSync(join(sourceDir, 'SKILL.md'), '---\nname: gh\ndescription: d\n---\nbody\n');
    const env = { platform: 'linux' as const, homeDir: home, env: {} };

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
          expectedContentHash: 'not-the-hash-the-preview-described',
          destinationRoot: join(home, '.claude', 'skills'),
          sourceDir,
        },
      ],
    });

    expect(result.failed[0]).toMatchObject({ reason: 'verification-failed' });
    expect(result.applied).toEqual([]);
    expect(existsSync(join(home, '.claude', 'skills', 'gh'))).toBe(false);
  });

  it('fails verification with unsafe-name when a written directory contains a newline filename', async () => {
    const sourceDir = join(home, 'source');
    mkdirSync(sourceDir);
    writeFileSync(join(sourceDir, 'SKILL.md'), '---\nname: gh\ndescription: d\n---\nbody\n');
    writeFileSync(join(sourceDir, 'a\nb.md'), 'leaf');
    const env = { platform: 'linux' as const, homeDir: home, env: {} };

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
          expectedContentHash: 'unused-because-hashing-fails',
          destinationRoot: join(home, '.claude', 'skills'),
          sourceDir,
        },
      ],
    });

    expect(result.failed[0]).toMatchObject({
      reason: 'verification-failed',
      message: expect.stringContaining('unsafe-name'),
    });
    expect(result.applied).toEqual([]);
    expect(existsSync(join(home, '.claude', 'skills', 'gh'))).toBe(false);
  });
});
