import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RegularFileReadError,
  type RegularFileReadFailure,
  readRegularFileUtf8,
  readUtf8FileOrNull,
  SECRET_FILE_MODE,
  statRegularFile,
  writeFileAtomic,
} from '../../../src/lib/safe-file';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mango-safe-file-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const isWindows = process.platform === 'win32';

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
