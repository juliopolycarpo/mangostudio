// End to end through the real CLI: a shards directory missing one job, given the
// workflow's shard count, must come out as `partial` lanes in the fragment — not
// as a smaller complete total. Reads only files the test writes; nothing here
// runs a test lane.

import { afterAll, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TEST_LANES } from '../lib/test-lanes';
import type { TestMetricsFragment } from '../qa-gate/model/fragment';
import { junitXml, passingCases, receiptJson } from '../qa-gate/testing/junit-fixture';

const script = join(import.meta.dir, '..', 'qa-gate', 'collect-test-metrics.ts');
const SHARDS = 3;
const COLLECT_TIMEOUT = 30_000;

const temps: string[] = [];
const makeTemp = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'collect-lanes-'));
  temps.push(dir);
  return dir;
};
afterAll(async () => {
  await Promise.all(temps.map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A complete SHARDS-shard run plus the unsharded lanes' own jobs, minus `lost` directories. */
const writeRun = async (root: string, lost: readonly string[] = []): Promise<void> => {
  const write = async (name: string, meta: string, lanes: typeof TEST_LANES) => {
    if (lost.includes(name)) return;
    await Bun.write(join(root, name, 'shard-meta.json'), meta);
    for (const lane of lanes) {
      await Bun.write(
        join(root, name, lane.junitPath),
        junitXml(passingCases(5, `${name}-${lane.id}`))
      );
    }
  };
  for (let shard = 1; shard <= SHARDS; shard++) {
    await write(
      `test-shard-${shard}`,
      receiptJson(shard, 0),
      TEST_LANES.filter((lane) => lane.sharded)
    );
  }
  for (const lane of TEST_LANES.filter((candidate) => !candidate.sharded)) {
    await write(`test-shard-${lane.id}`, receiptJson(lane.id, 0), [lane]);
  }
};

const collect = async (dir: string, shardCount?: number): Promise<TestMetricsFragment> => {
  const summary = join(dir, 'shard-summary.json');
  await Bun.write(
    summary,
    JSON.stringify({
      shards: SHARDS,
      exitCode: 0,
      durationSeconds: 12,
      unhandledErrors: { errors: 0, headlines: [] },
    })
  );
  const proc = Bun.spawn({
    cmd: ['bun', script, summary, join(dir, 'shards'), ...(shardCount ? [String(shardCount)] : [])],
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  expect(exitCode, `collector exited ${exitCode}; stdout: ${stdout.slice(0, 300)}`).toBe(0);
  return JSON.parse(stdout) as TestMetricsFragment;
};

const stateOf = (fragment: TestMetricsFragment, laneId: string): string =>
  fragment.lanes?.[laneId]?.state ?? 'absent';

describe('collect-test-metrics per-lane results', () => {
  it(
    'measures every lane of a complete run',
    async () => {
      const dir = await makeTemp();
      await writeRun(join(dir, 'shards'));

      const fragment = await collect(dir, SHARDS);

      for (const lane of TEST_LANES) {
        expect(stateOf(fragment, lane.id), `lane ${lane.id} of a complete run`).toBe('measured');
      }
      expect(fragment.tests.state).toBe('measured');
    },
    COLLECT_TIMEOUT
  );

  it(
    'reports sharded lanes partial when one shard never uploaded, and the suite with them',
    async () => {
      const dir = await makeTemp();
      await writeRun(join(dir, 'shards'), ['test-shard-2']);

      const fragment = await collect(dir, SHARDS);

      for (const lane of TEST_LANES.filter((candidate) => candidate.sharded)) {
        expect(
          stateOf(fragment, lane.id),
          `expected lane state: partial | received: ${stateOf(fragment, lane.id)} (${lane.id} lost shard 2)`
        ).toBe('partial');
      }
      expect(fragment.tests.state).toBe('partial');
    },
    COLLECT_TIMEOUT
  );

  it(
    'reports the unsharded lane unavailable when its own job never uploaded',
    async () => {
      const dir = await makeTemp();
      await writeRun(join(dir, 'shards'), ['test-shard-frontend']);

      const fragment = await collect(dir, SHARDS);

      expect(stateOf(fragment, 'frontend')).toBe('unavailable');
    },
    COLLECT_TIMEOUT
  );

  it(
    'cannot verify the shard set without a count and says so',
    async () => {
      const dir = await makeTemp();
      await writeRun(join(dir, 'shards'));

      const fragment = await collect(dir);

      const lane = fragment.lanes?.['api-unit'];
      expect(lane?.state).toBe('partial');
      expect(lane && 'reasons' in lane && lane.reasons.join(' ')).toContain(
        'expected shard count was not provided'
      );
    },
    COLLECT_TIMEOUT
  );

  it(
    'rejects a shard count that is not a positive integer',
    async () => {
      const dir = await makeTemp();
      const proc = Bun.spawn({
        cmd: ['bun', script, join(dir, 'summary.json'), join(dir, 'shards'), 'eight'],
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);

      expect(exitCode).toBe(1);
      expect(stderr).toContain('Invalid shard count "eight"; expected a positive integer.');
    },
    COLLECT_TIMEOUT
  );
});
