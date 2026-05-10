import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  expandHome,
  normalizeStringList,
  PathAccessError,
  resolveAndValidatePath,
} from '../../../../src/services/tools/builtin/_fs-utils';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'fs-utils-test-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('normalizeStringList', () => {
  it('returns an empty array for undefined', () => {
    expect(normalizeStringList(undefined)).toEqual([]);
  });

  it('returns an empty array for null', () => {
    expect(normalizeStringList(null)).toEqual([]);
  });

  it('filters and trims string array items', () => {
    expect(normalizeStringList(['  a  ', 'b', '', '  '])).toEqual(['a', 'b']);
  });

  it('splits a string by newlines and trims', () => {
    expect(normalizeStringList('a\nb\n\n  c  ')).toEqual(['a', 'b', 'c']);
  });

  it('returns an empty array for a number', () => {
    expect(normalizeStringList(42)).toEqual([]);
  });
});

describe('expandHome', () => {
  it('expands ~ to the home directory', () => {
    const home = Bun.env.HOME ?? '';
    if (!home) return;
    expect(expandHome('~/test')).toBe(`${home}/test`);
  });

  it('leaves absolute paths unchanged', () => {
    expect(expandHome('/usr/bin')).toBe('/usr/bin');
  });

  it('leaves relative paths unchanged', () => {
    expect(expandHome('foo/bar')).toBe('foo/bar');
  });

  it('expands bare ~ to home directory', () => {
    const home = Bun.env.HOME ?? '';
    if (!home) return;
    expect(expandHome('~')).toBe(home);
  });
});

describe('resolveAndValidatePath', () => {
  it('resolves and returns a valid path when no restrictions are set', () => {
    const resolved = resolveAndValidatePath(tempDir, { allowedPaths: [], deniedPaths: [] });
    expect(resolved).toBe(tempDir);
  });

  it('allows paths inside an allowed directory', () => {
    const subDir = join(tempDir, 'sub');
    mkdirSync(subDir);
    const resolved = resolveAndValidatePath(subDir, {
      allowedPaths: [tempDir],
      deniedPaths: [],
    });
    expect(resolved).toBe(subDir);
  });

  it('rejects paths outside the allowed list', () => {
    expect(() =>
      resolveAndValidatePath('/etc', { allowedPaths: [tempDir], deniedPaths: [] })
    ).toThrow(PathAccessError);
  });

  it('rejects denied paths', () => {
    expect(() =>
      resolveAndValidatePath('/etc/passwd', { allowedPaths: [], deniedPaths: ['/etc/passwd'] })
    ).toThrow(PathAccessError);
  });

  it('rejects paths inside a denied directory', () => {
    expect(() =>
      resolveAndValidatePath('/etc/ssh', { allowedPaths: [], deniedPaths: ['/etc'] })
    ).toThrow(PathAccessError);
  });

  it('allows paths when allowed list takes precedence over denied list', () => {
    const subDir = join(tempDir, 'nested');
    mkdirSync(subDir);
    const resolved = resolveAndValidatePath(subDir, {
      allowedPaths: [tempDir],
      deniedPaths: ['/unrelated'],
    });
    expect(resolved).toBe(subDir);
  });

  it('rejects paths that match both allowed and denied (deny wins)', () => {
    const deniedSub = join(tempDir, 'secret');
    mkdirSync(deniedSub);
    expect(() =>
      resolveAndValidatePath(deniedSub, {
        allowedPaths: [tempDir],
        deniedPaths: [deniedSub],
      })
    ).toThrow(PathAccessError);
  });

  it('expands ~ in settings paths', () => {
    const home = Bun.env.HOME ?? '';
    if (!home) return;
    expect(() =>
      resolveAndValidatePath(home, { allowedPaths: ['~'], deniedPaths: [] })
    ).not.toThrow();
  });
});
