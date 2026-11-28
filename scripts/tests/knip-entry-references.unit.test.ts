import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import { ROOT_DIR } from '../lib/config';
import {
  CHECKED_ENTRY_DIRECTORIES,
  describeOrphanKnipEntry,
  expandBraces,
  explicitKnipEntries,
  findOrphanKnipEntries,
  readReferenceCorpus,
  type ReferenceCorpusGroup,
} from './support/knip-entry-references';

const ENTRY = 'scripts/ci/select-thing.ts';

// A named fake for the repository: one group per kind of caller, with only the files a case needs.
function corpus(
  files: Partial<Record<'workflows' | 'actions' | 'packages' | 'docs' | 'scripts', string[][]>>
): ReferenceCorpusGroup[] {
  const group = (label: string, rows: string[][] | undefined) => ({
    label,
    files: (rows ?? []).map(([path, text]) => ({ path: path as string, text: text as string })),
  });
  return [
    group('workflows', files.workflows),
    group('composite actions', files.actions),
    group('package.json files', files.packages),
    group('docs', files.docs),
    group('non-test scripts', files.scripts),
  ];
}

describe('expandBraces', () => {
  test('returns a path without braces unchanged', () => {
    expect(expandBraces('scripts/ci/a.ts')).toEqual(['scripts/ci/a.ts']);
  });

  test('expands one alternative list and nested positions in order', () => {
    expect(expandBraces('scripts/ci/{a,b}.ts')).toEqual(['scripts/ci/a.ts', 'scripts/ci/b.ts']);
    expect(expandBraces('scripts/{ci,release}/{a,b}.ts')).toEqual([
      'scripts/ci/a.ts',
      'scripts/ci/b.ts',
      'scripts/release/a.ts',
      'scripts/release/b.ts',
    ]);
  });

  test('names the pattern when a brace is never closed', () => {
    expect(() => expandBraces('scripts/ci/{a,b.ts')).toThrow(
      'knip entry "scripts/ci/{a,b.ts": expected a closing "}" | received: none'
    );
  });
});

describe('explicitKnipEntries', () => {
  test('keeps named files directly under a checked directory and drops wildcards and other paths', () => {
    expect(
      explicitKnipEntries([
        'scripts/ci/{a,b}.ts',
        'scripts/ci/c.ts',
        'scripts/release/*.sh',
        'scripts/release/d.ts',
        'scripts/bench/e.ts',
        'scripts/ci/nested/f.ts',
        'scripts/tests/**/*.test.ts',
      ])
    ).toEqual(['scripts/ci/a.ts', 'scripts/ci/b.ts', 'scripts/ci/c.ts', 'scripts/release/d.ts']);
  });
});

describe('findOrphanKnipEntries', () => {
  test.each([
    ['a workflow step', { workflows: [['.github/workflows/canary.yml', `run: bun ./${ENTRY}`]] }],
    ['a composite action', { actions: [['.github/actions/x/action.yml', `run: bun ${ENTRY}`]] }],
    ['a package.json script', { packages: [['package.json', `{"scripts":{"x":"bun ${ENTRY}"}}`]] }],
    [
      'a doc-listed manual tool',
      { docs: [['scripts/README.md', 'ci/select-thing.ts  Select it']] },
    ],
    [
      'another script that imports it',
      { scripts: [['scripts/lib/runner.ts', "import { x } from '../ci/select-thing';"]] },
    ],
    [
      'a sibling script in the same directory',
      { scripts: [['scripts/ci/other.ts', "import { x } from './select-thing';"]] },
    ],
  ] as const)('accepts an entry named by %s', (_name, files) => {
    expect(findOrphanKnipEntries([ENTRY], corpus(files as never))).toEqual([]);
  });

  test('reports an entry named by nothing, with every group it searched', () => {
    expect(
      findOrphanKnipEntries([ENTRY], corpus({ workflows: [['a.yml', 'run: bun x.ts']] }))
    ).toEqual([
      {
        entry: ENTRY,
        searched: [
          'workflows (1 files)',
          'composite actions (0 files)',
          'package.json files (0 files)',
          'docs (0 files)',
          'non-test scripts (0 files)',
        ],
      },
    ]);
  });

  test('does not count the entry file itself as its own caller', () => {
    const files = { scripts: [[ENTRY, `// usage: bun ./${ENTRY}`]] };
    expect(findOrphanKnipEntries([ENTRY], corpus(files)).map((orphan) => orphan.entry)).toEqual([
      ENTRY,
    ]);
  });

  test('does not match a longer name that merely starts with the entry name', () => {
    const files = { workflows: [['a.yml', 'run: bun ./scripts/ci/select-thing-snapshot.ts']] };
    expect(findOrphanKnipEntries([ENTRY], corpus(files)).map((orphan) => orphan.entry)).toEqual([
      ENTRY,
    ]);
  });

  test('does not match a same-named file in another directory', () => {
    const files = { workflows: [['a.yml', 'run: bun ./scripts/release/select-thing.ts']] };
    expect(findOrphanKnipEntries([ENTRY], corpus(files)).map((orphan) => orphan.entry)).toEqual([
      ENTRY,
    ]);
  });

  test('keeps a sibling import from counting for a file in another directory', () => {
    const files = { scripts: [['scripts/lib/runner.ts', "import { x } from './select-thing';"]] };
    expect(findOrphanKnipEntries([ENTRY], corpus(files)).map((orphan) => orphan.entry)).toEqual([
      ENTRY,
    ]);
  });
});

describe('describeOrphanKnipEntry', () => {
  test('names the entry, the expected callers and what was searched', () => {
    expect(
      describeOrphanKnipEntry({ entry: ENTRY, searched: ['workflows (2 files)', 'docs (1 files)'] })
    ).toBe(
      `knip entry ${ENTRY}: expected a reference from a workflow, composite action, package.json ` +
        'script, doc or other script | searched: workflows (2 files), docs (1 files) | received: ' +
        'none; remove the file and its knip.json entry, or name its caller'
    );
  });
});

describe('readReferenceCorpus', () => {
  test('reads each caller group from this checkout and leaves tests out of the script group', () => {
    const groups = readReferenceCorpus(ROOT_DIR);
    expect(groups.map((group) => group.label)).toEqual([
      'workflows',
      'composite actions',
      'package.json files',
      'docs',
      'non-test scripts',
    ]);
    for (const group of groups) {
      expect(group.files.length, `${group.label} files found`).toBeGreaterThan(0);
    }
    const scripts = groups.find((group) => group.label === 'non-test scripts');
    expect(scripts?.files.some((file) => file.path === 'scripts/ci/evaluate-gate.ts')).toBe(true);
    expect(scripts?.files.some((file) => file.path.startsWith('scripts/tests/'))).toBe(false);
    expect(scripts?.files.some((file) => file.path.endsWith('.test.ts'))).toBe(false);
  });
});

describe('knip.json explicit entries', () => {
  test('every explicit entry under scripts/ci and scripts/release has a caller', async () => {
    const config = (await Bun.file(join(ROOT_DIR, 'knip.json')).json()) as {
      workspaces: Record<string, { entry?: string[] }>;
    };
    const entries = explicitKnipEntries(config.workspaces['.']?.entry ?? []);
    // Guards the guard: an empty list would pass without checking anything.
    expect(
      entries.length,
      `explicit entries under ${CHECKED_ENTRY_DIRECTORIES.join(', ')}`
    ).toBeGreaterThan(10);

    const orphans = findOrphanKnipEntries(entries, readReferenceCorpus(ROOT_DIR));
    expect(orphans.map(describeOrphanKnipEntry)).toEqual([]);
  });
});
