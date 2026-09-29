// Static lines-of-code measurement: counts tracked files per component and
// class (production / test / generated / fixture / config / docs), splitting
// each file's lines into code, comment and blank.
//
// A file that cannot be read never lowers a total silently: the component
// becomes `partial`, the counts cover only the files that were read (so
// `files` and the line totals always agree), and each unreadable path is
// recorded as a reason.

import { basename, extname } from 'node:path/posix';

import { LOC_CLASSES, type LocBucket, type LocClass, type LocStats } from '../model/metrics';
import { type Measurement, measured, partial } from '../model/states';
import { stderrLog } from './support';

/** Source languages with `//` and `/* *\/` comments; lines are split three ways. */
const CODE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.rs',
]);
const CONFIG_EXTENSIONS = new Set(['.json', '.jsonc', '.toml', '.yml', '.yaml']);
const DOCS_EXTENSIONS = new Set(['.md', '.mdx', '.mdc']);
/** Data-like files count non-blank lines as code; there is no comment syntax to split on. */
const LINE_ONLY_EXTENSIONS = new Set([...CONFIG_EXTENSIONS, ...DOCS_EXTENSIONS, '.xml', '.txt']);

const GENERATED_SEGMENTS = new Set(['generated', '__generated__', '.tanstack']);
const GENERATED_FILE_RE = /(\.gen\.|\.generated\.)/;
const GENERATED_FILENAMES = new Set(['bun.lock', 'Cargo.lock']);
const FIXTURE_SEGMENTS = new Set(['fixtures', '__fixtures__', 'testdata']);
const TEST_SEGMENTS = new Set(['tests', '__tests__', 'e2e', 'testing']);
const TEST_FILE_RE = /\.(test|spec)\.[^/]+$/;

export interface FileClass {
  readonly class: LocClass;
  /** True when the file's lines split into code/comment/blank. */
  readonly commentAware: boolean;
}

/**
 * Class of a tracked file, or null when it is outside the LoC scope (binary
 * assets, shell scripts, stylesheets: no counting rule exists for them).
 * // Usage: classifyFile('apps/api/tests/unit/a.test.ts')?.class // 'test'
 */
export const classifyFile = (path: string): FileClass | null => {
  const ext = extname(path);
  const name = basename(path);
  const isCode = CODE_EXTENSIONS.has(ext);
  const isLineOnly =
    LINE_ONLY_EXTENSIONS.has(ext) || name.startsWith('Dockerfile') || GENERATED_FILENAMES.has(name);
  if (!isCode && !isLineOnly) return null;

  const segments = path.split('/').slice(0, -1);
  const commentAware = isCode;
  const of = (fileClass: LocClass): FileClass => ({ class: fileClass, commentAware });
  if (GENERATED_FILENAMES.has(name) || GENERATED_FILE_RE.test(name)) return of('generated');
  if (segments.some((segment) => GENERATED_SEGMENTS.has(segment))) return of('generated');
  if (segments.some((segment) => FIXTURE_SEGMENTS.has(segment))) return of('fixture');
  if (TEST_FILE_RE.test(name) || segments.some((segment) => TEST_SEGMENTS.has(segment))) {
    return of('test');
  }
  if (DOCS_EXTENSIONS.has(ext) || ext === '.txt') return of('docs');
  return of(isCode ? 'production' : 'config');
};

interface LineCounts {
  readonly code: number;
  readonly comment: number;
  readonly blank: number;
}

/**
 * Split text into code, comment and blank lines. Comment-aware files treat
 * `//`, block comments and leading `*` as comments; others count every
 * non-blank line as code.
 * // Usage: countLines('// a\nconst x = 1;\n\n', true) // { code: 1, comment: 1, blank: 2 }
 */
export const countLines = (text: string, commentAware: boolean): LineCounts => {
  let code = 0;
  let comment = 0;
  let blank = 0;
  let inBlockComment = false;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line === '') {
      blank++;
      continue;
    }
    if (!commentAware) {
      code++;
      continue;
    }
    if (inBlockComment) {
      comment++;
      if (line.includes('*/')) inBlockComment = false;
      continue;
    }
    if (line.startsWith('/*')) {
      comment++;
      if (!line.includes('*/')) inBlockComment = true;
      continue;
    }
    if (line.startsWith('//') || line.startsWith('*')) {
      comment++;
      continue;
    }
    code++;
  }
  return { code, comment, blank };
};

const emptyBucket = (): LocBucket => ({ files: 0, code: 0, comment: 0, blank: 0, total: 0 });

const addToBucket = (bucket: LocBucket, counts: LineCounts): LocBucket => ({
  files: bucket.files + 1,
  code: bucket.code + counts.code,
  comment: bucket.comment + counts.comment,
  blank: bucket.blank + counts.blank,
  total: bucket.total + counts.code + counts.comment + counts.blank,
});

/** Files listed in a partial reason before the rest is summarised. */
const MAX_LISTED_UNREADABLE = 10;

const unreadableReasons = (unreadable: readonly string[], counted: number): string[] => {
  const listed = unreadable.slice(0, MAX_LISTED_UNREADABLE);
  const summary = `${unreadable.length} of ${counted} counted file(s) unreadable; totals cover only the files that were read`;
  const rest = unreadable.length - listed.length;
  return [summary, ...listed, ...(rest > 0 ? [`… and ${rest} more`] : [])];
};

/**
 * Count one component's tracked files. `readText` is injected so tests can
 * fake unreadable files; production passes a repository-rooted reader.
 * // Usage: await measureComponentLoc(files, (path) => Bun.file(join(ROOT_DIR, path)).text())
 */
export const measureComponentLoc = async (
  files: readonly string[],
  readText: (path: string) => Promise<string>
): Promise<Measurement<LocStats>> => {
  const stats: Record<LocClass, LocBucket> = Object.fromEntries(
    LOC_CLASSES.map((fileClass) => [fileClass, emptyBucket()])
  ) as Record<LocClass, LocBucket>;
  const unreadable: string[] = [];
  let counted = 0;

  for (const path of files) {
    const fileClass = classifyFile(path);
    if (fileClass === null) continue;
    counted++;
    try {
      const counts = countLines(await readText(path), fileClass.commentAware);
      stats[fileClass.class] = addToBucket(stats[fileClass.class], counts);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      unreadable.push(`${path}: ${message}`);
    }
  }

  if (unreadable.length > 0) {
    stderrLog(`${unreadable.length} of ${counted} counted file(s) unreadable: ${unreadable[0]}`);
    return partial(stats, unreadableReasons(unreadable, counted));
  }
  return measured(stats);
};
