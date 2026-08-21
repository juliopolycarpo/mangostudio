#!/usr/bin/env bun
// Per-file size inventory of `apps/frontend/dist`, with an optional diff against
// a saved baseline.
//
// The Bun bundler migration replaces Vite's `manualChunks` with Bun's automatic
// splitting, so the chunk *graph* changes even when nothing about the app does.
// Aggregate bytes alone cannot tell "we shipped more code" apart from "the same
// code landed in different chunks", which is the only question worth asking
// during the migration — hence a per-file table plus a baseline to compare it to.
//
// The table also splits the bundle into **eager** and **lazy** payloads. Eager
// is what a first paint downloads: `index.html`, the stylesheets and scripts it
// references, and the static-import closure of those scripts. A regression that
// moves bytes from lazy chunks into that set is a first-paint regression even
// when the total is flat, which is exactly what a totals-only diff hides.
//
// This is not the QA gate's bundle collector (`scripts/qa-gate/collect/bundle.ts`),
// which reports aggregate js/css/html gzip totals into the QA report on every CI
// run. This one is a migration instrument: run by hand, diffed against a captured
// baseline, and reported in a PR body.
//
// Usage: bun ./scripts/ci/frontend-bundle-report.ts [--dist <dir>] [--baseline <file>] [--metafile <file>] [--json] [--out <file>]

import { readdir } from 'node:fs/promises';
import { dirname, join, posix, sep } from 'node:path';

import { ROOT_DIR } from '../lib/config';

const DEFAULT_DIST_DIR = join(ROOT_DIR, 'apps/frontend/dist');

/**
 * Report format version, so a stale baseline fails loudly instead of diffing as
 * churn. Version 2 added the per-file `eager` flag and the eager totals.
 */
export const BUNDLE_REPORT_VERSION = 2;

export interface BundleFile {
  /** Path relative to the dist root, always '/'-separated. */
  readonly path: string;
  /** `path` with the content hash removed, so it survives a rebuild. */
  readonly key: string;
  readonly rawBytes: number;
  readonly gzipBytes: number;
  /** True when a first paint downloads this file (see the header comment). */
  readonly eager: boolean;
}

export interface BundleTotals {
  readonly files: number;
  readonly rawBytes: number;
  readonly gzipBytes: number;
  readonly eagerRawBytes: number;
  readonly eagerGzipBytes: number;
}

export interface BundleReport {
  readonly version: number;
  /** Which bundler produced the measured `dist/`. Provenance for a committed baseline. */
  readonly builder: string;
  readonly capturedAt: string;
  readonly totals: BundleTotals;
  readonly files: readonly BundleFile[];
}

/**
 * Hash length both bundlers emit, measured 2026-08-20: Vite/rollup writes 8
 * base64url chars (`index-Bqugzlgv.js`, `json-qhed-kSA.js`), Bun writes 8
 * lowercase base36 (`entry-htt6v99t.js`).
 */
const HASH_LENGTH = 8;

/**
 * Strips a trailing content hash from a bundled filename.
 *
 * Both bundlers' hashes can contain a '-' (`php-Th-NmKLT.js`), so a leftmost
 * regex over `-[A-Za-z0-9_-]{8,}` is wrong: it would collapse
 * `markdown-parser-MlRw1Qxl.js` to `markdown.js` and hide a real chunk. Instead
 * take the *rightmost* '-' whose suffix could be a hash.
 *
 * A suffix of exactly `HASH_LENGTH` is taken as a hash with no further test.
 * That over-strips a chunk whose last name segment happens to be 8 characters
 * (`chat-messages.js` → `chat.js`), which is the cheaper mistake: it is
 * deterministic and applies to baseline and current alike, so the row still
 * matches. Requiring a digit or mixed case instead would reject roughly 4% of
 * Bun's all-lowercase base36 hashes at random, and every rejected file reports
 * as both added and removed on a build that changed nothing.
 */
export function stripContentHash(path: string): string {
  const slash = path.lastIndexOf('/');
  const dir = slash === -1 ? '' : path.slice(0, slash + 1);
  const name = path.slice(slash + 1);

  const dot = name.indexOf('.');
  if (dot <= 0) return path;
  const stem = name.slice(0, dot);
  const extension = name.slice(dot);

  for (let cut = stem.lastIndexOf('-'); cut > 0; cut = stem.lastIndexOf('-', cut - 1)) {
    const candidate = stem.slice(cut + 1);
    if (candidate.length < HASH_LENGTH) continue;
    if (!isHashLike(candidate)) break;
    return `${dir}${stem.slice(0, cut)}${extension}`;
  }
  return path;
}

function isHashLike(candidate: string): boolean {
  if (!/^[A-Za-z0-9_-]+$/.test(candidate)) return false;
  if (candidate.length === HASH_LENGTH) return true;
  // Longer than any hash seen, so it needs to look like one: `apple-touch-icon.png`
  // ends in a 10-character segment that is plainly a name.
  return /\d/.test(candidate) || (/[a-z]/.test(candidate) && /[A-Z]/.test(candidate));
}

async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(dir.length).split(sep).filter(Boolean))
    .map((segments) => segments.join('/'))
    .sort();
}

/**
 * Resolves an asset reference from `index.html` or an emitted JS file to a
 * dist-relative path. Bun emits absolute URLs (`/assets/x.js`, from
 * `publicPath: '/'`); Vite emits absolute in HTML and relative (`./x.js`)
 * between chunks.
 */
function resolveAssetRef(ref: string, fromFile: string): string | undefined {
  if (ref.startsWith('/')) return ref.slice(1);
  if (ref.startsWith('./') || ref.startsWith('../')) {
    return posix.normalize(posix.join(posix.dirname(fromFile), ref));
  }
  return undefined;
}

/** `<script src>` and `<link rel="stylesheet" href>` targets of an HTML shell. */
function htmlAssetRefs(html: string): string[] {
  const scripts = [...html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)].map((m) => m[1] ?? '');
  const styles = [...html.matchAll(/<link[^>]*rel="stylesheet"[^>]*\shref="([^"]+)"/g)].map(
    (m) => m[1] ?? ''
  );
  return [...scripts, ...styles].filter((ref) => ref !== '');
}

/**
 * Static import specifiers of an emitted JS chunk. Dynamic `import("…")` is
 * deliberately not matched — the parenthesis breaks the pattern — because a
 * dynamic edge is exactly what makes the target lazy.
 */
function staticImportRefs(source: string): string[] {
  return [...source.matchAll(/(?:import|from)\s*"((?:\.\.?\/|\/)[^"]+\.js)"/g)].map(
    (m) => m[1] ?? ''
  );
}

/**
 * The set of dist files a first paint downloads: `index.html`, every stylesheet
 * and script it references, and the static-import closure of those scripts.
 */
async function traverseEagerSet(distDir: string, paths: readonly string[]): Promise<Set<string>> {
  const known = new Set(paths);
  const eager = new Set<string>();
  const queue: string[] = [];

  const add = (path: string | undefined): void => {
    if (path !== undefined && known.has(path) && !eager.has(path)) {
      eager.add(path);
      queue.push(path);
    }
  };

  if (!known.has('index.html')) return eager;
  add('index.html');
  const html = await Bun.file(join(distDir, 'index.html')).text();
  for (const ref of htmlAssetRefs(html)) add(resolveAssetRef(ref, 'index.html'));

  while (queue.length > 0) {
    const path = queue.shift();
    if (path === undefined || !path.endsWith('.js')) continue;
    const source = await Bun.file(join(distDir, path)).text();
    for (const ref of staticImportRefs(source)) add(resolveAssetRef(ref, path));
  }
  return eager;
}

/** Measures every file under `distDir`, largest gzipped first. */
export async function measureBundle(
  distDir: string,
  meta: { builder: string; capturedAt: string }
): Promise<BundleReport> {
  // Sourcemaps are a diagnostic artifact, not shipped payload; a dist built with
  // them would otherwise report as a size regression.
  const paths = (await listFiles(distDir)).filter((path) => !path.endsWith('.map'));
  const eagerSet = await traverseEagerSet(distDir, paths);

  const files: BundleFile[] = [];
  for (const path of paths) {
    const bytes = new Uint8Array(await Bun.file(join(distDir, path)).arrayBuffer());
    files.push({
      path,
      key: stripContentHash(path),
      rawBytes: bytes.byteLength,
      // Default level, so a per-file number here matches the one the QA gate's
      // collector reports. The totals do not match it: this walks every file in
      // dist/, the collector counts only .js/.css/.html.
      gzipBytes: Bun.gzipSync(bytes).byteLength,
      eager: eagerSet.has(path),
    });
  }
  files.sort((a, b) => b.gzipBytes - a.gzipBytes || a.path.localeCompare(b.path));

  const total = (select: (file: BundleFile) => boolean, of: (file: BundleFile) => number): number =>
    files.filter(select).reduce((sum, file) => sum + of(file), 0);

  return {
    version: BUNDLE_REPORT_VERSION,
    builder: meta.builder,
    capturedAt: meta.capturedAt,
    totals: {
      files: files.length,
      rawBytes: total(
        () => true,
        (file) => file.rawBytes
      ),
      gzipBytes: total(
        () => true,
        (file) => file.gzipBytes
      ),
      eagerRawBytes: total(
        (file) => file.eager,
        (file) => file.rawBytes
      ),
      eagerGzipBytes: total(
        (file) => file.eager,
        (file) => file.gzipBytes
      ),
    },
    files,
  };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / 1024 ** 2).toFixed(2)} MB`;
}

/** Signed delta, or '—' when there is nothing to compare against. */
function formatDelta(current: number, previous: number | undefined): string {
  if (previous === undefined) return 'new';
  const delta = current - previous;
  if (delta === 0) return '—';
  const percent =
    previous === 0 ? '' : ` (${delta > 0 ? '+' : ''}${((delta / previous) * 100).toFixed(1)}%)`;
  return `${delta > 0 ? '+' : '-'}${formatBytes(Math.abs(delta))}${percent}`;
}

/**
 * Stable per-file row labels. Files are keyed by hash-stripped name so a chunk
 * that merely got a new hash still matches its baseline row; when several files
 * share a key (Bun once emitted 17 `chunk-main-*.js`), each gets its own row,
 * disambiguated by gzip-size rank (`assets/chunk-main.js #2`). Rank-matching
 * same-keyed files across builds is approximate, but every file stays visible —
 * a row that silently aggregates hides exactly what a bundle diff exists to
 * catch.
 */
export function labelFiles(files: readonly BundleFile[]): Map<BundleFile, string> {
  const byKey = new Map<string, BundleFile[]>();
  for (const file of files) {
    const group = byKey.get(file.key) ?? [];
    group.push(file);
    byKey.set(file.key, group);
  }

  const labels = new Map<BundleFile, string>();
  for (const [key, group] of byKey) {
    const ranked = [...group].sort(
      (a, b) => b.gzipBytes - a.gzipBytes || a.path.localeCompare(b.path)
    );
    for (const [rank, file] of ranked.entries()) {
      labels.set(file, group.length === 1 ? key : `${key} #${rank + 1}`);
    }
  }
  return labels;
}

/**
 * Renders the markdown table. Pure, so the shape is testable without a build:
 * everything above it reads the filesystem, everything below writes a stream.
 */
export function renderBundleReport(report: BundleReport, baseline?: BundleReport): string {
  const labels = labelFiles(report.files);
  const previous = baseline
    ? new Map([...labelFiles(baseline.files)].map(([file, label]) => [label, file]))
    : undefined;
  const lines = [`### Frontend bundle (${report.builder})`, ''];

  if (baseline) {
    lines.push(`Compared against \`${baseline.builder}\` captured ${baseline.capturedAt}.`, '');
    lines.push('| Chunk | Load | Raw | Gzip | Δ gzip |', '| --- | --- | ---: | ---: | ---: |');
  } else {
    lines.push('| Chunk | Load | Raw | Gzip |', '| --- | --- | ---: | ---: |');
  }

  for (const file of report.files) {
    const label = labels.get(file) ?? file.key;
    const cells = [
      label,
      file.eager ? 'eager' : 'lazy',
      formatBytes(file.rawBytes),
      formatBytes(file.gzipBytes),
    ];
    if (previous) cells.push(formatDelta(file.gzipBytes, previous.get(label)?.gzipBytes));
    lines.push(`| ${cells.join(' | ')} |`);
  }

  const totalRow = (name: string, raw: number, gzip: number, previousGzip?: number): string => {
    const cells = [`**${name}**`, '', `**${formatBytes(raw)}**`, `**${formatBytes(gzip)}**`];
    if (baseline) {
      cells.push(previousGzip === undefined ? '' : `**${formatDelta(gzip, previousGzip)}**`);
    }
    return `| ${cells.join(' | ')} |`;
  };
  lines.push(
    totalRow(
      'Eager (first paint)',
      report.totals.eagerRawBytes,
      report.totals.eagerGzipBytes,
      baseline?.totals.eagerGzipBytes
    ),
    totalRow(
      `Total (${report.totals.files} files)`,
      report.totals.rawBytes,
      report.totals.gzipBytes,
      baseline?.totals.gzipBytes
    ),
    ''
  );

  if (previous) {
    const current = new Set(labels.values());
    const dropped = [...previous.keys()].filter((label) => !current.has(label));
    if (dropped.length > 0) {
      lines.push(
        `Gone from the baseline: ${dropped.map((label) => `\`${label}\``).join(', ')}`,
        ''
      );
    }
  }

  return lines.join('\n');
}

/**
 * Modules that landed in more than one output chunk, from a `Bun.build()`
 * metafile. Gzip cannot dedupe across file boundaries, so a duplicated module
 * costs its bytes once per chunk — and nothing else in this report can see it:
 * the size table only knows files, not what is inside them.
 */
export function findDuplicatedModules(metafile: {
  outputs: Record<string, { inputs: Record<string, unknown> }>;
}): Map<string, string[]> {
  const moduleChunks = new Map<string, string[]>();
  for (const [outputPath, output] of Object.entries(metafile.outputs)) {
    if (!outputPath.endsWith('.js')) continue;
    for (const inputPath of Object.keys(output.inputs)) {
      const chunks = moduleChunks.get(inputPath) ?? [];
      chunks.push(outputPath);
      moduleChunks.set(inputPath, chunks);
    }
  }
  return new Map([...moduleChunks].filter(([, chunks]) => chunks.length > 1));
}

export function renderDuplicatedModules(duplicated: Map<string, string[]>): string {
  if (duplicated.size === 0) return 'No module is present in more than one chunk.';
  const lines = [`**${duplicated.size} module(s) present in more than one chunk:**`, ''];
  for (const [module, chunks] of duplicated) {
    lines.push(`- \`${module}\` × ${chunks.length}: ${chunks.map((c) => `\`${c}\``).join(', ')}`);
  }
  return lines.join('\n');
}

/** Reads a saved report, rejecting a version this build cannot compare against. */
export function parseBundleReport(source: string, path: string): BundleReport {
  const parsed = JSON.parse(source) as BundleReport;
  if (parsed.version !== BUNDLE_REPORT_VERSION) {
    throw new Error(
      `${path} is report version ${parsed.version}; this script writes ${BUNDLE_REPORT_VERSION}. Regenerate it.`
    );
  }
  return parsed;
}

function flagValue(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} needs a value`);
  return value;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const distDir = flagValue(argv, '--dist') ?? DEFAULT_DIST_DIR;
  const baselinePath = flagValue(argv, '--baseline');
  const outPath = flagValue(argv, '--out');

  // The JSON report describes one build; the diff lives only in the table. Rather
  // than emit JSON that silently ignored a baseline the caller asked for, say so.
  if (baselinePath && argv.includes('--json')) {
    throw new Error('--json reports a single build; drop --baseline or drop --json.');
  }

  const report = await measureBundle(distDir, {
    builder: flagValue(argv, '--builder') ?? 'bun',
    capturedAt: new Date().toISOString().slice(0, 10),
  });

  const baseline = baselinePath
    ? parseBundleReport(await Bun.file(baselinePath).text(), baselinePath)
    : undefined;

  if (outPath) {
    await Bun.write(outPath, `${JSON.stringify(report, null, 2)}\n`);
    process.stderr.write(`Wrote ${report.totals.files} files to ${outPath}\n`);
  }

  if (argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(renderBundleReport(report, baseline));
  }

  // The build script drops a metafile next to dist; a Vite dist has none, so the
  // check reports itself as skipped rather than silently passing.
  const metafilePath =
    flagValue(argv, '--metafile') ?? join(dirname(distDir), 'dist-metafile.json');
  const metafileFile = Bun.file(metafilePath);
  if (!argv.includes('--json')) {
    if (await metafileFile.exists()) {
      const metafile = (await metafileFile.json()) as Parameters<typeof findDuplicatedModules>[0];
      process.stdout.write(`\n${renderDuplicatedModules(findDuplicatedModules(metafile))}\n`);
    } else {
      process.stdout.write(`\nDuplicate-module check skipped: no metafile at ${metafilePath}.\n`);
    }
  }
}
