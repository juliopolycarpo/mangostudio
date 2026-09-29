// Identity and retry rules of the lane fold: a test seen in more than one report
// is one test, the later run wins, and an earlier failure it no longer has stays
// visible as `recovered`.

import { describe, expect, it } from 'bun:test';

import { laneById } from '../../lib/test-lanes';
import { presentValue } from '../model/states';
import { type FixtureCase, fakeFiles, junitXml, receiptJson } from '../testing/junit-fixture';
import { readJobEvidence } from './evidence';
import type { ExpectedJob } from './expected-jobs';
import { foldLane } from './fold';

const lane = laneById('api-unit');

/** One job dir per report: `runs[i]` is what job `i + 1` wrote for the lane. */
const foldRuns = async (runs: readonly (readonly FixtureCase[])[]) => {
  const files: Record<string, string> = {};
  const jobs: ExpectedJob[] = runs.map((cases, index) => {
    const dir = `job-${index + 1}`;
    files[`${dir}/${lane.junitPath}`] = junitXml(cases);
    files[`${dir}/shard-meta.json`] = receiptJson(index + 1, 0);
    return { id: `job ${index + 1}`, dir, lanes: [lane] };
  });
  const fs = fakeFiles(files);
  const evidence = await Promise.all(jobs.map((job) => readJobEvidence(job, fs.readText)));
  return foldLane(lane, evidence);
};

const flaky = (outcome: 'pass' | 'fail'): FixtureCase => ({
  name: 'flaky',
  file: 'f.test.ts',
  line: 3,
  outcome,
  message: 'first attempt failed',
});

describe('foldLane retries and duplicates', () => {
  it('counts a test that failed then passed once, and keeps the earlier failure visible', async () => {
    const result = await foldRuns([[flaky('fail'), { name: 'other', line: 9 }], [flaky('pass')]]);

    const lane = presentValue(result);
    expect(lane, 'lane should carry a value').not.toBeNull();
    expect(lane?.passed, 'expected the retried test to count once as passed').toBe(2);
    expect(lane?.failed, 'expected the retried test to leave no failure behind').toBe(0);
    expect(lane?.recovered).toBe(1);
    expect(lane?.recoveredFailures[0]?.message).toBe('flaky: first attempt failed');
    expect(result.state).toBe('measured');
  });

  it('keeps a test that failed on every run as one failure', async () => {
    const result = await foldRuns([[flaky('fail')], [flaky('fail')]]);

    expect(presentValue(result)).toMatchObject({ failed: 1, passed: 0, recovered: 0 });
  });

  it('lets a later failure supersede an earlier pass', async () => {
    const result = await foldRuns([[flaky('pass')], [flaky('fail')]]);

    expect(presentValue(result)).toMatchObject({ failed: 1, passed: 0, recovered: 0 });
  });

  it('does not lose the earlier failure across a fail, pass, pass chain', async () => {
    const result = await foldRuns([[flaky('fail')], [flaky('pass')], [flaky('pass')]]);

    expect(presentValue(result)).toMatchObject({ passed: 1, failed: 0, recovered: 1 });
  });

  it('counts a test repeated verbatim in two reports once', async () => {
    const result = await foldRuns([[{ name: 'same', line: 1 }], [{ name: 'same', line: 1 }]]);

    expect(
      presentValue(result)?.passed,
      `expected passed tests: 1 | received: ${presentValue(result)?.passed} (one test in two reports must count once)`
    ).toBe(1);
  });

  it('keeps distinct tests that share a title but sit on different lines', async () => {
    const result = await foldRuns([
      [
        { name: 'row', line: 4 },
        { name: 'row', line: 5 },
      ],
    ]);

    expect(presentValue(result)?.passed).toBe(2);
  });

  it('does not collapse it.each rows that share file, title and line inside one report', async () => {
    const rows = [
      { name: 'row', line: 4 },
      { name: 'row', line: 4 },
      { name: 'row', line: 4 },
    ];

    expect(
      presentValue(await foldRuns([rows]))?.passed,
      'expected 3 rows kept apart inside one report'
    ).toBe(3);
    // Re-run in a second report: each row pairs with its own earlier occurrence.
    expect(
      presentValue(await foldRuns([rows, rows]))?.passed,
      'expected each row to pair with its own earlier occurrence, 3 in total'
    ).toBe(3);
  });

  it('counts todo and skipped apart after merging', async () => {
    const result = await foldRuns([
      [{ name: 'a' }, { name: 'b', outcome: 'skip' }, { name: 'c', outcome: 'todo' }],
    ]);

    expect(presentValue(result)).toMatchObject({ passed: 1, skipped: 1, todo: 1 });
  });
});
