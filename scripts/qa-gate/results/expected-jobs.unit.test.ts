import { describe, expect, it } from 'bun:test';

import { TEST_LANES, type TestLane } from '../../lib/test-lanes';
import { expectedLocalJobs, expectedShardJobs } from './expected-jobs';

const SHARDED = TEST_LANES.filter((lane) => lane.sharded);
const UNSHARDED = TEST_LANES.filter((lane) => !lane.sharded);

describe('expectedShardJobs', () => {
  it('expects every numbered shard to carry every sharded lane', () => {
    const { jobs, unverified } = expectedShardJobs('shards', 8);

    const numbered = jobs.filter((job) => job.id.startsWith('shard '));
    expect(numbered.map((job) => job.id)).toEqual(
      Array.from({ length: 8 }, (_, index) => `shard ${index + 1}`)
    );
    for (const job of numbered) expect(job.lanes).toEqual(SHARDED);
    expect(unverified).toBeNull();
  });

  it('expects one job per unsharded lane, named after the lane', () => {
    const { jobs } = expectedShardJobs('shards', 8);

    const whole = jobs.filter((job) => !job.id.startsWith('shard '));
    expect(whole.map((job) => [job.id, job.dir, job.lanes.map((lane) => lane.id)])).toEqual(
      UNSHARDED.map((lane) => [lane.id, `shards/test-shard-${lane.id}`, [lane.id]])
    );
  });

  it('derives the set from the count, so a directory that never uploaded is still expected', () => {
    const { jobs } = expectedShardJobs('shards', 8, ['test-shard-1']);

    expect(jobs.filter((job) => job.id.startsWith('shard '))).toHaveLength(8);
  });

  it('falls back to the numbered directories found, and says the set is unverified', () => {
    const { jobs, unverified } = expectedShardJobs('shards', null, [
      'test-shard-2',
      'test-shard-10',
      'test-shard-1',
      'test-shard-frontend',
    ]);

    expect(jobs.filter((job) => job.id.startsWith('shard ')).map((job) => job.id)).toEqual([
      'shard 1',
      'shard 2',
      'shard 10',
    ]);
    expect(unverified).toContain('expected shard count was not provided');
  });

  it('adds a numbered job only when some lane is sharded', () => {
    const onlyWhole: TestLane[] = UNSHARDED;

    const { jobs } = expectedShardJobs('shards', 8, [], onlyWhole);

    expect(jobs.map((job) => job.id)).toEqual(onlyWhole.map((lane) => lane.id));
  });
});

describe('expectedLocalJobs', () => {
  it('is one job in the given directory carrying every lane', () => {
    const { jobs, unverified } = expectedLocalJobs('/repo');

    expect(jobs).toEqual([{ id: 'local', dir: '/repo', lanes: TEST_LANES }]);
    expect(unverified).toBeNull();
  });
});
