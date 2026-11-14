import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { scanImportCycles } from '../lib/import-cycles';
import {
  isCycleScanExcluded,
  listCycleScanTreeFiles,
  listCycleScanTreeSymlinks,
  listFrontendBoundaryPaths,
  listNodeEnvScanPaths,
  listSymlinksAmong,
} from '../lib/source-scan-paths';
import { canonicalPath } from './support/canonical-path';

const roots: string[] = [];

/** A temporary repository root holding `files` (path to content), removed after the test. */
function createTree(files: Readonly<Record<string, string>>): string {
  const root = canonicalPath(mkdtempSync(join(tmpdir(), 'mango-source-scan-paths-')));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('isCycleScanExcluded', () => {
  test.each([
    ['node_modules/x/index.ts', true],
    ['apps/api/node_modules/x/index.ts', true],
    ['apps/api/dist/app.js', true],
    ['apps/api/coverage/lcov.js', true],
    ['apps/api/.turbo/cache.js', true],
    ['.git/hooks/pre-commit.js', true],
    ['.mango/pass-stamps/a.json', true],
    ['target/debug/build.js', true],
    ['crates/mango-protocol/fuzz/target/x.js', true],
    ['.claude/worktrees/agent-a/apps/api/src/app.ts', true],
    ['apps/api/src/app.ts', false],
    ['apps/api/build/generated.ts', false],
    ['apps/api/target/x.ts', false],
    ['.claude/hooks/auto-fix.mjs', false],
    ['.claude/worktrees-notes/a.ts', false],
    ['crates/mango-protocol/fuzz/fuzz_targets/a.rs', false],
  ])('%s is excluded: %p', (path, expected) => {
    const root = '/repo';
    expect(
      isCycleScanExcluded(join(root, path), root),
      `(cycle scan exclusion): expected ${path} excluded=${expected} | received: ${!expected}`
    ).toBe(expected);
  });
});

describe('listCycleScanTreeFiles', () => {
  const ANY_SOURCE_OR_JSON = /\.(?:[cm]?[jt]s|[jt]sx|jsonc?)$/i;

  test('lists source and JSON files from disk as sorted POSIX paths, gitignored ones included', () => {
    const root = createTree({
      '.gitignore': 'build/\n',
      'apps/api/build/generated.ts': '',
      'apps/api/src/app.ts': '',
      'apps/api/tsconfig.json': '{}',
      'apps/api/README.md': '',
      'scripts/Upper.TS': '',
      'tsconfig.jsonc': '{}',
    });
    expect(listCycleScanTreeFiles(root, ANY_SOURCE_OR_JSON)).toEqual([
      'apps/api/build/generated.ts',
      'apps/api/src/app.ts',
      'apps/api/tsconfig.json',
      'scripts/Upper.TS',
      'tsconfig.jsonc',
    ]);
  });

  test('leaves out every directory the cycle scan skips', () => {
    const root = createTree({
      'src/kept.ts': '',
      'node_modules/pkg/index.ts': '',
      'apps/api/node_modules/pkg/index.ts': '',
      'apps/api/dist/app.js': '',
      '.mango/pass-stamps/x.json': '{}',
      'target/gen.js': '',
      '.claude/worktrees/agent-a/src/copy.ts': '',
      '.git/config.json': '{}',
    });
    expect(listCycleScanTreeFiles(root, ANY_SOURCE_OR_JSON)).toEqual(['src/kept.ts']);
  });

  test('does not follow a symlinked directory, as the cycle scan does not', () => {
    const root = createTree({ 'real/a.ts': '' });
    symlinkSync(join(root, 'real'), join(root, 'alias'), 'junction');
    expect(listCycleScanTreeFiles(root, ANY_SOURCE_OR_JSON)).toEqual(['real/a.ts']);
  });
});

describe('listCycleScanTreeSymlinks', () => {
  test('lists every symlink outside excluded directories with its readlink text', () => {
    const root = createTree({
      'apps/shared/src/x.ts': '',
      'apps/api/src/index.ts': '',
      'dist/gen.ts': '',
      'src/keep.ts': '',
    });
    symlinkSync('../../shared/src', join(root, 'apps/api/src/vendor'));
    symlinkSync('keep.ts', join(root, 'src/alias.ts'));
    symlinkSync('missing/target', join(root, 'src/dangling'));
    symlinkSync('../src', join(root, 'dist/skipped'));
    expect(listCycleScanTreeSymlinks(root)).toEqual([
      'apps/api/src/vendor -> ../../shared/src',
      'src/alias.ts -> keep.ts',
      'src/dangling -> missing/target',
    ]);
  });

  test('is empty when the tree has no symlink', () => {
    expect(listCycleScanTreeSymlinks(createTree({ 'a.ts': '' }))).toEqual([]);
  });
});

describe('listSymlinksAmong', () => {
  test('keeps the listed paths that are symlinks, whatever their name, and skips the rest', () => {
    const root = createTree({ 'a.ts': '', 'dist/real.ts': '' });
    symlinkSync('../a.ts', join(root, 'dist/linked'));
    symlinkSync('dist', join(root, 'folder.ts'));
    expect(
      listSymlinksAmong(root, ['a.ts', 'dist/real.ts', 'dist/linked', 'folder.ts', 'gone.ts'])
    ).toEqual(['dist/linked -> ../a.ts', 'folder.ts -> dist']);
  });
});

describe('the cycle scan and the key agree on nested checkouts', () => {
  test('a cycle inside .claude/worktrees is not reported', () => {
    const root = createTree({
      'src/leaf.ts': 'export const leaf = 1;\n',
      '.claude/worktrees/agent-a/a.ts': "import './b';\n",
      '.claude/worktrees/agent-a/b.ts': "import './a';\n",
    });
    expect(
      scanImportCycles(['.'], root),
      '(import cycles): expected no cycle from .claude/worktrees | received: a cycle'
    ).toEqual([]);
    expect(listCycleScanTreeFiles(root, /\.ts$/)).toEqual(['src/leaf.ts']);
  });
});

describe('listNodeEnvScanPaths', () => {
  test('lists JS and TS files under apps/*/src, with no directory excluded and dot directories skipped', () => {
    const root = createTree({
      'apps/api/src/app.ts': '',
      'apps/api/src/generated/build.mjs': '',
      'apps/api/src/node_modules/x/index.js': '',
      'apps/api/src/.hidden/a.ts': '',
      'apps/api/src/readme.md': '',
      'apps/api/tests/a.ts': '',
      'apps/frontend/src/main.tsx': '',
    });
    expect(listNodeEnvScanPaths(root)).toEqual([
      'apps/api/src/app.ts',
      'apps/api/src/generated/build.mjs',
      'apps/api/src/node_modules/x/index.js',
      'apps/frontend/src/main.tsx',
    ]);
  });
});

describe('listFrontendBoundaryPaths', () => {
  test('lists every frontend source including dot directories and nested build output', () => {
    const root = createTree({
      'apps/frontend/build.ts': '',
      'apps/frontend/build/generated.ts': '',
      'apps/frontend/.storybook/main.ts': '',
      'apps/frontend/src/dist/inner.js': '',
      'apps/frontend/src/a.mts': '',
      'apps/frontend/src/style.css': '',
      'apps/api/src/app.ts': '',
    });
    expect(listFrontendBoundaryPaths(root)).toEqual([
      'apps/frontend/.storybook/main.ts',
      'apps/frontend/build.ts',
      'apps/frontend/build/generated.ts',
      'apps/frontend/src/a.mts',
      'apps/frontend/src/dist/inner.js',
    ]);
  });

  test('skips the generated directories at the workspace root only', () => {
    const root = createTree({
      'apps/frontend/dist/a.js': '',
      'apps/frontend/coverage/a.js': '',
      'apps/frontend/node_modules/a.js': '',
      'apps/frontend/.turbo/a.js': '',
      'apps/frontend/.mango/a.js': '',
      'apps/frontend/src/a.ts': '',
    });
    expect(listFrontendBoundaryPaths(root)).toEqual(['apps/frontend/src/a.ts']);
  });
});
