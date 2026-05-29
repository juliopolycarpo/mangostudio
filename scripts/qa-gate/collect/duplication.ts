// Code duplication stats via jscpd (reads its JSON report).

import { join } from 'node:path';
import { ROOT_DIR } from '../../lib/config';
import { runCapture } from './support';
import type { DuplicationStats } from './types';

const JSCPD_OUTPUT_DIR = '.jscpd-out';

/** Run jscpd over apps/ and return clone/duplicated-line totals. */
export const collectDuplication = async (): Promise<DuplicationStats> => {
  await runCapture([
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
  const reportPath = join(ROOT_DIR, JSCPD_OUTPUT_DIR, 'jscpd-report.json');
  const text = await Bun.file(reportPath).text();
  const report = JSON.parse(text) as {
    statistics?: { total?: { clones?: number; duplicatedLines?: number; percentage?: number } };
  };
  const total = report.statistics?.total ?? {};
  return {
    clones: Number(total.clones ?? 0),
    duplicatedLines: Number(total.duplicatedLines ?? 0),
    percentage: Number(total.percentage ?? 0),
  };
};
