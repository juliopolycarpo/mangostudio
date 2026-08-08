import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertExpectedResourceEntry,
  LibraryWriteError,
  resolveContainedResourcePath,
} from '../../../../src/modules/library/domain/path-safety';

let tempDir: string;
let locationRoot: string;
let outsideDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'mango-library-path-'));
  locationRoot = join(tempDir, 'location');
  outsideDir = join(tempDir, 'outside');
  mkdirSync(locationRoot);
  mkdirSync(outsideDir);
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('library path containment', () => {
  it.each(['../../etc/passwd', '/etc/passwd', 'a/../../b', '.', 'stream:name'])(
    'rejects unsafe slug %s',
    (slug) => {
      expect(() => resolveContainedResourcePath(locationRoot, slug)).toThrow(LibraryWriteError);
      try {
        resolveContainedResourcePath(locationRoot, slug);
      } catch (error) {
        expect(error).toMatchObject({ reason: 'invalid-slug' });
      }
    }
  );

  it('accepts a destination beneath a symlinked location root', () => {
    const dotfilesRoot = join(tempDir, 'dotfiles', 'skills');
    const linkedRoot = join(tempDir, 'linked-skills');
    mkdirSync(dotfilesRoot, { recursive: true });
    symlinkSync(dotfilesRoot, linkedRoot);

    expect(resolveContainedResourcePath(linkedRoot, 'gh')).toMatchObject({
      logicalPath: join(linkedRoot, 'gh'),
      resolvedRoot: dotfilesRoot,
      resolvedPath: join(dotfilesRoot, 'gh'),
    });
  });

  it('rejects a destination symlink that escapes the location root', () => {
    symlinkSync(outsideDir, join(locationRoot, 'gh'));

    expect(() => resolveContainedResourcePath(locationRoot, 'gh')).toThrow(/resolves outside/);
  });
});

describe('library destination entry types', () => {
  it('accepts regular directories and absent destinations', () => {
    expect(() => assertExpectedResourceEntry(locationRoot, 'directory')).not.toThrow();
    expect(() =>
      assertExpectedResourceEntry(join(locationRoot, 'not-created'), 'directory')
    ).not.toThrow();
  });

  it('refuses a FIFO with a typed write error', () => {
    if (process.platform === 'win32') return;
    const fifoPath = join(locationRoot, 'events');
    const created = spawnSync('mkfifo', [fifoPath]);
    expect(created.status).toBe(0);

    expect(() => assertExpectedResourceEntry(fifoPath, 'file')).toThrow(LibraryWriteError);
    try {
      assertExpectedResourceEntry(fifoPath, 'file');
    } catch (error) {
      expect(error).toMatchObject({ reason: 'unexpected-entry-type' });
    }
  });

  it('refuses a regular file where a directory resource would land', () => {
    const filePath = join(locationRoot, 'gh');
    writeFileSync(filePath, 'not a directory');

    expect(() => assertExpectedResourceEntry(filePath, 'directory')).toThrow(
      /not a regular directory/
    );
  });
});
