// Visible failure lead for the PR QA report and the Test job step summary.
// Green runs return an empty string so existing coverage-first output is unchanged.

import type { Failable, TestSuiteStats } from '../collect/types';
import { formatNumber, inlineCode, isError } from './format';

export const TESTING_DOC_UNHANDLED_ERRORS_URL =
  'https://github.com/juliopolycarpo/mangostudio/blob/main/docs/reference/testing.md#unhandled-errors-with-green-test-counts';

const ORIGINATED_IN_NOTE =
  'The originated-in file names where the run was, not where a leaking timer was scheduled.';

const suiteFailed = (stats: TestSuiteStats): boolean =>
  stats.exitCode !== 0 && stats.exitCode !== null;

const failureBits = (stats: TestSuiteStats): string[] => {
  const bits: string[] = [];
  if (stats.errors) {
    bits.push(`${formatNumber(stats.errors)} unhandled error${stats.errors === 1 ? '' : 's'}`);
  }
  if (stats.failed) {
    bits.push(`${formatNumber(stats.failed)} failed test${stats.failed === 1 ? '' : 's'}`);
  }
  if (stats.failedFiles) {
    bits.push(
      `${formatNumber(stats.failedFiles)} failed file${stats.failedFiles === 1 ? '' : 's'}`
    );
  }
  return bits;
};

const renderHeadline = (
  stats: TestSuiteStats,
  message: string,
  originatedIn: string | null
): string => {
  const code = inlineCode(message);
  if (!originatedIn) return `- ${code}`;
  const originNote =
    stats.errors && !stats.failed
      ? 'where the run was, not where the timer came from'
      : 'where the run was';
  return `- ${code}. Originated in ${inlineCode(originatedIn)} (${originNote}).`;
};

/**
 * Markdown block that leads a failed run's QA report / step summary.
 * Returns '' when the suite passed, stats are missing, or they are a collector error.
 */
export const renderTestFailureLead = (
  tests: Failable<TestSuiteStats> | null | undefined
): string => {
  if (!tests || isError(tests) || !suiteFailed(tests)) return '';

  const lines = ['## Test failures', ''];

  if (tests.parseMiss) {
    lines.push('Run failed; no failure counts could be parsed from the log.', '');
    return `${lines.join('\n')}`;
  }

  const bits = failureBits(tests);
  const what = bits.length > 0 ? ` with ${bits.join(' and ')}` : '';
  lines.push(
    `Run exited ${formatNumber(tests.exitCode ?? 1)}${what}. File and test counts can stay green.`
  );
  lines.push('');

  const headlines = tests.headlines ?? [];
  if (headlines.length > 0) {
    for (const headline of headlines) {
      lines.push(renderHeadline(tests, headline.message, headline.originatedIn));
    }
    lines.push('');
    if (headlines.some((headline) => headline.originatedIn)) {
      lines.push(ORIGINATED_IN_NOTE);
      lines.push('');
    }
  }

  lines.push(
    `This is not a flake. Do not re-run it. See [Unhandled errors with green test counts](${TESTING_DOC_UNHANDLED_ERRORS_URL}).`
  );
  lines.push('');
  return `${lines.join('\n')}`;
};
