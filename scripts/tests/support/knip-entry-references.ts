// Finds knip entries that nothing in the repository runs. Knip treats an explicit `entry` as a
// live root, so it never reports one as unused: a CLI whose only workflow caller was removed
// stays in `knip.json` and keeps every export it imports alive. This module names those entries.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** One searchable file: its repository-relative path and its text. */
interface ReferenceFile {
  readonly path: string;
  readonly text: string;
}

/** A group of files one kind of caller lives in, searched together. */
export interface ReferenceCorpusGroup {
  /** Names the group in a failure message, e.g. `workflows`. */
  readonly label: string;
  readonly files: readonly ReferenceFile[];
}

/** An explicit knip entry nothing references, with what was searched for it. */
export interface OrphanKnipEntry {
  readonly entry: string;
  readonly searched: readonly string[];
}

/** Directories whose explicit knip entries must have a caller. */
export const CHECKED_ENTRY_DIRECTORIES = ['scripts/ci', 'scripts/release'] as const;

/**
 * Expands the `{a,b}` alternatives knip.json uses into one path per alternative.
 * // Usage: expandBraces('scripts/ci/{a,b}.ts') // ['scripts/ci/a.ts', 'scripts/ci/b.ts']
 */
export function expandBraces(pattern: string): string[] {
  const open = pattern.indexOf('{');
  if (open === -1) return [pattern];
  const close = pattern.indexOf('}', open);
  if (close === -1) {
    throw new Error(`knip entry "${pattern}": expected a closing "}" | received: none`);
  }
  const head = pattern.slice(0, open);
  const tail = pattern.slice(close + 1);
  return pattern
    .slice(open + 1, close)
    .split(',')
    .flatMap((alternative) => expandBraces(`${head}${alternative}${tail}`));
}

/**
 * The explicit file entries (no glob wildcard) of `knip.json`'s root workspace under `directories`.
 * Wildcard entries are patterns, not a claim that one named file is a root, so they are skipped.
 * // Usage: explicitKnipEntries(['scripts/ci/{a,b}.ts', 'scripts/ci/*.ts'], ['scripts/ci']) // [a, b]
 */
export function explicitKnipEntries(
  entries: readonly string[],
  directories: readonly string[] = CHECKED_ENTRY_DIRECTORIES
): string[] {
  return entries
    .flatMap(expandBraces)
    .filter((entry) => !entry.includes('*') && directories.some((dir) => dirname(entry) === dir));
}

/**
 * The text that names `entry` from `callerPath`: its path from the repository root, the
 * `ci/name` tail workflows and docs use, or a sibling import such as `./name` for a file that
 * lives in the same directory. The extension is optional, so an import specifier matches too.
 * // Usage: referencePatterns('scripts/ci/a.ts', 'scripts/ci/b.ts') // [/scripts\/ci\/a\b/, ...]
 */
function referencePatterns(entry: string, callerPath: string): RegExp[] {
  const directory = dirname(entry);
  const name = entry.slice(directory.length + 1).replace(/\.[^.]+$/, '');
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const tail = `${directory.split('/').at(-1)}/${escapedName}`;
  // `(?![\w-])` stops `select-canary-source` matching inside `select-canary-source-snapshot`.
  const patterns = [new RegExp(`(?<![\\w-])${tail}(?![\\w-])`)];
  if (dirname(callerPath) === directory) {
    patterns.push(new RegExp(`['"]\\./${escapedName}(?:\\.[a-z]+)?['"]`));
  }
  return patterns;
}

/**
 * Explicit knip entries that no file in `groups` names. The entry's own file never counts, and
 * the caller supplies groups without test files: a test that spawns a CLI does not make the CLI
 * something the repository runs.
 * // Usage: findOrphanKnipEntries(['scripts/ci/a.ts'], [{ label: 'workflows', files: [] }])
 */
export function findOrphanKnipEntries(
  entries: readonly string[],
  groups: readonly ReferenceCorpusGroup[]
): OrphanKnipEntry[] {
  const searched = groups.map((group) => `${group.label} (${group.files.length} files)`);
  return entries
    .filter(
      (entry) =>
        !groups.some((group) =>
          group.files.some(
            (file) =>
              file.path !== entry &&
              referencePatterns(entry, file.path).some((pattern) => pattern.test(file.text))
          )
        )
    )
    .map((entry) => ({ entry, searched }));
}

/**
 * The failure text for one orphan: the entry, the shape expected and what was searched.
 * // Usage: describeOrphanKnipEntry({ entry: 'scripts/ci/a.ts', searched: ['workflows (3 files)'] })
 */
export function describeOrphanKnipEntry(orphan: OrphanKnipEntry): string {
  return (
    `knip entry ${orphan.entry}: expected a reference from a workflow, composite action, ` +
    `package.json script, doc or other script | searched: ${orphan.searched.join(', ')} | ` +
    `received: none; remove the file and its knip.json entry, or name its caller`
  );
}

/**
 * Reads the caller groups for a repository checkout: workflows and composite actions, package
 * manifests, docs, and non-test script sources.
 * // Usage: readReferenceCorpus('/path/to/repo')
 */
export function readReferenceCorpus(root: string): ReferenceCorpusGroup[] {
  const read = (patterns: readonly string[], exclude: readonly RegExp[] = []): ReferenceFile[] =>
    patterns
      .flatMap((pattern) => [...new Bun.Glob(pattern).scanSync({ cwd: root, onlyFiles: true })])
      // Bun.Glob reports backslash separators on Windows; every pattern below assumes `/`.
      .map((path) => path.replaceAll('\\', '/'))
      .filter((path) => !path.includes('node_modules/') && !exclude.some((re) => re.test(path)))
      .sort()
      .map((path) => ({ path, text: readFileSync(join(root, path), 'utf8') }));
  const notTests = [/^scripts\/tests\//, /\.test\.[cm]?[jt]s$/];
  return [
    { label: 'workflows', files: read(['.github/workflows/*.{yml,yaml}']) },
    { label: 'composite actions', files: read(['.github/actions/**/*.{yml,yaml}']) },
    {
      label: 'package.json files',
      files: read(['package.json', '{apps,packages}/*/package.json']),
    },
    { label: 'docs', files: read(['*.md', 'docs/**/*.md', 'scripts/README.md']) },
    {
      label: 'non-test scripts',
      files: read(['scripts/**/*.{ts,mjs,sh,ps1}'], notTests),
    },
  ];
}
