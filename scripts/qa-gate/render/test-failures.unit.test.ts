import { describe, expect, it } from 'bun:test';

import { makeMetrics } from '../testing/metrics-fixture';
import { renderTestFailureLead, TESTING_DOC_UNHANDLED_ERRORS_URL } from './test-failures';

describe('renderTestFailureLead', () => {
  it('returns empty string for a green suite so coverage-first output is unchanged', () => {
    expect(renderTestFailureLead(makeMetrics('head').tests)).toBe('');
    expect(renderTestFailureLead(null)).toBe('');
    expect(renderTestFailureLead({ error: 'missing fragment' })).toBe('');
  });

  it('leads with unhandled-error headlines and the originated-in caveat', () => {
    const markdown = renderTestFailureLead({
      exitCode: 1,
      durationSeconds: 165,
      passed: 1150,
      root: 0,
      frontend: 1150,
      api: 0,
      shared: 0,
      runtime: 0,
      failed: 0,
      failedFiles: 0,
      errors: 2,
      headlines: [
        {
          message: 'ReferenceError: window is not defined',
          originatedIn: 'tests/unit/features/library/backup-list.test.tsx',
        },
      ],
    });

    expect(markdown.startsWith('## Test failures\n')).toBe(true);
    expect(markdown).toContain('2 unhandled errors');
    expect(markdown).toContain('ReferenceError: window is not defined');
    expect(markdown).toContain('tests/unit/features/library/backup-list.test.tsx');
    expect(markdown).toContain('where the run was, not where the timer came from');
    expect(markdown).toContain(TESTING_DOC_UNHANDLED_ERRORS_URL);
    expect(markdown).not.toContain('no failure counts could be parsed');
  });

  it('says so when the exit is non-zero and nothing could be parsed', () => {
    const markdown = renderTestFailureLead({
      exitCode: 1,
      durationSeconds: 12,
      passed: 0,
      root: 0,
      frontend: 0,
      api: 0,
      shared: 0,
      runtime: 0,
      parseMiss: true,
    });

    expect(markdown).toContain('Run failed; no failure counts could be parsed from the log.');
    expect(markdown).not.toContain('0 unhandled');
  });
});
