import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  RegularFileReadError,
  type RegularFileReadFailure,
  RegularFileWriteError,
  readRegularFileUtf8,
  readUtf8FileOrNull,
  SECRET_FILE_MODE,
  statRegularFile,
  writeFileAtomic,
  writeRegularFileAtomic,
} from '../../../src/lib/safe-file';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mango-safe-file-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const isWindows = process.platform === 'win32';
const MAX_SYMLINK_HOPS = 32;

describe('writeFileAtomic', () => {
  it('creates the file and any missing parent directories', () => {
    const target = join(dir, 'nested', 'deeper', 'config.toml');

    writeFileAtomic(target, 'value = 1\n');

    expect(readFileSync(target, 'utf8')).toBe('value = 1\n');
  });

  it('overwrites existing content without leaving temp files behind', () => {
    const target = join(dir, 'config.toml');
    writeFileAtomic(target, 'first');

    writeFileAtomic(target, 'second');

    expect(readFileSync(target, 'utf8')).toBe('second');
    expect(readdirSync(dir)).toEqual(['config.toml']);
  });

  it('applies a restrictive mode to secret-bearing files', () => {
    if (isWindows) return;
    const target = join(dir, '.env');

    writeFileAtomic(target, 'SECRET="x"\n', { mode: SECRET_FILE_MODE });

    expect(statSync(target).mode & 0o777).toBe(SECRET_FILE_MODE);
  });

  it('never widens permissions on the temp file before the rename', () => {
    if (isWindows) return;
    // A pre-existing world-readable file must end up owner-only after a secret write.
    const target = join(dir, '.env');
    writeFileSync(target, 'OLD="x"\n', { mode: 0o644 });

    writeFileAtomic(target, 'NEW="y"\n', { mode: SECRET_FILE_MODE });

    expect(statSync(target).mode & 0o777).toBe(SECRET_FILE_MODE);
  });

  it('refuses to overwrite when exclusive and leaves no temp file', () => {
    const target = join(dir, 'agent.md');
    writeFileAtomic(target, 'original');

    let code: string | undefined;
    try {
      writeFileAtomic(target, 'replacement', { exclusive: true });
    } catch (error) {
      code = (error as NodeJS.ErrnoException).code;
    }

    expect(code).toBe('EEXIST');
    expect(readFileSync(target, 'utf8')).toBe('original');
    expect(readdirSync(dir)).toEqual(['agent.md']);
  });

  it('creates a new file when exclusive and the path is free', () => {
    const target = join(dir, 'agent.md');

    writeFileAtomic(target, 'created', { exclusive: true });

    expect(readFileSync(target, 'utf8')).toBe('created');
  });
});

describe('writeRegularFileAtomic', () => {
  it('reports the committed inode mtime rather than a later observation', async () => {
    const target = join(dir, 'note.txt');

    const { bytesWritten, mtimeMs } = await writeRegularFileAtomic(target, 'hello');

    expect(bytesWritten).toBe(5);
    expect(mtimeMs).toBe(statSync(target).mtimeMs);
  });

  it('preserves the destination permission bits across an overwrite', async () => {
    if (isWindows) return;
    const target = join(dir, 'note.txt');
    writeFileSync(target, 'first', { mode: 0o640 });

    await writeRegularFileAtomic(target, 'second');

    expect(readFileSync(target, 'utf8')).toBe('second');
    expect(statSync(target).mode & 0o777).toBe(0o640);
  });

  it('rejects a non-regular destination and leaves no temp file', async () => {
    const target = join(dir, 'a-directory');
    mkdirSync(target);

    await expect(writeRegularFileAtomic(target, 'content')).rejects.toBeInstanceOf(
      RegularFileWriteError
    );
    expect(readdirSync(dir)).toEqual(['a-directory']);
  });
});

describe('readUtf8FileOrNull', () => {
  it('returns file contents when present', () => {
    const target = join(dir, 'file.txt');
    writeFileSync(target, 'hello');

    expect(readUtf8FileOrNull(target)).toBe('hello');
  });

  it('returns null for a missing file', () => {
    expect(readUtf8FileOrNull(join(dir, 'missing.txt'))).toBeNull();
  });
});

describe('readRegularFileUtf8', () => {
  it('reads content and reports the size', () => {
    const target = join(dir, 'file.md');
    writeFileSync(target, 'abc');

    const result = readRegularFileUtf8(target, { maxBytes: 1024 });

    expect(result.content).toBe('abc');
    expect(result.truncated).toBe(false);
    expect(result.sizeBytes).toBe(3);
  });

  it('throws not-found for a missing path', () => {
    expectReadFailure(
      () => readRegularFileUtf8(join(dir, 'nope.md'), { maxBytes: 1024 }),
      'not-found'
    );
  });

  it('throws not-regular-file for a directory', () => {
    expectReadFailure(() => readRegularFileUtf8(dir, { maxBytes: 1024 }), 'not-regular-file');
  });

  it('throws too-large when content exceeds the cap and truncation is off', () => {
    const target = join(dir, 'big.md');
    writeFileSync(target, 'x'.repeat(50));

    expectReadFailure(() => readRegularFileUtf8(target, { maxBytes: 10 }), 'too-large');
  });

  it('truncates to the cap when truncateOversize is set', () => {
    const target = join(dir, 'big.md');
    writeFileSync(target, 'x'.repeat(50));

    const result = readRegularFileUtf8(target, { maxBytes: 10, truncateOversize: true });

    expect(result.content).toBe('x'.repeat(10));
    expect(result.truncated).toBe(true);
    expect(result.sizeBytes).toBe(50);
  });
});

describe('statRegularFile', () => {
  it('returns the size of a regular file', () => {
    const target = join(dir, 'file.md');
    writeFileSync(target, 'abcd');

    expect(statRegularFile(target).sizeBytes).toBe(4);
  });

  it('throws not-found for a missing path', () => {
    expectReadFailure(() => statRegularFile(join(dir, 'missing.md')), 'not-found');
  });
});

function expectReadFailure(run: () => unknown, reason: RegularFileReadFailure): void {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(RegularFileReadError);
  expect((caught as RegularFileReadError).reason).toBe(reason);
}

/**
 * Regression coverage for #617: the sync writer used to replace a symlinked
 * destination with a regular file, silently detaching a dotfiles-managed path.
 */
describe('writeFileAtomic through symlinks', () => {
  it('writes through a symlink and leaves the link pointing where it did', () => {
    if (isWindows) return;
    const target = join(dir, 'dotfiles', 'config.toml');
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, 'old\n');
    const link = join(dir, 'config.toml');
    symlinkSync(target, link);

    writeFileAtomic(link, 'new\n');

    expect(readFileSync(target, 'utf8')).toBe('new\n');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(target);
  });

  it('stages beside the target, not beside the link', () => {
    if (isWindows) return;
    const targetDir = join(dir, 'dotfiles');
    mkdirSync(targetDir);
    const target = join(targetDir, 'config.toml');
    writeFileSync(target, 'old\n');
    const linkDir = join(dir, 'home');
    mkdirSync(linkDir);
    const link = join(linkDir, 'config.toml');
    symlinkSync(target, link);

    // A writer that stages next to the link cannot create its temp file here.
    // Staging beside the target also avoids EXDEV when the directories are on
    // different filesystems.
    chmodSync(linkDir, 0o555);
    try {
      writeFileAtomic(link, 'new\n');
    } finally {
      chmodSync(linkDir, 0o755);
    }

    expect(readFileSync(target, 'utf8')).toBe('new\n');
    // Neither directory keeps a temp file, and the link directory never held one.
    expect(readdirSync(targetDir)).toEqual(['config.toml']);
    expect(readdirSync(linkDir)).toEqual(['config.toml']);
  });

  it('creates the target of a dangling symlink instead of throwing', () => {
    if (isWindows) return;
    // A fresh dotfiles checkout, which is exactly when a user first saves.
    const target = join(dir, 'dotfiles', 'config.toml');
    mkdirSync(dirname(target), { recursive: true });
    const link = join(dir, 'config.toml');
    symlinkSync(target, link);

    writeFileAtomic(link, 'first\n');

    expect(readFileSync(target, 'utf8')).toBe('first\n');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
  });

  it('follows a chain of symlinks to the real file', () => {
    if (isWindows) return;
    const target = join(dir, 'real.toml');
    writeFileSync(target, 'old\n');
    const middle = join(dir, 'middle.toml');
    const outer = join(dir, 'outer.toml');
    symlinkSync(target, middle);
    symlinkSync(middle, outer);

    writeFileAtomic(outer, 'new\n');

    expect(readFileSync(target, 'utf8')).toBe('new\n');
    expect(lstatSync(outer).isSymbolicLink()).toBe(true);
  });

  it('follows an existing symlink chain at the depth cap', () => {
    if (isWindows) return;
    const target = join(dir, 'real.toml');
    writeFileSync(target, 'old\n');
    const outer = createSymlinkChain(target, MAX_SYMLINK_HOPS);

    writeFileAtomic(outer, 'new\n');

    expect(readFileSync(target, 'utf8')).toBe('new\n');
  });

  it('rejects an existing symlink chain beyond the depth cap', () => {
    if (isWindows) return;
    const target = join(dir, 'real.toml');
    writeFileSync(target, 'old\n');
    const outer = createSymlinkChain(target, MAX_SYMLINK_HOPS + 1);

    let code: string | undefined;
    try {
      writeFileAtomic(outer, 'new\n');
    } catch (error) {
      code = (error as NodeJS.ErrnoException).code;
    }

    expect(code).toBe('ELOOP');
    expect(readFileSync(target, 'utf8')).toBe('old\n');
  });

  it('throws on a symlink cycle rather than hanging', () => {
    if (isWindows) return;
    const first = join(dir, 'a');
    const second = join(dir, 'b');
    symlinkSync(second, first);
    symlinkSync(first, second);

    expect(() => writeFileAtomic(first, 'content')).toThrow();
  });

  it('refuses a symlink whose target is not a regular file, naming both', () => {
    if (isWindows) return;
    const target = join(dir, 'a-directory');
    mkdirSync(target);
    const link = join(dir, 'config.toml');
    symlinkSync(target, link);

    let message = '';
    try {
      writeFileAtomic(link, 'content');
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain(link);
    expect(message).toContain(target);
    expect(message).toContain('not a regular file');
  });

  it('refuses a symlink whose target is a FIFO, naming both', () => {
    if (isWindows) return;
    const target = join(dir, 'config.pipe');
    const result = spawnSync('mkfifo', [target]);
    expect(result.status).toBe(0);
    const link = join(dir, 'config.toml');
    symlinkSync(target, link);

    let message = '';
    try {
      writeFileAtomic(link, 'content');
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain(link);
    expect(message).toContain(target);
    expect(message).toContain('not a regular file');
  });

  it('refuses a read-only target instead of replacing it', () => {
    if (isWindows) return;
    const target = join(dir, 'dotfiles', 'config.toml');
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, 'protected\n');
    chmodSync(target, 0o444);
    const link = join(dir, 'config.toml');
    symlinkSync(target, link);

    expect(() => writeFileAtomic(link, 'overwrite')).toThrow(RegularFileWriteError);
    expect(readFileSync(target, 'utf8')).toBe('protected\n');
  });

  it('refuses a read-only regular destination with no symlink involved', () => {
    if (isWindows) return;
    const target = join(dir, 'config.toml');
    writeFileSync(target, 'protected\n');
    chmodSync(target, 0o444);

    expect(() => writeFileAtomic(target, 'overwrite')).toThrow(RegularFileWriteError);
    expect(readFileSync(target, 'utf8')).toBe('protected\n');
  });

  it('inherits the destination permission bits when no mode is requested', () => {
    if (isWindows) return;
    const target = join(dir, 'config.toml');
    writeFileSync(target, 'old\n', { mode: 0o600 });

    writeFileAtomic(target, 'new\n');

    expect(statSync(target).mode & 0o777).toBe(0o600);
  });

  it('keeps copy-on-write semantics for a hard-linked destination', () => {
    if (isWindows) return;
    const target = join(dir, 'config.toml');
    writeFileSync(target, 'shared\n');
    const hardLink = join(dir, 'other.toml');
    linkSync(target, hardLink);

    writeFileAtomic(target, 'changed\n');

    expect(readFileSync(target, 'utf8')).toBe('changed\n');
    expect(readFileSync(hardLink, 'utf8')).toBe('shared\n');
  });
});

/**
 * The two writers differ on symlinks **on purpose**, and agree everywhere else.
 * Encoding that here means a well-meaning refactor that unifies them fails this
 * test instead of silently changing one of the policies.
 */
describe('atomic writer policy divergence', () => {
  const scenarios = [
    {
      name: 'symlink to a regular file',
      setUp: (): string => {
        const target = join(dir, 'target.txt');
        writeFileSync(target, 'old\n');
        const link = join(dir, 'link.txt');
        symlinkSync(target, link);
        return link;
      },
      syncSucceeds: true,
      asyncSucceeds: false,
    },
    {
      name: 'plain regular file',
      setUp: (): string => {
        const target = join(dir, 'plain.txt');
        writeFileSync(target, 'old\n');
        return target;
      },
      syncSucceeds: true,
      asyncSucceeds: true,
    },
    {
      name: 'path that does not exist yet',
      setUp: (): string => join(dir, 'fresh.txt'),
      syncSucceeds: true,
      asyncSucceeds: true,
    },
    {
      name: 'directory in the way',
      setUp: (): string => {
        const target = join(dir, 'a-directory');
        mkdirSync(target);
        return target;
      },
      syncSucceeds: false,
      asyncSucceeds: false,
    },
    {
      name: 'read-only regular file',
      setUp: (): string => {
        const target = join(dir, 'read-only.txt');
        writeFileSync(target, 'old\n');
        chmodSync(target, 0o444);
        return target;
      },
      syncSucceeds: false,
      asyncSucceeds: false,
    },
  ] as const;

  for (const scenario of scenarios) {
    it(`agrees or diverges as recorded for a ${scenario.name}`, async () => {
      if (isWindows) return;

      const syncPath = scenario.setUp();
      let syncSucceeded = true;
      try {
        writeFileAtomic(syncPath, 'written\n');
      } catch {
        syncSucceeded = false;
      }
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });

      const asyncPath = scenario.setUp();
      let asyncSucceeded = true;
      try {
        await writeRegularFileAtomic(asyncPath, 'written\n');
      } catch {
        asyncSucceeded = false;
      }

      expect(syncSucceeded).toBe(scenario.syncSucceeds);
      expect(asyncSucceeded).toBe(scenario.asyncSucceeds);
    });
  }

  it('keeps the async writer rejecting symlinks with its typed error', async () => {
    if (isWindows) return;
    const target = join(dir, 'target.txt');
    writeFileSync(target, 'old\n');
    const link = join(dir, 'link.txt');
    symlinkSync(target, link);

    await expect(writeRegularFileAtomic(link, 'new\n')).rejects.toBeInstanceOf(
      RegularFileWriteError
    );
    expect(readFileSync(target, 'utf8')).toBe('old\n');
  });
});

function createSymlinkChain(target: string, hops: number): string {
  let next = target;
  for (let index = hops - 1; index >= 0; index -= 1) {
    const link = join(dir, `link-${index}.toml`);
    symlinkSync(next, link);
    next = link;
  }
  return next;
}
