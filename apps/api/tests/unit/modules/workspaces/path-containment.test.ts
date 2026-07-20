import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertInsideWorkdir,
  isInside,
  isPathPrefix,
  resolvePathForContainment,
  WorkdirContainmentError,
} from '../../../../src/modules/workspaces/application/path-containment';

let rootDir: string;
let outsideDir: string;

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'contain-root-'));
  outsideDir = mkdtempSync(join(tmpdir(), 'contain-out-'));
  mkdirSync(join(rootDir, 'nested'));
  writeFileSync(join(rootDir, 'nested', 'file.txt'), 'hello');
});

afterEach(() => {
  rmSync(rootDir, { recursive: true, force: true });
  rmSync(outsideDir, { recursive: true, force: true });
});

describe('isPathPrefix', () => {
  it('matches the root and descendants with a separator guard', () => {
    expect(isPathPrefix('/tmp/project', '/tmp/project')).toBe(true);
    expect(isPathPrefix('/tmp/project', '/tmp/project/src')).toBe(true);
    expect(isPathPrefix('/tmp/project', '/tmp/project-extra')).toBe(false);
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

  it('checks planned write paths that do not exist yet', () => {
    const planned = join(rootDir, 'nested', 'new-file.txt');
    expect(resolvePathForContainment(planned)).toBe(planned);
    expect(isInside(rootDir, planned)).toBe(true);
    expect(isInside(rootDir, join(outsideDir, 'new.txt'))).toBe(false);
  });
});

describe('assertInsideWorkdir', () => {
  it('throws a descriptive error for outside paths', () => {
    expect(() => assertInsideWorkdir(rootDir, outsideDir)).toThrow(WorkdirContainmentError);
  });
});
