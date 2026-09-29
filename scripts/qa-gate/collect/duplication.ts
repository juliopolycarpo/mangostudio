// Code duplication stats via jscpd (reads its JSON report).

import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { ROOT_DIR } from '../../lib/config';
import { runCapture } from './support';
import type { DuplicationStats } from './types';

const JSCPD_OUTPUT_DIR = '.mango/artifacts/qa-gate/jscpd';
const MAX_STDERR_SHOWN = 300;
const TOTAL_FIELDS = ['clones', 'duplicatedLines', 'percentage'] as const;

interface RunResult {
  readonly stderr: string;
  readonly exitCode: number;
}

export interface DuplicationDeps {
  /** Runs jscpd; the report is read from `reportPath` afterwards. */
  readonly run: (cmd: readonly string[]) => Promise<RunResult>;
  /** Removes a stale report so an old run's numbers can never be read. */
  readonly removeReport: (path: string) => Promise<void>;
  /** Reads the report text, or rejects when it is missing. */
  readonly readReport: (path: string) => Promise<string>;
}

const defaultDeps: DuplicationDeps = {
  run: runCapture,
  removeReport: (path) => rm(path, { force: true }),
  readReport: (path) => Bun.file(path).text(),
};

/**
 * Parse jscpd's `statistics.total`. Every field must be a finite number: a
 * missing one is missing data, never a measured zero.
 */
const parseTotal = (text: string, exitCode: number, stderr: string): DuplicationStats => {
  const context = `jscpd exit ${exitCode}${stderr.trim() ? `: ${stderr.trim().slice(0, MAX_STDERR_SHOWN)}` : ''}`;
  let report: { statistics?: { total?: Record<string, unknown> } };
  try {
    report = JSON.parse(text);
  } catch {
    throw new Error(`jscpd report is not valid JSON (${context})`);
  }
  const total = report.statistics?.total;
  const missing = TOTAL_FIELDS.filter((field) => !Number.isFinite(total?.[field]));
  if (missing.length > 0) {
    throw new Error(
      `jscpd report statistics.total is missing ${missing.join(', ')} (${context}); expected finite numbers for ${TOTAL_FIELDS.join(', ')}`
    );
  }
  return {
    clones: Number(total?.clones),
    duplicatedLines: Number(total?.duplicatedLines),
    percentage: Number(total?.percentage),
  };
};

/**
 * Run jscpd over apps/ and return clone/duplicated-line totals. A crashed run,
 * a missing report or missing totals throw, so the metric reads `unavailable`.
 * // Usage: await collectDuplication()
 */
export const collectDuplication = async (
  deps: DuplicationDeps = defaultDeps
): Promise<DuplicationStats> => {
  const reportPath = join(ROOT_DIR, JSCPD_OUTPUT_DIR, 'jscpd-report.json');
  await deps.removeReport(reportPath);
  const { stderr, exitCode } = await deps.run([
    'bunx',
    'jscpd',
    'apps',
    '--silent',
    '--reporters',
    'json',
    '--output',
    JSCPD_OUTPUT_DIR,
    '--ignore',
    '**/dist/**,**/coverage/**,**/.tanstack/**,**/node_modules/**,**/routeTree.gen.ts',
  ]);
  let text: string;
  try {
    text = await deps.readReport(reportPath);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `jscpd produced no report at ${reportPath} (exit ${exitCode}): ${stderr.trim().slice(0, MAX_STDERR_SHOWN) || reason}`
    );
  }
  return parseTotal(text, exitCode, stderr);
};
