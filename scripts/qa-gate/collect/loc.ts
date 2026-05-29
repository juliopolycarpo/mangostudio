// Lines-of-code measurement: counts tracked .ts/.tsx source, classifying each
// line as code, comment, or blank.

import { join } from 'node:path';
import { ROOT_DIR } from '../../lib/config';
import { runCapture, stderrLog } from './support';
import type { LocBucket } from './types';

const SOURCE_EXT_RE = /\.(ts|tsx)$/;
const EXCLUDED_PATH_FRAGMENTS = ['/dist/', '/coverage/', '/.tanstack/', '/node_modules/'];
const EXCLUDED_FILENAMES = new Set(['routeTree.gen.ts']);

const isSourceFile = (relPath: string): boolean => {
  if (!SOURCE_EXT_RE.test(relPath)) return false;
  if (EXCLUDED_PATH_FRAGMENTS.some((fragment) => relPath.includes(fragment))) return false;
  const fileName = relPath.split('/').pop() ?? '';
  if (EXCLUDED_FILENAMES.has(fileName)) return false;
  return true;
};

interface LineCounts {
  readonly code: number;
  readonly comment: number;
  readonly blank: number;
}

const countLines = async (relPath: string): Promise<LineCounts> => {
  const text = await Bun.file(join(ROOT_DIR, relPath)).text();
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

/** Count LoC for every tracked source file under a workspace directory. */
export const measureLoc = async (workspaceDir: string): Promise<LocBucket> => {
  const { stdout, exitCode, stderr } = await runCapture(['git', 'ls-files', workspaceDir]);
  if (exitCode !== 0) throw new Error(`git ls-files ${workspaceDir} failed: ${stderr.trim()}`);
  const sources = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(isSourceFile);

  let totalCode = 0;
  let totalComment = 0;
  let totalBlank = 0;
  for (const file of sources) {
    try {
      const counts = await countLines(file);
      totalCode += counts.code;
      totalComment += counts.comment;
      totalBlank += counts.blank;
    } catch (err) {
      stderrLog(`Skipped ${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return {
    files: sources.length,
    code: totalCode,
    comment: totalComment,
    blank: totalBlank,
    total: totalCode + totalComment + totalBlank,
  };
};

/** Sum a set of per-workspace LoC buckets into a single total. */
export const sumLocBuckets = (buckets: readonly LocBucket[]): LocBucket =>
  buckets.reduce<LocBucket>(
    (acc, entry) => ({
      files: acc.files + entry.files,
      code: acc.code + entry.code,
      comment: acc.comment + entry.comment,
      blank: acc.blank + entry.blank,
      total: acc.total + entry.total,
    }),
    { files: 0, code: 0, comment: 0, blank: 0, total: 0 }
  );
