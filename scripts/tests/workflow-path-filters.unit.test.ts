import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { ROOT_DIR } from '../lib/config';
import {
  pathFilterMatches,
  relativeImportClosure,
  uncoveredScriptImports,
  workflowPathFilters,
} from './support/workflow-path-filters';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

/** Writes named sources under a scratch root and returns that root (posix separators). */
function sourceTree(files: Record<string, string>): string {
  const parent = join(ROOT_DIR, '.mango', 'artifacts');
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'workflow-path-filters-'));
  directories.push(root);
  for (const [file, source] of Object.entries(files)) {
    const path = join(root, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, source);
  }
  return root.replaceAll('\\', '/');
}

const WORKFLOW = `name: Sample

on:
  pull_request:
    branches: [main]
    paths:
      - scripts/ci/entry.ts
      - "scripts/lib/shared-*.ts"
      - '!scripts/lib/shared-skip.ts'
  push:
    branches: [main]
    paths:
      - docs/**
  workflow_dispatch:

permissions:
  contents: read
`;

describe('workflowPathFilters', () => {
  it('reads the paths list of the named trigger and strips quotes', () => {
    expect(workflowPathFilters(WORKFLOW, 'pull_request')).toEqual([
      'scripts/ci/entry.ts',
      'scripts/lib/shared-*.ts',
      '!scripts/lib/shared-skip.ts',
    ]);
    expect(workflowPathFilters(WORKFLOW, 'push')).toEqual(['docs/**']);
  });

  it('skips comment lines inside the list', () => {
    const commented = [
      'name: Commented',
      '',
      'on:',
      '  push:',
      '    paths:',
      '      # generated from a manifest',
      '      - "crates/**"',
      '      - spec/**',
      '  workflow_dispatch:',
      '',
    ].join('\n');

    expect(workflowPathFilters(commented, 'push')).toEqual(['crates/**', 'spec/**']);
  });

  it('returns an empty list for a trigger without paths', () => {
    expect(workflowPathFilters(WORKFLOW, 'workflow_dispatch')).toEqual([]);
    expect(workflowPathFilters(WORKFLOW, 'schedule')).toEqual([]);
  });
});

describe('pathFilterMatches', () => {
  const patterns = workflowPathFilters(WORKFLOW, 'pull_request');

  it('matches exact paths and single-segment globs', () => {
    expect(pathFilterMatches(patterns, 'scripts/ci/entry.ts')).toBe(true);
    expect(pathFilterMatches(patterns, 'scripts/lib/shared-a.ts')).toBe(true);
  });

  it('does not let * cross a directory or match an unlisted file', () => {
    expect(pathFilterMatches(patterns, 'scripts/lib/nested/shared-a.ts')).toBe(false);
    expect(pathFilterMatches(patterns, 'scripts/lib/other.ts')).toBe(false);
  });

  it('lets a later ! pattern exclude an earlier match', () => {
    expect(pathFilterMatches(patterns, 'scripts/lib/shared-skip.ts')).toBe(false);
  });

  it('lets ** cross directories', () => {
    expect(
      pathFilterMatches(['scripts/lib/actions-lint/**'], 'scripts/lib/actions-lint/a/b.ts')
    ).toBe(true);
  });
});

describe('relativeImportClosure', () => {
  it('follows static, dynamic, re-export and extensionless imports through .ts and .mjs files', () => {
    const root = sourceTree({
      'scripts/ci/entry.ts': [
        "import { a } from '../lib/a';",
        "export { c } from '../lib/deep/c.ts';",
        "const lazy = await import('../lib/lazy.mjs');",
        "import { join } from 'node:path';",
        "import { bare } from 'some-package';",
      ].join('\n'),
      'scripts/lib/a.ts': "import { b } from './b';\nexport const a = b;",
      'scripts/lib/b.ts': "import { a } from './a';\nexport const b = 1;",
      'scripts/lib/deep/c.ts': "import { index } from '../folder';\nexport const c = index;",
      'scripts/lib/folder/index.ts': 'export const index = 1;',
      'scripts/lib/lazy.mjs': 'export const lazy = 1;',
    });

    expect(relativeImportClosure(['scripts/ci/entry.ts'], root)).toEqual([
      'scripts/ci/entry.ts',
      'scripts/lib/a.ts',
      'scripts/lib/b.ts',
      'scripts/lib/deep/c.ts',
      'scripts/lib/folder/index.ts',
      'scripts/lib/lazy.mjs',
    ]);
  });

  it('reads the imports of an executable script that starts with a hashbang', () => {
    const root = sourceTree({
      'scripts/ci/entry.ts': "#!/usr/bin/env bun\nimport { a } from '../lib/a';",
      'scripts/lib/a.ts': 'export const a = 1;',
    });

    expect(relativeImportClosure(['scripts/ci/entry.ts'], root)).toEqual([
      'scripts/ci/entry.ts',
      'scripts/lib/a.ts',
    ]);
  });

  it('ignores an import that only appears in a comment or a string', () => {
    const root = sourceTree({
      'scripts/ci/entry.ts': [
        "// import { ghost } from '../lib/ghost';",
        'const text = "import { ghost } from \'../lib/ghost\'";',
        'export { text };',
      ].join('\n'),
    });

    expect(relativeImportClosure(['scripts/ci/entry.ts'], root)).toEqual(['scripts/ci/entry.ts']);
  });

  it('lists an imported JSON file without scanning it', () => {
    const root = sourceTree({
      'scripts/ci/entry.ts': "import frames from '../data/frames.json';\nexport { frames };",
      'scripts/data/frames.json': '{ "frames": [] }',
    });

    expect(relativeImportClosure(['scripts/ci/entry.ts'], root)).toEqual([
      'scripts/ci/entry.ts',
      'scripts/data/frames.json',
    ]);
  });

  it('names the file whose source cannot be scanned', () => {
    const root = sourceTree({ 'scripts/ci/broken.ts': 'import { from' });

    expect(() => relativeImportClosure(['scripts/ci/broken.ts'], root)).toThrow(
      '(scripts/ci/broken.ts): imports could not be scanned'
    );
  });

  it('throws naming the importer and specifier when a relative import resolves to no file', () => {
    const root = sourceTree({
      'scripts/ci/entry.ts': "import { gone } from '../lib/gone';",
    });

    expect(() => relativeImportClosure(['scripts/ci/entry.ts'], root)).toThrow(
      "(scripts/ci/entry.ts): relative import '../lib/gone' resolves to no file"
    );
  });
});

describe('uncoveredScriptImports', () => {
  it('lists imported scripts/ modules the patterns do not name, and nothing else', () => {
    const root = sourceTree({
      'scripts/ci/entry.ts':
        "import { a } from '../lib/covered';\nimport { b } from '../lib/missing';",
      'scripts/lib/covered.ts': 'export const a = 1;',
      'scripts/lib/missing.ts':
        "import { c } from '../../packages/outside/src/c';\nexport const b = c;",
      'packages/outside/src/c.ts': 'export const c = 1;',
    });

    expect(
      uncoveredScriptImports(
        ['scripts/ci/entry.ts'],
        ['scripts/ci/entry.ts', 'scripts/lib/covered.ts'],
        root
      )
    ).toEqual(['scripts/lib/missing.ts']);
  });
});
