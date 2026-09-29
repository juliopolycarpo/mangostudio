// Per-lane and per-component test rows in the QA report: separate rows for both
// API lanes and every other lane, component and repository totals, and states
// that never render as zero or as a complete total.

import { describe, expect, it } from 'bun:test';

import { absentFromProducer, measured, partial, unavailable } from '../model/states';
import { makeComponents, makeLaneResult, makeLanes, makeMetrics } from '../testing/metrics-fixture';
import { renderDocument } from './document';
import { renderTestsSection } from './tests';
import { renderVerdict } from './verdict';

const API = 'apps/api';

const withApi = (overrides: Parameters<typeof makeLanes>[1]) =>
  makeMetrics('head-sha', {
    components: makeComponents({ [API]: { lanes: makeLanes(API, overrides) } }),
  });

const rowOf = (section: string, needle: string): string => {
  const row = section.split('\n').find((line) => line.startsWith('|') && line.includes(needle));
  if (!row) throw new Error(`no table row containing ${needle} in:\n${section}`);
  return row;
};

const base = makeMetrics('base-sha');

// `100 passed` contains `0 passed`; only a standalone zero count is a claim of no tests.
const ZERO_COUNT_RE = /(?<![\d,.])0 passed/;

describe('renderTestsSection lane rows', () => {
  it('renders both API lanes and the other lanes as separate rows', () => {
    const section = renderTestsSection(base, makeMetrics('head-sha'));

    for (const lane of ['api-unit', 'api-integration', 'shared', 'frontend']) {
      expect(section, `missing a row for lane ${lane}`).toContain(`\`${lane}\``);
    }
    expect(rowOf(section, '`api-unit`')).toContain('100 passed');
    expect(rowOf(section, '`api-integration`')).toContain('100 passed');
  });

  it('renders component totals and a repository total', () => {
    const section = renderTestsSection(base, makeMetrics('head-sha'));

    expect(rowOf(section, '| apps/api | **total**')).toContain('200 passed');
    expect(rowOf(section, '| **repository** | **total**')).toContain('400 passed');
  });

  it('shows failed, skipped, todo and recovered counts on the lane that has them', () => {
    const head = withApi({
      'api-unit': measured(
        makeLaneResult({ failed: 2, skipped: 3, todo: 1, recovered: 1, passed: 50 })
      ),
    });

    const row = rowOf(renderTestsSection(base, head), '`api-unit`');

    expect(row).toContain('50 passed');
    expect(row).toContain('2 failed');
    expect(row).toContain('3 skipped');
    expect(row).toContain('1 todo');
    expect(row).toContain('1 recovered after failing');
  });

  it('renders a partial lane as a lower bound with its shard coverage, never as complete', () => {
    const head = withApi({
      'api-unit': partial(
        makeLaneResult({ passed: 70, shards: { expected: 8, complete: 7 } }),
        'shard 3: no api-unit JUnit report'
      ),
    });
    const section = renderTestsSection(base, head);

    expect(rowOf(section, '`api-unit`')).toContain('≥ 70 passed (partial: 7/8 shards complete)');
    // The component and repository totals over it are lower bounds too.
    expect(rowOf(section, '| apps/api | **total**')).toContain('≥ 170 passed (incomplete)');
    expect(rowOf(section, '| **repository** | **total**')).toContain('(incomplete)');
  });

  it('renders an unavailable lane as n/a, never as zero', () => {
    const head = withApi({ 'api-unit': unavailable('no reports') });

    const row = rowOf(renderTestsSection(base, head), '`api-unit`');

    expect(row).toContain('n/a (unavailable)');
    expect(row).not.toMatch(ZERO_COUNT_RE);
  });

  it('renders a lane the document does not record as not recorded', () => {
    const head = makeMetrics('head-sha', {
      components: makeComponents({
        [API]: { lanes: makeLanes(API).filter((lane) => lane.id !== 'api-unit') },
      }),
    });

    expect(rowOf(renderTestsSection(base, head), '`api-unit`')).toContain('n/a (not recorded)');
  });

  it('renders no delta against a base that lacks the lane, and a delta when both are measured', () => {
    const head = withApi({ 'api-unit': measured(makeLaneResult({ passed: 120 })) });
    const section = renderTestsSection(base, head);

    expect(rowOf(section, '`api-unit`')).toContain('▲ +20');
    const oldBase = makeMetrics('base-sha', {
      components: makeComponents({ [API]: { lanes: undefined } }),
    });
    expect(rowOf(renderTestsSection(oldBase, head), '`api-unit`')).toMatch(
      /\| n\/a \(not recorded\) \|.*\| n\/a \|$/
    );
  });

  it('marks the suite-level cell partial and does not claim a delta over it', () => {
    const head = makeMetrics('head-sha', {
      tests: partial(
        {
          exitCode: 0,
          durationSeconds: 10,
          passed: 900,
          root: 4,
          frontend: 230,
          api: 570,
          shared: 96,
        },
        'api-unit partial: shard 3 lost'
      ),
    });

    const section = renderTestsSection(base, head);

    expect(section).toContain('≥ 900 passed');
    expect(section).toContain('partial: some lane results are missing');
  });

  it('notes on the lane row a job the watchdog had to run twice', () => {
    const head = withApi({ 'api-unit': measured(makeLaneResult({ retriedJobs: 2 })) });

    const section = renderTestsSection(base, head);

    expect(rowOf(section, '`api-unit`')).toContain('note: 2 shard(s) ran twice (hang retried)');
    expect(rowOf(section, '`api-integration`')).not.toContain('ran twice');
  });

  it('renders a partial suite with nothing counted as n/a, never as zero passed', () => {
    const head = makeMetrics('head-sha', {
      tests: partial(
        {
          exitCode: 0,
          durationSeconds: 10,
          passed: 0,
          root: 0,
          frontend: 0,
          api: 0,
          shared: 0,
          parseMiss: true,
        },
        'every lane unavailable'
      ),
    });

    const suiteRow = renderTestsSection(base, head)
      .split('\n')
      .find((line) => line.includes('exit 0 · 240s'));

    expect(suiteRow).toContain('n/a (partial: no lane results)');
    expect(suiteRow).not.toMatch(ZERO_COUNT_RE);
    expect(suiteRow).not.toContain('≥ 0');
  });

  it('lists the earlier failures of recovered tests', () => {
    const head = withApi({
      'api-unit': measured(
        makeLaneResult({
          recovered: 1,
          recoveredFailures: [
            { message: 'flaky: first attempt failed', originatedIn: 'f.test.ts' },
          ],
        })
      ),
    });

    expect(renderTestsSection(base, head)).toContain(
      '`api-unit` failed before passing: `flaky: first attempt failed`'
    );
  });
});

describe('the rendered document with missing test evidence', () => {
  it('never shows the healthy verdict when a lane lost a shard', () => {
    const head = withApi({
      'api-unit': partial(makeLaneResult(), 'shard 3: no api-unit JUnit report'),
    });

    const verdict = renderVerdict(base, head);
    const document = renderDocument(base, head);

    expect(verdict).toContain('Needs attention');
    expect(verdict).toContain('lanes/apps/api/api-unit');
    expect(document).toContain('head/lanes/apps/api/api-unit');
    expect(document).toContain('shard 3: no api-unit JUnit report');
  });

  it('never shows the healthy verdict when the test producer was canceled', () => {
    const head = makeMetrics('head-sha', {
      tests: absentFromProducer('test metrics fragment', 'canceled'),
      components: makeComponents({
        [API]: {
          lanes: makeLanes(API, {
            'api-unit': absentFromProducer('test metrics fragment', 'canceled'),
            'api-integration': absentFromProducer('test metrics fragment', 'canceled'),
          }),
        },
      }),
    });

    expect(renderVerdict(base, head)).not.toContain('No attention signals');
    const repository = rowOf(renderTestsSection(base, head), '| **repository** | **total**');
    expect(repository).toContain('(incomplete)');
    expect(repository).not.toMatch(ZERO_COUNT_RE);
  });

  it('words a partial base as unverified instead of healthy', () => {
    const partialBase = makeMetrics('base-sha', {
      tests: partial(
        {
          exitCode: 0,
          durationSeconds: 10,
          passed: 900,
          root: 4,
          frontend: 230,
          api: 570,
          shared: 96,
        },
        'shard lost on main'
      ),
    });

    const verdict = renderVerdict(partialBase, makeMetrics('head-sha'));

    expect(verdict).toContain('Unverified');
    expect(verdict).not.toContain('No attention signals');
  });

  it('keeps the hedged healthy wording when there is no base at all', () => {
    expect(renderVerdict(null, makeMetrics('head-sha'))).toContain('No attention signals');
  });
});
