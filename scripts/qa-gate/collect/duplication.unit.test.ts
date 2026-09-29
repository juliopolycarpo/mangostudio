import { describe, expect, it } from 'bun:test';

import { collectDuplication, type DuplicationDeps } from './duplication';

/** Named fake of jscpd: what it exits with, prints, and leaves on disk. */
const makeFakeJscpd = (options: {
  readonly report: string | null;
  readonly exitCode?: number;
  readonly stderr?: string;
}) => {
  const removed: string[] = [];
  const deps: DuplicationDeps = {
    run: () => Promise.resolve({ stderr: options.stderr ?? '', exitCode: options.exitCode ?? 0 }),
    removeReport: (path) => {
      removed.push(path);
      return Promise.resolve();
    },
    readReport: () =>
      options.report === null
        ? Promise.reject(new Error('ENOENT: no such file'))
        : Promise.resolve(options.report),
  };
  return { deps, removed };
};

const report = (total: unknown) => JSON.stringify({ statistics: { total } });

describe('collectDuplication', () => {
  it('returns the totals from a complete report, including a real zero', async () => {
    const { deps } = makeFakeJscpd({
      report: report({ clones: 0, duplicatedLines: 0, percentage: 0 }),
    });

    expect(await collectDuplication(deps)).toEqual({
      clones: 0,
      duplicatedLines: 0,
      percentage: 0,
    });
  });

  it('accepts a complete report even when jscpd exited non-zero (a threshold, not a crash)', async () => {
    const { deps } = makeFakeJscpd({
      report: report({ clones: 3, duplicatedLines: 40, percentage: 1.5 }),
      exitCode: 1,
    });

    expect((await collectDuplication(deps)).clones).toBe(3);
  });

  // Regression: missing totals used to become `?? 0`, a measured 0% duplication.
  it.each([
    ['no statistics', JSON.stringify({})],
    ['no total', JSON.stringify({ statistics: {} })],
    ['an empty total', report({})],
    ['a missing percentage', report({ clones: 2, duplicatedLines: 10 })],
    ['a non-numeric field', report({ clones: 'many', duplicatedLines: 10, percentage: 1 })],
  ])('throws instead of reporting zero when the report has %s', async (_label, text) => {
    const { deps } = makeFakeJscpd({ report: text, exitCode: 2, stderr: 'jscpd blew up' });

    await expect(collectDuplication(deps)).rejects.toThrow(
      /jscpd report statistics\.total is missing .* \(jscpd exit 2: jscpd blew up\)/
    );
  });

  it('names exactly the missing fields', async () => {
    const { deps } = makeFakeJscpd({ report: report({ clones: 2 }) });

    await expect(collectDuplication(deps)).rejects.toThrow('missing duplicatedLines, percentage');
  });

  it('throws with the exit code and stderr when jscpd left no report', async () => {
    const { deps } = makeFakeJscpd({ report: null, exitCode: 137, stderr: 'Killed' });

    await expect(collectDuplication(deps)).rejects.toThrow(
      /jscpd produced no report at .*jscpd-report\.json \(exit 137\): Killed/
    );
  });

  it('throws on a report that is not JSON', async () => {
    const { deps } = makeFakeJscpd({ report: '{truncated', exitCode: 0 });

    await expect(collectDuplication(deps)).rejects.toThrow(
      'jscpd report is not valid JSON (jscpd exit 0)'
    );
  });

  it('removes a stale report before running, so old numbers are never read', async () => {
    const { deps, removed } = makeFakeJscpd({
      report: report({ clones: 1, duplicatedLines: 1, percentage: 1 }),
    });

    await collectDuplication(deps);

    expect(removed).toHaveLength(1);
    expect(removed[0]).toContain('jscpd-report.json');
  });
});
