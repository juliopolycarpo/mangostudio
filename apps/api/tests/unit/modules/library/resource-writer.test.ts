import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { Dirent, Stats } from 'node:fs';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { cp, lstat, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PathEnv } from '../../../../src/modules/library/domain/registry';
import {
  type ResourceWriterFs,
  writeDirectoryResource,
} from '../../../../src/modules/library/infrastructure/resource-writer';

let tempDir: string;
let sourceDir: string;
let backupDir: string;
let env: PathEnv;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'mango-library-writer-'));
  sourceDir = join(tempDir, 'source');
  backupDir = join(tempDir, 'backups');
  env = { platform: 'linux', homeDir: tempDir, env: {} };
  mkdirSync(sourceDir);
  writeFileSync(join(sourceDir, 'SKILL.md'), 'new content');
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function makeWriterFs(overrides: Partial<ResourceWriterFs> = {}): ResourceWriterFs {
  const base: ResourceWriterFs = {
    copyTree(source, destination) {
      return cp(source, destination, {
        recursive: true,
        force: false,
        errorOnExist: true,
        preserveTimestamps: true,
      });
    },
    async lstat(path): Promise<Stats | null> {
      try {
        return await lstat(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    },
    async mkdir(path): Promise<void> {
      await mkdir(path, { recursive: true });
    },
    readdir(path): Promise<Dirent[]> {
      return readdir(path, { withFileTypes: true });
    },
    rename,
    async remove(path): Promise<void> {
      await rm(path, { recursive: true, force: true });
    },
    stat,
  };
  return { ...base, ...overrides };
}

function writerDeps(fs = makeWriterFs(), retentionCount = 10) {
  return {
    fs,
    backupDir: () => backupDir,
    backupRetentionCount: () => retentionCount,
    now: () => new Date('2026-07-26T12:00:00.000Z'),
    randomSuffix: () => 'fixed',
  };
}

function destinationPath(): string {
  return join(tempDir, '.agents', 'skills', 'gh');
}

describe('directory resource writes', () => {
  it('backs up prior content before an atomic directory replacement', async () => {
    const destination = destinationPath();
    mkdirSync(destination, { recursive: true });
    writeFileSync(join(destination, 'SKILL.md'), 'old content');

    const result = await writeDirectoryResource(
      {
        locationId: 'agents-skills',
        slug: 'gh',
        sourceDir,
        env,
        backupId: 'apply-001',
      },
      writerDeps()
    );

    expect(readFileSync(join(destination, 'SKILL.md'), 'utf8')).toBe('new content');
    expect(
      readFileSync(join(backupDir, 'apply-001', 'agents-skills', 'gh', 'SKILL.md'), 'utf8')
    ).toBe('old content');
    expect(result).toMatchObject({
      destinationPath: destination,
      resolvedDestinationPath: destination,
      backupId: 'apply-001',
    });
  });

  it('restores the original directory when the staged swap fails', async () => {
    const destination = destinationPath();
    mkdirSync(destination, { recursive: true });
    writeFileSync(join(destination, 'SKILL.md'), 'old content');
    writeFileSync(join(destination, 'keep.txt'), 'keep me');

    const realFs = makeWriterFs();
    const failingFs = makeWriterFs({
      async rename(source, target) {
        if (source.endsWith('.staging')) {
          throw new Error('injected staged rename failure');
        }
        await realFs.rename(source, target);
      },
    });

    await expect(
      writeDirectoryResource(
        {
          locationId: 'agents-skills',
          slug: 'gh',
          sourceDir,
          env,
          backupId: 'apply-fail',
        },
        writerDeps(failingFs)
      )
    ).rejects.toThrow('injected staged rename failure');

    expect(readFileSync(join(destination, 'SKILL.md'), 'utf8')).toBe('old content');
    expect(readFileSync(join(destination, 'keep.txt'), 'utf8')).toBe('keep me');
  });

  it('rejects a read-only registry location before touching the filesystem', async () => {
    const unexpectedFs = makeWriterFs({
      copyTree() {
        throw new Error('filesystem should not be touched');
      },
      lstat() {
        throw new Error('filesystem should not be touched');
      },
      mkdir() {
        throw new Error('filesystem should not be touched');
      },
      readdir() {
        throw new Error('filesystem should not be touched');
      },
      rename() {
        throw new Error('filesystem should not be touched');
      },
      remove() {
        throw new Error('filesystem should not be touched');
      },
      stat() {
        throw new Error('filesystem should not be touched');
      },
    });

    await expect(
      writeDirectoryResource(
        {
          locationId: 'cursor-skills-builtin',
          slug: 'gh',
          sourceDir: join(tempDir, 'missing-source'),
          env,
        },
        writerDeps(unexpectedFs)
      )
    ).rejects.toMatchObject({ reason: 'read-only-location' });
  });

  it('writes through a symlinked location root without replacing the link', async () => {
    const physicalRoot = join(tempDir, 'dotfiles', 'agent-skills');
    const logicalRoot = join(tempDir, '.agents', 'skills');
    mkdirSync(physicalRoot, { recursive: true });
    mkdirSync(join(tempDir, '.agents'), { recursive: true });
    symlinkSync(physicalRoot, logicalRoot);

    await writeDirectoryResource(
      {
        locationId: 'agents-skills',
        slug: 'gh',
        sourceDir,
        env,
        backupId: 'apply-link',
      },
      writerDeps()
    );

    expect(lstatSync(logicalRoot).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(physicalRoot, 'gh', 'SKILL.md'), 'utf8')).toBe('new content');
  });

  it('prunes backup sets beyond the configured retention count', async () => {
    const destination = destinationPath();
    mkdirSync(destination, { recursive: true });
    writeFileSync(join(destination, 'SKILL.md'), 'old content');
    for (const [id, seconds] of [
      ['apply-oldest', 1],
      ['apply-newer', 2],
    ] as const) {
      const path = join(backupDir, id);
      mkdirSync(path, { recursive: true });
      utimesSync(path, seconds, seconds);
    }

    await writeDirectoryResource(
      {
        locationId: 'agents-skills',
        slug: 'gh',
        sourceDir,
        env,
        backupId: 'apply-current',
      },
      writerDeps(makeWriterFs(), 2)
    );

    expect(lstatSync(join(backupDir, 'apply-current')).isDirectory()).toBe(true);
    expect(lstatSync(join(backupDir, 'apply-newer')).isDirectory()).toBe(true);
    expect(() => lstatSync(join(backupDir, 'apply-oldest'))).toThrow();
  });
});
