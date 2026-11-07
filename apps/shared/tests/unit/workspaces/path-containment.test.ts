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
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  isInside,
  isPathPrefix,
  resolveContainmentRoot,
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
    'rejects parent steps after a missing component, including within the missing suffix',
    () => {
      mkdirSync(join(outsideDir, 'nested'));
      symlinkSync(join(outsideDir, 'nested'), join(rootDir, 'redirect'), 'dir');
      const planned = `${rootDir}/missing/../redirect/../new/file.txt`;

      expect(() => resolvePathForContainment(planned)).toThrow('ENOENT');
      expect(() => isInside(rootDir, planned)).toThrow('ENOENT');
      const partlyMissing = `${rootDir}/missing/child/../file.txt`;
      expect(() => resolvePathForContainment(partlyMissing)).toThrow('ENOENT');
    }
  );

  it.skipIf(process.platform === 'win32')(
    'reports ENOTDIR when a parent step attempts to traverse a regular file',
    () => {
      const candidate = `${rootDir}/nested/file.txt/../next.txt`;
      expect(() => resolvePathForContainment(candidate)).toThrow('ENOTDIR');
    }
  );

  it.skipIf(process.platform === 'win32')(
    'requires a directory at a trailing slash in raw paths and symlink targets',
    () => {
      const directory = join(rootDir, 'nested');
      const file = join(directory, 'file.txt');
      const missing = join(rootDir, 'missing');
      const link = join(rootDir, 'link');
      symlinkSync(`${file}/`, link);

      expect(() => resolvePathForContainment(`${file}/`)).toThrow('ENOTDIR');
      expect(() => resolvePathForContainment(link)).toThrow('ENOTDIR');
      expect(() => resolvePathForContainment(`${missing}/`)).toThrow('ENOENT');
      expect(() => resolvePathForContainment(`${missing}/.`)).toThrow('ENOENT');
      expect(resolvePathForContainment(`${directory}/`)).toBe(directory);

      const planned = join(rootDir, 'planned');
      symlinkSync('missing/', planned);
      expect(() => resolvePathForContainment(planned)).toThrow('ENOENT');
      expect(resolvePathForContainment(join(planned, 'file.txt'))).toBe(join(missing, 'file.txt'));
    }
  );

  it.skipIf(process.platform === 'win32')(
    'uses the physical root when a parent step follows a directory link in the root',
    () => {
      mkdirSync(join(rootDir, 'assets'));
      mkdirSync(join(outsideDir, 'assets'));
      mkdirSync(join(outsideDir, 'nested'));
      symlinkSync(join(outsideDir, 'nested'), join(rootDir, 'redirect'), 'dir');
      const configured = `${rootDir}/redirect/../assets`;

      expect(resolveContainmentRoot(configured)).toBe(join(outsideDir, 'assets'));
      expect(isInside(configured, join(outsideDir, 'assets', 'real.txt'))).toBe(true);
      expect(isInside(configured, join(rootDir, 'assets', 'lexical.txt'))).toBe(false);
    }
  );

  it.skipIf(process.platform === 'win32')(
    'requires the physical containment root to exist before applying parent steps',
    () => {
      expect(() => resolveContainmentRoot(`${rootDir}/missing/../nested`)).toThrow('ENOENT');
    }
  );

  it('expands configured root home aliases', () => {
    const home = realpathSync(homedir());
    expect(resolveContainmentRoot('~')).toBe(home);
    expect(resolveContainmentRoot('~/')).toBe(home);
    expect(resolveContainmentRoot('~\\')).toBe(home);
  });

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
