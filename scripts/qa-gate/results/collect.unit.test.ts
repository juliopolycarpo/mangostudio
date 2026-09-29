// Failure modes of the lane adapters, driven through the same entry point the
// collector uses (`collectLaneOutcomes`) over in-memory artifacts. Each mode
// must land on `partial` or `unavailable` — never on a smaller complete total,
// a zero, or a success.

import { describe, expect, it } from 'bun:test';

import { TEST_LANES, type TestLaneId } from '../../lib/test-lanes';
import { buildTestSuiteStats } from '../junit-results';
import { presentValue } from '../model/states';
import { fakeFiles, junitXml, passingCases, receiptJson } from '../testing/junit-fixture';
import { collectLaneOutcomes, laneCells, suiteMeasurement } from './collect';
import { expectedShardJobs } from './expected-jobs';

const SHARDS = 8;
const SHARDED = TEST_LANES.filter((lane) => lane.sharded);
const CASES_PER_SHARD = 10;

type Files = Record<string, string>;

/** Every artifact of a clean 8-shard run plus the unsharded frontend job. */
const cleanRun = (): Files => {
  const files: Files = {};
  for (let shard = 1; shard <= SHARDS; shard++) {
    const dir = `shards/test-shard-${shard}`;
    files[`${dir}/shard-meta.json`] = receiptJson(shard, 0);
    for (const lane of SHARDED) {
      files[`${dir}/${lane.junitPath}`] = junitXml(
        passingCases(CASES_PER_SHARD, `${lane.id}-${shard}`)
      );
    }
  }
  const frontend = TEST_LANES.find((lane) => !lane.sharded);
  if (frontend) {
    files['shards/test-shard-frontend/shard-meta.json'] = receiptJson('frontend', 0);
    files[`shards/test-shard-frontend/${frontend.junitPath}`] = junitXml(passingCases(30, 'fe'));
  }
  return files;
};

const collect = async (files: Files, shardCount: number | null = SHARDS) => {
  const fs = fakeFiles(files);
  const outcomes = await collectLaneOutcomes({
    jobSet: expectedShardJobs('shards', shardCount, [
      ...new Set(Object.keys(files).map((p) => p.split('/')[1] ?? '')),
    ]),
    lanes: TEST_LANES,
    readText: fs.readText,
  });
  return { outcomes, cells: laneCells(outcomes), fs };
};

const cell = (cells: ReturnType<typeof laneCells>, id: TestLaneId) => {
  const found = cells[id];
  if (!found) throw new Error(`no cell for lane ${id}; lanes: ${Object.keys(cells).join(', ')}`);
  return found;
};

describe('collectLaneOutcomes', () => {
  it('measures every lane of a complete run, one entry per lane', async () => {
    const { cells } = await collect(cleanRun());

    for (const lane of SHARDED) {
      const result = cell(cells, lane.id);
      expect(result.state, `${lane.id} should be measured`).toBe('measured');
      expect(presentValue(result)?.passed).toBe(SHARDS * CASES_PER_SHARD);
    }
    expect(presentValue(cell(cells, 'frontend'))?.passed).toBe(30);
    // Both API lanes stay separate; neither is folded into the other.
    expect(Object.keys(cells)).toEqual(expect.arrayContaining(['api-unit', 'api-integration']));
  });

  it('reads existing artifacts only: JUnit files and receipts, nothing executed', async () => {
    const { fs } = await collect(cleanRun());

    const unexpected = fs.reads.filter(
      (path) => !path.endsWith('.xml') && !path.endsWith('shard-meta.json')
    );
    expect(unexpected).toEqual([]);
  });

  it('marks a lane partial, not smaller, when one shard lost its report', async () => {
    const files = cleanRun();
    const lost = SHARDED[0];
    delete files[`shards/test-shard-3/${lost.junitPath}`];

    const { cells } = await collect(files);
    const result = cell(cells, lost.id);

    expect(result.state, `expected lane state: partial | received: ${result.state}`).toBe(
      'partial'
    );
    expect('reasons' in result && result.reasons.join('\n')).toContain(
      `shard 3: no ${lost.id} JUnit report`
    );
    expect(presentValue(result)?.passed).toBe((SHARDS - 1) * CASES_PER_SHARD);
    expect(presentValue(result)?.shards).toEqual({ expected: SHARDS, complete: SHARDS - 1 });
    // The other lanes of that shard are unaffected.
    expect(cell(cells, SHARDED[1].id).state).toBe('measured');
  });

  it('marks a lane partial when a shard directory never uploaded at all', async () => {
    const files = Object.fromEntries(
      Object.entries(cleanRun()).filter(([path]) => !path.includes('test-shard-5/'))
    );

    const { cells } = await collect(files);

    for (const lane of SHARDED) {
      const result = cell(cells, lane.id);
      expect(result.state, `${lane.id} lost shard 5 entirely`).toBe('partial');
      expect('reasons' in result && result.reasons.join('\n')).toContain('shard 5');
    }
  });

  it('marks a lane partial when a JUnit report is truncated', async () => {
    const files = cleanRun();
    const lane = SHARDED[1];
    const path = `shards/test-shard-2/${lane.junitPath}`;
    files[path] = (files[path] ?? '').slice(0, 400);

    const { cells } = await collect(files);
    const result = cell(cells, lane.id);

    expect(result.state, `expected lane state: partial | received: ${result.state}`).toBe(
      'partial'
    );
    expect('reasons' in result && result.reasons.join('\n')).toContain('truncated');
  });

  it('marks a lane partial when a shard has no process receipt', async () => {
    const files = cleanRun();
    delete files['shards/test-shard-4/shard-meta.json'];

    const { cells } = await collect(files);

    for (const lane of SHARDED) {
      const result = cell(cells, lane.id);
      expect(result.state, `${lane.id} without shard 4's receipt`).toBe('partial');
      expect('reasons' in result && result.reasons.join('\n')).toContain(
        'shard 4: no process receipt'
      );
    }
  });

  it('distrusts a report whose job the watchdog killed (exit 124)', async () => {
    const files = cleanRun();
    files['shards/test-shard-6/shard-meta.json'] = receiptJson(6, 124);

    const { cells } = await collect(files);
    const result = cell(cells, SHARDED[0].id);

    expect(result.state, `expected lane state: partial | received: ${result.state}`).toBe(
      'partial'
    );
    expect(presentValue(result)?.timedOut).toBe(1);
    expect('reasons' in result && result.reasons.join('\n')).toContain('timed out (exit 124)');
  });

  it('is unavailable, never zero, when a lane delivered nothing at all', async () => {
    const files = Object.fromEntries(
      Object.entries(cleanRun()).filter(([path]) => !path.includes('test-shard-frontend/'))
    );

    const { cells } = await collect(files);
    const result = cell(cells, 'frontend');

    expect(result.state, `expected lane state: unavailable | received: ${result.state}`).toBe(
      'unavailable'
    );
    expect(presentValue(result)).toBeNull();
  });

  it('cannot verify a shard set whose expected count was not given', async () => {
    const { cells } = await collect(cleanRun(), null);

    for (const lane of SHARDED) {
      const result = cell(cells, lane.id);
      expect(result.state, `${lane.id} without a stated shard count`).toBe('partial');
      expect('reasons' in result && result.reasons.join('\n')).toContain(
        'expected shard count was not provided'
      );
    }
    expect(cell(cells, 'frontend').state).toBe('measured');
  });

  it('keeps a lane measured but flags the job the watchdog ran twice', async () => {
    const files = cleanRun();
    files['shards/test-shard-7/shard-meta.json'] = JSON.stringify({
      shard: 7,
      exitCode: 0,
      durationSeconds: 400,
      attempts: 2,
    });

    const { cells } = await collect(files);
    const result = cell(cells, SHARDED[0].id);

    expect(result.state).toBe('measured');
    expect(presentValue(result)?.retriedJobs).toBe(1);
    expect(presentValue(cell(cells, 'frontend'))?.retriedJobs).toBe(0);
  });

  it('records a non-zero exit with all-green cases so the lane does not read clean', async () => {
    const files = cleanRun();
    files['shards/test-shard-1/shard-meta.json'] = receiptJson(1, 1);

    const { cells } = await collect(files);
    const result = cell(cells, SHARDED[0].id);

    expect(result.state, `expected lane state: measured | received: ${result.state}`).toBe(
      'measured'
    );
    expect(presentValue(result)?.nonZeroExits).toBe(1);
    expect(presentValue(result)?.failed).toBe(0);
  });
});

describe('suiteMeasurement', () => {
  const noErrors = { errors: 0, headlines: [] };

  it('is measured only when every lane is', async () => {
    const { outcomes } = await collect(cleanRun());

    const suite = suiteMeasurement(buildTestSuiteStats(outcomes, noErrors, 0, 60), outcomes);

    expect(suite.state).toBe('measured');
  });

  it('is partial, carrying the lower bound, when a lane lost a shard', async () => {
    const files = cleanRun();
    delete files[`shards/test-shard-3/${SHARDED[0].junitPath}`];
    const { outcomes } = await collect(files);

    const suite = suiteMeasurement(buildTestSuiteStats(outcomes, noErrors, 0, 60), outcomes);

    expect(suite.state).toBe('partial');
    expect('reasons' in suite && suite.reasons.join('\n')).toContain(SHARDED[0].id);
  });

  it('marks parseMiss when a lane produced nothing, even on exit 0', async () => {
    const files = Object.fromEntries(
      Object.entries(cleanRun()).filter(([path]) => !path.includes('test-shard-frontend/'))
    );
    const { outcomes } = await collect(files);

    const stats = buildTestSuiteStats(outcomes, noErrors, 0, 60);

    expect(stats.parseMiss).toBe(true);
    expect(suiteMeasurement(stats, outcomes).state).toBe('partial');
  });
});
