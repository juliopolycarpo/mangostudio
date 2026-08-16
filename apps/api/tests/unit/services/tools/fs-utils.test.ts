import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTargetPaths } from '../../../../src/services/runtime-client/target-paths';
import {
  expandHome,
  getRequiredPathArg,
  normalizePathList,
  normalizeStringList,
  PathAccessError,
  readFileWithObservedMtime,
  reportWorkdirRelativePath,
  resolveAndValidatePath,
} from '../../../../src/services/tools/builtin/_fs-utils';

const targetPaths = (pathStyle: 'posix' | 'win32', homeDir: string) =>
  createTargetPaths({
    platform: pathStyle === 'win32' ? 'win32' : 'linux',
    arch: 'x64',
    pathStyle,
    homeDir,
    shells: [],
    git: { available: false },
    features: {
      tools: true,
      git: true,
      probing: false,
      mcp: false,
      library: false,
      checkpoints: true,
    },
  });

const paths = targetPaths('posix', '/home/tester');
const windowsPaths = targetPaths('win32', 'C:\\Users\\tester');

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
  it('expands ~ to the home directory the target reported', () => {
    expect(expandHome('~/test', paths)).toBe('/home/tester/test');
  });

  it('leaves absolute paths unchanged', () => {
    expect(expandHome('/usr/bin', paths)).toBe('/usr/bin');
  });

  it('leaves relative paths unchanged', () => {
    expect(expandHome('foo/bar', paths)).toBe('foo/bar');
  });

  it('expands bare ~ to home directory', () => {
    expect(expandHome('~', paths)).toBe('/home/tester');
  });

  it('expands ~ on a Windows target with its own separator', () => {
    expect(expandHome('~/test', windowsPaths)).toBe('C:\\Users\\tester\\test');
    expect(expandHome('~\\test', windowsPaths)).toBe('C:\\Users\\tester\\test');
  });

  it('leaves ~ alone when the target reports no home directory', () => {
    expect(expandHome('~/test', targetPaths('posix', ''))).toBe('~/test');
  });
});

describe('resolveAndValidatePath', () => {
  it('resolves and returns a valid path when no restrictions are set', () => {
    const resolved = resolveAndValidatePath(tempDir, {
      paths,
      settings: { allowedPaths: [], deniedPaths: [] },
    });
    expect(resolved).toBe(tempDir);
  });

  it('resolves a relative path from the chat workdir', () => {
    const resolved = resolveAndValidatePath('src/index.ts', {
      paths,
      settings: { allowedPaths: [], deniedPaths: [] },
      workdir: tempDir,
    });

    expect(resolved).toBe(join(tempDir, 'src/index.ts'));
  });

  it('uses the workdir policy root for relative paths when available', () => {
    const policyRoot = join(tempDir, 'policy-root');
    const resolved = resolveAndValidatePath('src/index.ts', {
      paths,
      settings: { allowedPaths: [], deniedPaths: [] },
      workdir: join(tempDir, 'context-workdir'),
      workdirPolicy: { root: policyRoot, restricted: false },
    });

    expect(resolved).toBe(join(policyRoot, 'src/index.ts'));
  });

  it('rejects a relative path when no chat workdir is available', () => {
    expect(() =>
      resolveAndValidatePath('src/index.ts', {
        paths,
        settings: { allowedPaths: [], deniedPaths: [] },
      })
    ).toThrow(
      'Relative path "src/index.ts" cannot be resolved: no working directory is bound to this chat. Pass an absolute path.'
    );
  });

  it('rejects a relative path when the workdir is not absolute on the target', () => {
    // A Windows workdir paired with a Linux target: `resolve` would answer with
    // the hub's own working directory rather than refusing.
    expect(() =>
      resolveAndValidatePath('src/index.ts', {
        paths,
        settings: { allowedPaths: [], deniedPaths: [] },
        workdirPolicy: { root: 'C:\\Users\\tester\\project', restricted: false },
      })
    ).toThrow(
      'the working directory "C:\\Users\\tester\\project" is not an absolute path on this environment'
    );
  });

  it('rejects a relative path that escapes a restricted workdir', () => {
    expect(() =>
      resolveAndValidatePath('../../etc/passwd', {
        paths,
        settings: { allowedPaths: [], deniedPaths: [] },
        workdirPolicy: { root: tempDir, restricted: true },
      })
    ).toThrow('outside the chat working directory');
  });

  it('allows paths inside an allowed directory', () => {
    const subDir = join(tempDir, 'sub');
    mkdirSync(subDir);
    const resolved = resolveAndValidatePath(subDir, {
      paths,
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
        paths,
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
        paths,
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
        paths,
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
      paths,
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
        paths,
        settings: {
          allowedPaths: [{ path: tempDir, enabled: true }],
          deniedPaths: [{ path: deniedSub, enabled: true }],
        },
      })
    ).toThrow(PathAccessError);
  });

  it('expands ~ in settings paths against the target home', () => {
    expect(
      resolveAndValidatePath('~/notes', {
        paths,
        settings: {
          allowedPaths: [{ path: '~', enabled: true }],
          deniedPaths: [],
        },
      })
    ).toBe('/home/tester/notes');
  });

  it('ignores disabled allowed paths', () => {
    expect(() =>
      resolveAndValidatePath('/etc', {
        paths,
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
      paths,
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

describe('reportWorkdirRelativePath', () => {
  it('reports a path below the workdir relative to it', () => {
    expect(
      reportWorkdirRelativePath('/home/tester/proj/src/a.ts', {
        paths,
        workdir: '/home/tester/proj',
      })
    ).toBe('src/a.ts');
  });

  it('reports the workdir itself as "." rather than the empty string', () => {
    expect(
      reportWorkdirRelativePath('/home/tester/proj', { paths, workdir: '/home/tester/proj' })
    ).toBe('.');
  });

  it('falls back to absolute when the path is outside the workdir', () => {
    expect(reportWorkdirRelativePath('/etc/passwd', { paths, workdir: '/home/tester/proj' })).toBe(
      '/etc/passwd'
    );
  });

  it('falls back to absolute when no workdir is bound', () => {
    expect(reportWorkdirRelativePath('/home/tester/proj/a.ts', { paths })).toBe(
      '/home/tester/proj/a.ts'
    );
  });

  it('prefers the restriction root over the plain workdir', () => {
    expect(
      reportWorkdirRelativePath('/home/tester/proj/src/a.ts', {
        paths,
        workdir: '/somewhere/else',
        workdirPolicy: { root: '/home/tester/proj', restricted: true },
      })
    ).toBe('src/a.ts');
  });

  it('expands a ~ workdir against the target home', () => {
    expect(reportWorkdirRelativePath('/home/tester/proj/a.ts', { paths, workdir: '~/proj' })).toBe(
      'a.ts'
    );
  });

  it('folds case on a Windows target, where a root and its contents may differ in casing', () => {
    expect(
      reportWorkdirRelativePath('c:\\users\\tester\\proj\\src\\a.ts', {
        paths: windowsPaths,
        workdir: 'C:\\Users\\tester\\Proj',
      })
    ).toBe('src\\a.ts');
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

  it('reads a file sized exactly at the ceiling', async () => {
    const filePath = join(tempDir, 'exact.bin');
    await Bun.write(filePath, new Uint8Array(64));

    const { bytes } = await readFileWithObservedMtime(filePath, { maxBytes: 64 });
    expect(bytes.byteLength).toBe(64);
  });

  it('reads a file larger than its own stat size, up to the ceiling', async () => {
    // The growth loop is what keeps a stat-vs-read mismatch from truncating an
    // ordinary read; the ceiling is the only thing that stops it.
    const filePath = join(tempDir, 'grown.txt');
    await Bun.write(filePath, '0123456789');

    const { bytes } = await readFileWithObservedMtime(filePath, { maxBytes: 1_000 });
    expect(new TextDecoder().decode(bytes)).toBe('0123456789');
  });

  // A procfs entry is the reproduction case from the issue: `stat` reports
  // `size: 0`, so the pre-read check passes trivially, and the descriptor then
  // streams however many bytes it likes. The ceiling has to bind the read.
  it.skipIf(process.platform !== 'linux')(
    'bounds a file whose stat under-reports its size by the bytes actually read',
    async () => {
      await expect(
        readFileWithObservedMtime('/proc/self/status', { maxBytes: 64 })
      ).rejects.toThrow(/too large \(more than 64 bytes; limit is 64\)/);
    }
  );

  it.skipIf(process.platform !== 'linux')(
    'still reads a stat-less file in full when it fits under the ceiling',
    async () => {
      const { bytes } = await readFileWithObservedMtime('/proc/self/status', {
        maxBytes: 1024 * 1024,
      });

      expect(bytes.byteLength).toBeGreaterThan(0);
      expect(new TextDecoder().decode(bytes)).toContain('Name:');
    }
  );
});
