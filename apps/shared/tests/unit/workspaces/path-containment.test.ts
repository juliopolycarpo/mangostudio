import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  isInside,
  isPathPrefix,
  resolvePathForContainment,
} from '../../../src/workspaces/path-containment';

let rootDir: string;
let outsideDir: string;

beforeEach(() => {
  // realpath up front: tmpdir() is a symlink on macOS, and containment
  // canonicalizes, so the identity assertions need canonical roots.
  rootDir = realpathSync(mkdtempSync(join(tmpdir(), 'contain-root-')));
  outsideDir = realpathSync(mkdtempSync(join(tmpdir(), 'contain-out-')));
  mkdirSync(join(rootDir, 'nested'));
  writeFileSync(join(rootDir, 'nested', 'file.txt'), 'hello');
});

afterEach(() => {
  rmSync(rootDir, { recursive: true, force: true });
  rmSync(outsideDir, { recursive: true, force: true });
});

describe('isPathPrefix', () => {
  it('matches the root and descendants with a separator guard', () => {
    expect(isPathPrefix(rootDir, rootDir)).toBe(true);
    expect(isPathPrefix(rootDir, join(rootDir, 'nested'))).toBe(true);
    expect(isPathPrefix(rootDir, `${rootDir}-extra`)).toBe(false);
  });

  it.skipIf(process.platform !== 'win32')('keeps resolved Windows component case exact', () => {
    expect(isPathPrefix('C:\\Workspace', 'C:\\Workspace\\nested')).toBe(true);
    expect(isPathPrefix('C:\\Workspace', 'c:\\workspace\\nested')).toBe(false);
    expect(isPathPrefix('\\\\?\\C:\\Workspace', '\\\\?\\C:\\Workspace\\nested')).toBe(true);
    expect(isPathPrefix('C:\\Workspace', 'C:\\Workspace-copy')).toBe(false);
  });
});

describe('isInside', () => {
  it('accepts paths inside the root including via .. segments', () => {
    expect(isInside(rootDir, join(rootDir, 'nested', 'file.txt'))).toBe(true);
    expect(isInside(rootDir, join(rootDir, 'nested', '..', 'nested'))).toBe(true);
  });

  it('rejects paths outside the root', () => {
    expect(isInside(rootDir, outsideDir)).toBe(false);
  });

  it('rejects ../ escape attempts that leave the root', () => {
    expect(isInside(rootDir, join(rootDir, '..', 'escape.txt'))).toBe(false);
  });

  it('rejects symlink escapes that resolve outside the root', () => {
    const linkPath = join(rootDir, 'escape-link');
    symlinkSync(outsideDir, linkPath);
    expect(isInside(rootDir, join(linkPath, 'any.txt'))).toBe(false);
  });

  it('allows symlinks that stay inside the root', () => {
    const target = join(rootDir, 'nested');
    const linkPath = join(rootDir, 'inner-link');
    symlinkSync(target, linkPath);
    expect(isInside(rootDir, join(linkPath, 'file.txt'))).toBe(true);
  });

  it('rejects a dangling symlink whose target lands outside the root', () => {
    // realpath reports a dangling link as ENOENT, but a write through it escapes.
    const linkPath = join(rootDir, 'nested', 'dangling.txt');
    symlinkSync(join(outsideDir, 'planted.txt'), linkPath);
    expect(isInside(rootDir, linkPath)).toBe(false);
  });

  it('allows a dangling symlink whose target stays inside the root', () => {
    const linkPath = join(rootDir, 'nested', 'pending.txt');
    symlinkSync(join(rootDir, 'nested', 'not-yet.txt'), linkPath);
    expect(isInside(rootDir, linkPath)).toBe(true);
  });

  it.skipIf(process.platform === 'win32')(
    'follows a directory link before applying a parent step in a path or relative link target',
    () => {
      mkdirSync(join(outsideDir, 'nested'));
      const target = join(outsideDir, 'secret.txt');
      writeFileSync(target, 'outside file');
      symlinkSync(join(outsideDir, 'nested'), join(rootDir, 'redirect'), 'dir');
      const link = join(rootDir, '.env');
      symlinkSync('redirect/../secret.txt', link);
      const candidate = `${rootDir}/redirect/../secret.txt`;
      expect(readFileSync(candidate, 'utf8')).toBe('outside file');
      expect(readFileSync(link, 'utf8')).toBe('outside file');

      expect(resolvePathForContainment(candidate)).toBe(target);
      expect(resolvePathForContainment(link)).toBe(target);
      expect(isInside(rootDir, candidate)).toBe(false);
      expect(isInside(rootDir, link)).toBe(false);
    }
  );

  it.skipIf(process.platform === 'win32')(
    'probes again after a parent step cancels a missing component of a planned path',
    () => {
      mkdirSync(join(outsideDir, 'nested'));
      symlinkSync(join(outsideDir, 'nested'), join(rootDir, 'redirect'), 'dir');
      const planned = `${rootDir}/missing/../redirect/../new/file.txt`;

      expect(resolvePathForContainment(planned)).toBe(join(outsideDir, 'new', 'file.txt'));
      expect(isInside(rootDir, planned)).toBe(false);
    }
  );

  it.skipIf(process.platform === 'win32')(
    'reports ENOTDIR when a parent step attempts to traverse a regular file',
    () => {
      const candidate = `${rootDir}/nested/file.txt/../next.txt`;
      expect(() => resolvePathForContainment(candidate)).toThrow('ENOTDIR');
    }
  );

  it('does not expand ~, so the checked path is the one the filesystem opens', () => {
    // Expanding here would approve `~/escape.txt` as `$HOME/escape.txt` while the
    // write landed in a directory literally named `~`.
    expect(resolvePathForContainment('~/escape.txt')).toBe(resolve('~/escape.txt'));
    expect(isInside(rootDir, '~/escape.txt')).toBe(false);
  });

  it('checks planned write paths that do not exist yet', () => {
    const planned = join(rootDir, 'nested', 'new-file.txt');
    expect(resolvePathForContainment(planned)).toBe(planned);
    expect(isInside(rootDir, planned)).toBe(true);
    expect(isInside(rootDir, join(outsideDir, 'new.txt'))).toBe(false);
  });
});
