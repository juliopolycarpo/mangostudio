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
  readFileWithObservedMtime,
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
    const resolved = resolveAndValidatePath(tempDir, {
      settings: { allowedPaths: [], deniedPaths: [] },
    });
    expect(resolved).toBe(tempDir);
  });

  it('resolves a relative path from the chat workdir', () => {
    const resolved = resolveAndValidatePath('src/index.ts', {
      settings: { allowedPaths: [], deniedPaths: [] },
      workdir: tempDir,
    });

    expect(resolved).toBe(join(tempDir, 'src/index.ts'));
  });

  it('uses the workdir policy root for relative paths when available', () => {
    const policyRoot = join(tempDir, 'policy-root');
    const resolved = resolveAndValidatePath('src/index.ts', {
      settings: { allowedPaths: [], deniedPaths: [] },
      workdir: join(tempDir, 'context-workdir'),
      workdirPolicy: { root: policyRoot, restricted: false },
    });

    expect(resolved).toBe(join(policyRoot, 'src/index.ts'));
  });

  it('rejects a relative path when no chat workdir is available', () => {
    expect(() =>
      resolveAndValidatePath('src/index.ts', {
        settings: { allowedPaths: [], deniedPaths: [] },
      })
    ).toThrow(
      'Relative path "src/index.ts" cannot be resolved: no working directory is bound to this chat. Pass an absolute path.'
    );
  });

  it('rejects a relative path that escapes a restricted workdir', () => {
    expect(() =>
      resolveAndValidatePath('../../etc/passwd', {
        settings: { allowedPaths: [], deniedPaths: [] },
        workdirPolicy: { root: tempDir, restricted: true },
      })
    ).toThrow('outside the chat working directory');
  });

  it('allows paths inside an allowed directory', () => {
    const subDir = join(tempDir, 'sub');
    mkdirSync(subDir);
    const resolved = resolveAndValidatePath(subDir, {
      settings: {
        allowedPaths: [{ path: tempDir, enabled: true }],
        deniedPaths: [],
      },
    });
    expect(resolved).toBe(subDir);
  });

  it('rejects paths outside the allowed list', () => {
    expect(() =>
      resolveAndValidatePath('/etc', {
        settings: {
          allowedPaths: [{ path: tempDir, enabled: true }],
          deniedPaths: [],
        },
      })
    ).toThrow(PathAccessError);
  });

  it('rejects denied paths', () => {
    expect(() =>
      resolveAndValidatePath('/etc/passwd', {
        settings: {
          allowedPaths: [],
          deniedPaths: [{ path: '/etc/passwd', enabled: true }],
        },
      })
    ).toThrow(PathAccessError);
  });

  it('rejects paths inside a denied directory', () => {
    expect(() =>
      resolveAndValidatePath('/etc/ssh', {
        settings: {
          allowedPaths: [],
          deniedPaths: [{ path: '/etc', enabled: true }],
        },
      })
    ).toThrow(PathAccessError);
  });

  it('allows paths when allowed list takes precedence over denied list', () => {
    const subDir = join(tempDir, 'nested');
    mkdirSync(subDir);
    const resolved = resolveAndValidatePath(subDir, {
      settings: {
        allowedPaths: [{ path: tempDir, enabled: true }],
        deniedPaths: [{ path: '/unrelated', enabled: true }],
      },
    });
    expect(resolved).toBe(subDir);
  });

  it('rejects paths that match both allowed and denied (deny wins)', () => {
    const deniedSub = join(tempDir, 'secret');
    mkdirSync(deniedSub);
    expect(() =>
      resolveAndValidatePath(deniedSub, {
        settings: {
          allowedPaths: [{ path: tempDir, enabled: true }],
          deniedPaths: [{ path: deniedSub, enabled: true }],
        },
      })
    ).toThrow(PathAccessError);
  });

  it('expands ~ in settings paths', () => {
    const home = Bun.env.HOME ?? '';
    if (!home) return;
    expect(() =>
      resolveAndValidatePath('~', {
        settings: {
          allowedPaths: [{ path: '~', enabled: true }],
          deniedPaths: [],
        },
      })
    ).not.toThrow();
  });

  it('ignores disabled allowed paths', () => {
    expect(() =>
      resolveAndValidatePath('/etc', {
        settings: {
          allowedPaths: [
            { path: tempDir, enabled: true },
            { path: '/etc', enabled: false },
          ],
          deniedPaths: [],
        },
      })
    ).toThrow(PathAccessError);
  });

  it('ignores disabled denied paths', () => {
    const subDir = join(tempDir, 'allowed');
    mkdirSync(subDir);
    const resolved = resolveAndValidatePath(subDir, {
      settings: {
        allowedPaths: [],
        deniedPaths: [
          { path: tempDir, enabled: false },
          { path: '/other', enabled: true },
        ],
      },
    });
    expect(resolved).toBe(subDir);
  });
});

describe('readFileWithObservedMtime', () => {
  it('reads file bytes when under the maxBytes ceiling', async () => {
    const filePath = join(tempDir, 'small.txt');
    await Bun.write(filePath, 'hello');

    const { bytes } = await readFileWithObservedMtime(filePath, { maxBytes: 10 });
    expect(new TextDecoder().decode(bytes)).toBe('hello');
  });

  it('rejects files larger than maxBytes before allocating content', async () => {
    const filePath = join(tempDir, 'too-big.txt');
    await Bun.write(filePath, '0123456789');

    await expect(readFileWithObservedMtime(filePath, { maxBytes: 5 })).rejects.toThrow(
      /too large \(10 bytes; limit is 5\)/
    );
  });

  it('defaults to an unbounded ceiling so freshness hashing stays unrestricted', async () => {
    const filePath = join(tempDir, 'unbounded.txt');
    await Bun.write(filePath, 'ok');

    const { bytes } = await readFileWithObservedMtime(filePath);
    expect(bytes.byteLength).toBe(2);
  });
});
