// Test results comparison table for the single authoritative suite pass,
// broken down by workspace.

import type { Metrics, TestSuiteStats } from '../collect/types';
import { getTestSuite } from './access';
import { formatNumber, NA, renderDelta } from './format';

const formatDuration = (suite: TestSuiteStats): string =>
  suite.durationSeconds == null ? 'duration n/a' : `${formatNumber(suite.durationSeconds)}s`;

const formatSuiteBreakdown = (suite: TestSuiteStats | null): string => {
  if (!suite) return NA;
  const parts = [
    `root ${formatNumber(suite.root)}`,
    `frontend ${formatNumber(suite.frontend)}`,
    `api ${formatNumber(suite.api)}`,
    `shared ${formatNumber(suite.shared)}`,
    `runtime ${formatNumber(suite.runtime)}`,
  ];
  const status = suite.exitCode == null ? 'status n/a' : `exit ${suite.exitCode}`;
  const extras: string[] = [];
  if (suite.parseMiss) extras.push('failure counts not parsed');
  if (suite.failed) extras.push(`${formatNumber(suite.failed)} failed`);
  if (suite.failedFiles) extras.push(`${formatNumber(suite.failedFiles)} failed files`);
  if (suite.errors) extras.push(`${formatNumber(suite.errors)} unhandled errors`);
  const extra = extras.length > 0 ? ` · ${extras.join(' · ')}` : '';
  return `${formatNumber(suite.passed)} passed (${parts.join(' / ')}) · ${status} · ${formatDuration(suite)}${extra}`;
};

export const renderTestsSection = (base: Metrics | null, head: Metrics | null): string => {
  const baseSuite = getTestSuite(base);
  const headSuite = getTestSuite(head);
  return [
    '### Tests',
    '',
    'Single full-suite pass (unit + integration, from the coverage run).',
    '',
    '| Base | Head | Δ passed |',
    '|---|---|---|',
    `| ${formatSuiteBreakdown(baseSuite)} | ${formatSuiteBreakdown(headSuite)} | ${renderDelta(baseSuite?.passed, headSuite?.passed, { higherIsBetter: true, precision: 0 })} |`,
    '',
  ].join('\n');
};
