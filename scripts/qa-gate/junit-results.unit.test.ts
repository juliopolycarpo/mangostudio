import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { laneById, TEST_LANES } from '../lib/test-lanes';
import { buildTestSuiteStats, type LaneResult, parseJunitXml } from './junit-results';

// Both fixtures are real reporter output, not hand-written XML: the two
// runners disagree on attribute names, self-closing style, and where the file
// lives, and a hand-written fixture would quietly agree with the parser.
//   junit-bun.xml    bun test --reporter=junit --reporter-outfile=…
//   junit-vitest.xml vitest run --reporter=junit --outputFile=…
const fixture = (name: string): Promise<string> =>
  Bun.file(join(import.meta.dir, 'testing/fixtures', `${name}.xml`)).text();

const laneResult = (
  id: Parameters<typeof laneById>[0],
  counts: LaneResult['counts'],
  reports = 1
): LaneResult => ({
  lane: laneById(id),
  counts,
  reports,
});

const counts = (overrides: Partial<LaneResult['counts']> = {}): LaneResult['counts'] => ({
  tests: 0,
  passed: 0,
  failed: 0,
  skipped: 0,
  failedFiles: [],
  headlines: [],
  ...overrides,
});

describe('parseJunitXml', () => {
  it('counts a Bun report, which self-closes passing cases', async () => {
    const parsed = parseJunitXml(await fixture('junit-bun'));
    expect(parsed).toMatchObject({ tests: 3, passed: 1, failed: 1, skipped: 1 });
    expect(parsed.failedFiles).toEqual(['fail.test.ts']);
  });

  it('counts a Vitest report, which never self-closes and nests by file', async () => {
    const parsed = parseJunitXml(await fixture('junit-vitest'));
    expect(parsed).toMatchObject({ tests: 3, passed: 1, failed: 1, skipped: 1 });
    expect(parsed.failedFiles).toEqual(['apps/frontend/tests/unit/zz-fixture/sample.test.ts']);
  });

  it('takes the failure message and the owning file into the headline', async () => {
    const parsed = parseJunitXml(await fixture('junit-vitest'));
    expect(parsed.headlines).toEqual([
      {
        message: 'sample group > fails: expected 1 to be 2 // Object.is equality',
        originatedIn: 'apps/frontend/tests/unit/zz-fixture/sample.test.ts',
      },
    ]);
  });

  it('decodes the entities both reporters escape', async () => {
    const parsed = parseJunitXml(await fixture('junit-bun'));
    // Bun escapes the newlines in an assertion message as &#10;.
    expect(parsed.headlines[0]?.message).toContain('Expected: 2');
    expect(parsed.headlines[0]?.message).toContain('\n');
  });

  it('does not end a tag on a > inside an attribute value', () => {
    const xml =
      '<testsuites><testcase name="a > b" file="x.ts"><failure message="broke"/></testcase></testsuites>';
    const parsed = parseJunitXml(xml);
    expect(parsed).toMatchObject({ tests: 1, failed: 1 });
    expect(parsed.headlines[0]?.message).toBe('a > b: broke');
  });

  it('counts nothing for a report with no cases', () => {
    const empty = '<?xml version="1.0"?>\n<testsuites name="vitest tests" tests="0"></testsuites>';
    expect(parseJunitXml(empty)).toMatchObject({ tests: 0, passed: 0, failed: 0, skipped: 0 });
  });

  it('caps headlines rather than carrying every failure into the report', () => {
    const cases = Array.from(
      { length: 12 },
      (_, index) =>
        `<testcase name="t${index}" file="f${index}.ts"><failure message="boom ${index}"/></testcase>`
    ).join('');
    const parsed = parseJunitXml(`<testsuites>${cases}</testsuites>`);
    expect(parsed.failed).toBe(12);
    expect(parsed.headlines).toHaveLength(5);
  });
});

describe('buildTestSuiteStats', () => {
  const green: readonly LaneResult[] = [
    laneResult('api', counts({ tests: 10, passed: 10 })),
    laneResult('root', counts({ tests: 4, passed: 4 })),
    laneResult('frontend', counts({ tests: 8, passed: 8 })),
  ];

  it('sums a green run per workspace and omits every failure field', () => {
    const stats = buildTestSuiteStats(green, { errors: 0, headlines: [] }, 0, 91);
    expect(stats).toEqual({
      exitCode: 0,
      durationSeconds: 91,
      passed: 22,
      root: 4,
      api: 10,
      shared: 0,
      runtime: 0,
      frontend: 8,
    });
  });

  it('reports failures and their files', () => {
    const stats = buildTestSuiteStats(
      [
        laneResult(
          'api',
          counts({
            tests: 10,
            passed: 8,
            failed: 2,
            failedFiles: ['a.test.ts', 'b.test.ts'],
            headlines: [{ message: 'a: boom', originatedIn: 'a.test.ts' }],
          })
        ),
      ],
      { errors: 0, headlines: [] },
      1,
      91
    );
    expect(stats).toMatchObject({ failed: 2, failedFiles: 2, errors: 0 });
    expect(stats.headlines).toHaveLength(1);
  });

  // The green-counts-plus-Errors-N class: JUnit says everything passed and the
  // run still failed. Without the log-derived errors this would report
  // parseMiss and lose the headline that names the leak.
  it('treats Vitest unhandled errors as a failure signal on green counts', () => {
    const stats = buildTestSuiteStats(
      green,
      {
        errors: 2,
        headlines: [
          {
            message: 'ReferenceError: window is not defined',
            originatedIn: 'tests/unit/features/library/backup-list.test.tsx',
          },
        ],
      },
      1,
      91
    );
    expect(stats).toMatchObject({ failed: 0, errors: 2, passed: 22 });
    expect(stats.parseMiss).toBeUndefined();
    expect(stats.headlines?.[0]?.originatedIn).toBe(
      'tests/unit/features/library/backup-list.test.tsx'
    );
  });

  it('sets parseMiss when the run failed and nothing structured explains it', () => {
    const stats = buildTestSuiteStats(green, { errors: 0, headlines: [] }, 1, 91);
    expect(stats.parseMiss).toBe(true);
    expect(stats.failed).toBeUndefined();
  });

  it('reports zero for a lane that produced no report at all', () => {
    const stats = buildTestSuiteStats([], { errors: 0, headlines: [] }, 0, 0);
    expect(stats.passed).toBe(0);
    for (const lane of TEST_LANES) expect(stats[lane.workspace]).toBe(0);
  });

  it('sets parseMiss when a configured lane wrote no JUnit report on a green exit', () => {
    const stats = buildTestSuiteStats(
      [
        laneResult('api', counts({ tests: 0, passed: 0 }), 0),
        laneResult('root', counts({ tests: 4, passed: 4 })),
      ],
      { errors: 0, headlines: [] },
      0,
      91
    );
    expect(stats.parseMiss).toBe(true);
    expect(stats.passed).toBe(4);
    expect(stats.failed).toBeUndefined();
  });

  it('counts the same relative path as two failed files when two lanes own it', () => {
    const stats = buildTestSuiteStats(
      [
        laneResult(
          'shared',
          counts({
            tests: 1,
            failed: 1,
            failedFiles: ['tests/unit/runtime-home.test.ts'],
          })
        ),
        laneResult(
          'runtime',
          counts({
            tests: 1,
            failed: 1,
            failedFiles: ['tests/unit/runtime-home.test.ts'],
          })
        ),
      ],
      { errors: 0, headlines: [] },
      1,
      91
    );
    expect(stats).toMatchObject({ failed: 2, failedFiles: 2 });
  });
});
