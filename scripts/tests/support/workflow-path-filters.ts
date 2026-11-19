import { existsSync, readFileSync, statSync } from 'node:fs';
import { posix } from 'node:path';

import { ROOT_DIR } from '../../lib/config';
import { extractOnBlock } from './workflow-blocks';

// Path-filter coverage for workflow policy tests: which files a workflow's
// `paths:` list triggers on, and which repo files an entry script loads, so a
// test can fail when the script imports a module the filter does not name.

const SCANNER = new Bun.Transpiler({ loader: 'ts' });
const SOURCE_EXTENSIONS = ['.ts', '.mts', '.mjs', '.js'] as const;

/**
 * The `paths:` globs of one trigger (`pull_request`, `push`), in declaration
 * order. Returns [] when the trigger has no `paths:` list. Reads a block-style
 * list only (`      - glob`), which is what the formatter writes for these files.
 */
export function workflowPathFilters(workflow: string, event: string): string[] {
  const trigger = new RegExp(`^ {2}${event}:\\n([\\s\\S]*?)(?=^ {2}\\S|(?![\\s\\S]))`, 'm').exec(
    extractOnBlock(workflow)
  )?.[1];
  const list = /^ {4}paths:\n((?: {6}(?:- |#).*(?:\n|$))+)/m.exec(trigger ?? '')?.[1] ?? '';
  return [...list.matchAll(/^ {6}- (.*?)\s*$/gm)].map((match) =>
    match[1].replace(/^(["'])(.*)\1$/, '$2')
  );
}

/**
 * Whether GitHub would treat `path` as matching `patterns`. Later patterns
 * override earlier ones and a leading `!` excludes, as in a `paths:` list.
 * `*` stays inside a path segment and `**` crosses them, which is what
 * Bun.Glob does too.
 */
export function pathFilterMatches(patterns: readonly string[], path: string): boolean {
  let matched = false;
  for (const pattern of patterns) {
    const exclude = pattern.startsWith('!');
    if (new Bun.Glob(exclude ? pattern.slice(1) : pattern).match(path)) matched = !exclude;
  }
  return matched;
}

function scanImportsOf(file: string, source: string) {
  try {
    return SCANNER.scanImports(source);
  } catch (error) {
    const detail = error instanceof AggregateError ? error.errors.join('; ') : String(error);
    throw new Error(`(${file}): imports could not be scanned | ${detail}`);
  }
}

function resolveRelativeImport(
  rootDir: string,
  importer: string,
  specifier: string
): string | undefined {
  const base = posix.join(posix.dirname(importer), specifier);
  // The specifier as written wins, which is how `./frames.json` resolves.
  const candidates = [
    base,
    ...SOURCE_EXTENSIONS.map((extension) => `${base}${extension}`),
    ...SOURCE_EXTENSIONS.map((extension) => posix.join(base, `index${extension}`)),
  ];
  return candidates.find((candidate) => {
    const absolute = posix.join(rootDir, candidate);
    return existsSync(absolute) && statSync(absolute).isFile();
  });
}

/**
 * The repo-relative files `entries` load: themselves plus every relative
 * import of any of them, transitively. Imports are read with
 * `Bun.Transpiler.scanImports`, so static, dynamic and re-export forms count
 * and an import inside a comment or string does not. Bare and `node:`
 * specifiers are skipped. A relative import that resolves to no file throws,
 * naming the importer.
 *
 * @example
 * relativeImportClosure(['scripts/ci/x.ts']); // => ['scripts/ci/x.ts', 'scripts/lib/y.ts']
 */
export function relativeImportClosure(
  entries: readonly string[],
  rootDir: string = ROOT_DIR.replaceAll('\\', '/')
): string[] {
  const seen = new Set<string>();
  const pending = [...entries];
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    if (seen.has(file)) continue;
    seen.add(file);
    // A data file (JSON, text) is a leaf: it is loaded but imports nothing.
    if (!SOURCE_EXTENSIONS.some((extension) => file.endsWith(extension))) continue;
    // scanImports rejects a hashbang line that executable scripts carry.
    const source = readFileSync(posix.join(rootDir, file), 'utf8').replace(/^#!.*/, '');
    for (const { path: specifier } of scanImportsOf(file, source)) {
      if (!specifier.startsWith('./') && !specifier.startsWith('../')) continue;
      const resolved = resolveRelativeImport(rootDir, file, specifier);
      if (resolved === undefined) {
        throw new Error(
          `(${file}): relative import '${specifier}' resolves to no file | expected: a .ts, .mts, .mjs or .js module`
        );
      }
      pending.push(resolved);
    }
  }
  return [...seen].sort();
}

/**
 * Files under `scripts/` that `entries` load and `patterns` do not name.
 * Empty means every module the entries run is covered by the filter.
 */
export function uncoveredScriptImports(
  entries: readonly string[],
  patterns: readonly string[],
  rootDir?: string
): string[] {
  return relativeImportClosure(entries, rootDir).filter(
    (file) => file.startsWith('scripts/') && !pathFilterMatches(patterns, file)
  );
}
