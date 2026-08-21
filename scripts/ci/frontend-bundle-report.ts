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
// This is not the QA gate's bundle collector (`scripts/qa-gate/collect/bundle.ts`),
// which reports aggregate js/css/html gzip totals into the QA report on every CI
// run. This one is a migration instrument: run by hand, diffed against a captured
// baseline, and reported in a PR body.
//
// Asset filenames carry content hashes, so every file looks new on every build.
// Rows are therefore keyed by the hash-stripped name (`assets/index-Bqugzlgv.js`
// → `assets/index.js`), which is what makes a diff readable at all.
//
// Usage: bun ./scripts/ci/frontend-bundle-report.ts [--dist <dir>] [--baseline <file>] [--json] [--out <file>]

import { readdir } from 'node:fs/promises';
import { join, sep } from 'node:path';

import { ROOT_DIR } from '../lib/config';

const DEFAULT_DIST_DIR = join(ROOT_DIR, 'apps/frontend/dist');

/** Report format version, so a stale baseline fails loudly instead of diffing as churn. */
export const BUNDLE_REPORT_VERSION = 1;

export interface BundleFile {
  /** Path relative to the dist root, always '/'-separated. */
  readonly path: string;
  /** `path` with the content hash removed, so it survives a rebuild. */
  readonly key: string;
  readonly rawBytes: number;
  readonly gzipBytes: number;
}

export interface BundleTotals {
  readonly files: number;
  readonly rawBytes: number;
  readonly gzipBytes: number;
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

/** Measures every file under `distDir`, largest gzipped first. */
export async function measureBundle(
  distDir: string,
  meta: { builder: string; capturedAt: string }
): Promise<BundleReport> {
  const paths = await listFiles(distDir);
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
    });
  }
  files.sort((a, b) => b.gzipBytes - a.gzipBytes || a.path.localeCompare(b.path));

  return {
    version: BUNDLE_REPORT_VERSION,
    builder: meta.builder,
    capturedAt: meta.capturedAt,
    totals: {
      files: files.length,
      rawBytes: files.reduce((total, file) => total + file.rawBytes, 0),
      gzipBytes: files.reduce((total, file) => total + file.gzipBytes, 0),
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

/** Sums a report's files by hash-stripped key; two chunks can collapse onto one key. */
export function totalsByKey(report: BundleReport): Map<string, BundleTotals> {
  const byKey = new Map<string, BundleTotals>();
  for (const file of report.files) {
    const running = byKey.get(file.key) ?? { files: 0, rawBytes: 0, gzipBytes: 0 };
    byKey.set(file.key, {
      files: running.files + 1,
      rawBytes: running.rawBytes + file.rawBytes,
      gzipBytes: running.gzipBytes + file.gzipBytes,
    });
  }
  return byKey;
}

/**
 * Renders the markdown table. Pure, so the shape is testable without a build:
 * everything above it reads the filesystem, everything below writes a stream.
 */
export function renderBundleReport(report: BundleReport, baseline?: BundleReport): string {
  const current = totalsByKey(report);
  const previous = baseline ? totalsByKey(baseline) : undefined;
  const lines = [`### Frontend bundle (${report.builder})`, ''];

  if (baseline) {
    lines.push(`Compared against \`${baseline.builder}\` captured ${baseline.capturedAt}.`, '');
    lines.push('| Chunk | Raw | Gzip | Δ gzip |', '| --- | ---: | ---: | ---: |');
  } else {
    lines.push('| Chunk | Raw | Gzip |', '| --- | ---: | ---: |');
  }

  for (const [key, totals] of [...current].sort(([, a], [, b]) => b.gzipBytes - a.gzipBytes)) {
    const cells = [key, formatBytes(totals.rawBytes), formatBytes(totals.gzipBytes)];
    if (previous) cells.push(formatDelta(totals.gzipBytes, previous.get(key)?.gzipBytes));
    lines.push(`| ${cells.join(' | ')} |`);
  }

  const totalCells = [
    `**Total (${report.totals.files} files)**`,
    `**${formatBytes(report.totals.rawBytes)}**`,
    `**${formatBytes(report.totals.gzipBytes)}**`,
  ];
  if (baseline) {
    totalCells.push(`**${formatDelta(report.totals.gzipBytes, baseline.totals.gzipBytes)}**`);
  }
  lines.push(`| ${totalCells.join(' | ')} |`, '');

  if (previous) {
    const dropped = [...previous.keys()].filter((key) => !current.has(key));
    if (dropped.length > 0) {
      lines.push(`Gone from the baseline: ${dropped.map((key) => `\`${key}\``).join(', ')}`, '');
    }
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
}
