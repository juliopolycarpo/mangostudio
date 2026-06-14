import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assertDirectory, assertFile, fileError } from '../lib/fs-assert';

// Exercises the helpers against a real isolated temp directory (mocking the
// filesystem would test nothing) and cleans it up so no data leaks.
let tempDirs: string[] = [];

const makeTempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'mango-fs-assert-'));
  tempDirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { force: true, recursive: true });
  }

  tempDirs = [];
});

describe('assertFile', () => {
  test('passes for an existing file', () => {
    const dir = makeTempDir();
    const filePath = join(dir, 'present');
    writeFileSync(filePath, 'data');

    expect(() => assertFile(filePath, 'present file')).not.toThrow();
  });

  test('throws for a missing path', () => {
    const dir = makeTempDir();

    expect(() => assertFile(join(dir, 'absent'), 'present file')).toThrow(
      `Missing present file: ${join(dir, 'absent')}`
    );
  });

  test('throws when a directory is found where a file is expected', () => {
    const dir = makeTempDir();
    const nested = join(dir, 'nested');
    mkdirSync(nested);

    expect(() => assertFile(nested, 'present file')).toThrow(`Missing present file: ${nested}`);
  });
});

describe('assertDirectory', () => {
  test('passes for an existing directory', () => {
    const dir = makeTempDir();

    expect(() => assertDirectory(dir, 'present dir')).not.toThrow();
  });

  test('throws for a missing path', () => {
    const dir = makeTempDir();

    expect(() => assertDirectory(join(dir, 'absent'), 'present dir')).toThrow(
      `Missing present dir: ${join(dir, 'absent')}`
    );
  });

  test('throws when a file is found where a directory is expected', () => {
    const dir = makeTempDir();
    const filePath = join(dir, 'file');
    writeFileSync(filePath, 'data');

    expect(() => assertDirectory(filePath, 'present dir')).toThrow(
      `Missing present dir: ${filePath}`
    );
  });
});

describe('fileError', () => {
  test('returns no errors for an existing file', () => {
    const dir = makeTempDir();
    const filePath = join(dir, 'present');
    writeFileSync(filePath, 'data');

    expect(fileError(filePath, 'binary')).toEqual([]);
  });

  test('reports a missing path', () => {
    const dir = makeTempDir();
    const filePath = join(dir, 'absent');

    expect(fileError(filePath, 'binary')).toEqual([`Missing binary: ${filePath}`]);
  });

  test('reports a directory found where a file is expected distinctly from missing', () => {
    const dir = makeTempDir();
    const nested = join(dir, 'nested');
    mkdirSync(nested);

    expect(fileError(nested, 'binary')).toEqual([`Expected binary to be a file: ${nested}`]);
  });
});
