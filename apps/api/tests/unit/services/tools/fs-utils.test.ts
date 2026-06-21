import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  expandHome,
  getRequiredPathArg,
  normalizePathList,
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

describe('normalizePathList', () => {
  it('maps legacy string arrays to enabled path entries', () => {
    expect(normalizePathList([' /tmp ', '', '/var'])).toEqual([
      { path: '/tmp', enabled: true },
      { path: '/var', enabled: true },
    ]);
  });

  it('keeps lenient filesystem-tool parsing for malformed path arrays', () => {
    expect(
      normalizePathList([{ path: ' /tmp ', enabled: true }, 42, { path: '', enabled: false }])
    ).toEqual([{ path: '/tmp', enabled: true }]);
  });
});

describe('getRequiredPathArg', () => {
  it('returns the trimmed path', () => {
    expect(getRequiredPathArg('  /tmp/file  ', 'path')).toBe('/tmp/file');
  });

  it('throws PathAccessError for an empty string', () => {
    expect(() => getRequiredPathArg('   ', 'path')).toThrow(PathAccessError);
  });

  it('throws PathAccessError naming the field for a non-string', () => {
    expect(() => getRequiredPathArg(42, 'path')).toThrow('Missing required path.');
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
      allowedPaths: [{ path: tempDir, enabled: true }],
      deniedPaths: [],
    });
    expect(resolved).toBe(subDir);
  });

  it('rejects paths outside the allowed list', () => {
    expect(() =>
      resolveAndValidatePath('/etc', {
        allowedPaths: [{ path: tempDir, enabled: true }],
        deniedPaths: [],
      })
    ).toThrow(PathAccessError);
  });

  it('rejects denied paths', () => {
    expect(() =>
      resolveAndValidatePath('/etc/passwd', {
        allowedPaths: [],
        deniedPaths: [{ path: '/etc/passwd', enabled: true }],
      })
    ).toThrow(PathAccessError);
  });

  it('rejects paths inside a denied directory', () => {
    expect(() =>
      resolveAndValidatePath('/etc/ssh', {
        allowedPaths: [],
        deniedPaths: [{ path: '/etc', enabled: true }],
      })
    ).toThrow(PathAccessError);
  });

  it('allows paths when allowed list takes precedence over denied list', () => {
    const subDir = join(tempDir, 'nested');
    mkdirSync(subDir);
    const resolved = resolveAndValidatePath(subDir, {
      allowedPaths: [{ path: tempDir, enabled: true }],
      deniedPaths: [{ path: '/unrelated', enabled: true }],
    });
    expect(resolved).toBe(subDir);
  });

  it('rejects paths that match both allowed and denied (deny wins)', () => {
    const deniedSub = join(tempDir, 'secret');
    mkdirSync(deniedSub);
    expect(() =>
      resolveAndValidatePath(deniedSub, {
        allowedPaths: [{ path: tempDir, enabled: true }],
        deniedPaths: [{ path: deniedSub, enabled: true }],
      })
    ).toThrow(PathAccessError);
  });

  it('expands ~ in settings paths', () => {
    const home = Bun.env.HOME ?? '';
    if (!home) return;
    expect(() =>
      resolveAndValidatePath(home, {
        allowedPaths: [{ path: '~', enabled: true }],
        deniedPaths: [],
      })
    ).not.toThrow();
  });

  it('ignores disabled allowed paths', () => {
    expect(() =>
      resolveAndValidatePath('/etc', {
        allowedPaths: [
          { path: tempDir, enabled: true },
          { path: '/etc', enabled: false },
        ],
        deniedPaths: [],
      })
    ).toThrow(PathAccessError);
  });

  it('ignores disabled denied paths', () => {
    const subDir = join(tempDir, 'allowed');
    mkdirSync(subDir);
    const resolved = resolveAndValidatePath(subDir, {
      allowedPaths: [],
      deniedPaths: [
        { path: tempDir, enabled: false },
        { path: '/other', enabled: true },
      ],
    });
    expect(resolved).toBe(subDir);
  });
});
