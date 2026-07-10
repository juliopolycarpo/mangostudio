// Shared LCOV line-hit parsing and source-file resolution for the
// source-derived coverage readers. Resolution failures are loud: a coverage
// file whose SF records point at missing sources is a broken collector, not
// an empty workspace, and must fail instead of silently reporting 0/0.

import { isAbsolute, relative, resolve } from 'node:path';
import * as ts from '@typescript/typescript6';

export interface LcovFileCoverage {
  readonly sourcePath: string;
  readonly lineHits: ReadonlyMap<number, number>;
}

export interface LcovParseResult {
  readonly files: readonly LcovFileCoverage[];
  /** Count of well-formed `SF:` records seen while parsing. */
  readonly recordCount: number;
  /** Trimmed `SF:`/`DA:` lines that could not be parsed. */
  readonly malformedRecords: readonly string[];
}

export interface CoveredSource {
  readonly sourceFile: ts.SourceFile;
  readonly lineHits: ReadonlyMap<number, number>;
}

const MAX_REPORTED_PATHS = 5;

export const parseLcovLineHits = (lcovText: string, baseDir: string): LcovParseResult => {
  const files: LcovFileCoverage[] = [];
  const malformedRecords: string[] = [];
  let recordCount = 0;
  let sourcePath: string | null = null;
  let lineHits = new Map<number, number>();

  const push = (): void => {
    if (sourcePath) files.push({ sourcePath, lineHits });
    sourcePath = null;
    lineHits = new Map<number, number>();
  };

  for (const rawLine of lcovText.split('\n')) {
    const line = rawLine.trim();
    if (line.startsWith('SF:')) {
      const recordPath = line.slice(3);
      if (recordPath.length === 0) {
        malformedRecords.push(line);
        continue;
      }
      recordCount++;
      sourcePath = isAbsolute(recordPath) ? recordPath : resolve(baseDir, recordPath);
    } else if (line.startsWith('DA:')) {
      const [lineNumber, hits] = line.slice(3).split(',').map(Number);
      if (!Number.isFinite(lineNumber) || !Number.isFinite(hits)) {
        malformedRecords.push(line);
        continue;
      }
      lineHits.set(lineNumber, hits);
    } else if (line === 'end_of_record') push();
  }
  push();
  return { files, recordCount, malformedRecords };
};

const describePaths = (paths: readonly string[], baseDir: string): string => {
  const shown = paths.slice(0, MAX_REPORTED_PATHS).map((path) => relative(baseDir, path));
  const overflow = paths.length - shown.length;
  return overflow > 0 ? `${shown.join(', ')} (+${overflow} more)` : shown.join(', ');
};

/**
 * Parse an LCOV file and load every referenced source as a TypeScript AST.
 * Relative `SF:` records resolve against `baseDir` (the workspace root);
 * absolute records are used as-is. Throws when any referenced source is
 * missing or when the file has records but none resolved.
 */
export const readCoveredSources = async (
  lcovPath: string,
  baseDir: string
): Promise<readonly CoveredSource[]> => {
  const lcovText = await Bun.file(lcovPath).text();
  const { files, recordCount, malformedRecords } = parseLcovLineHits(lcovText, baseDir);

  // Load every referenced source concurrently; a workspace LCOV can list
  // hundreds of files, and reading them one await at a time serializes the I/O.
  const loaded = await Promise.all(
    files.map(async ({ sourcePath, lineHits }) => {
      const file = Bun.file(sourcePath);
      if (!(await file.exists())) return { sourcePath, source: null } as const;
      const sourceText = await file.text();
      const sourceFile = ts.createSourceFile(sourcePath, sourceText, ts.ScriptTarget.Latest, true);
      return { sourcePath, source: { sourceFile, lineHits } } as const;
    })
  );
  const missing = loaded.filter((entry) => !entry.source).map((entry) => entry.sourcePath);
  const sources = loaded.flatMap((entry) => (entry.source ? [entry.source] : []));

  if (missing.length > 0) {
    throw new Error(
      `${lcovPath} references ${missing.length} source file(s) missing under ${baseDir}: ` +
        describePaths(missing, baseDir)
    );
  }
  if (sources.length === 0 && (recordCount > 0 || malformedRecords.length > 0)) {
    throw new Error(
      `${lcovPath} contains ${recordCount} source record(s)` +
        `${malformedRecords.length > 0 ? ` and ${malformedRecords.length} malformed record(s)` : ''}` +
        ' but none resolved to a source file.'
    );
  }
  return sources;
};
