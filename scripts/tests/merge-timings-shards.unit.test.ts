import { describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { mergeLaneSlices, mergeTimingsShards, type TimingsFile } from '../ci/merge-timings-shards';
import { JUNIT_DIR, TIMINGS_DIR } from '../lib/test-lanes';

const slice = (files: Record<string, number>): TimingsFile => ({ version: 1, files });

interface StagedShard {
  readonly name: string;
  readonly lane: string;
  readonly files: Record<string, number>;
  /** Set false to model a shard that restored a baseline but never ran the lane. */
  readonly junit?: boolean;
}

const stageShards = async (
  shards: readonly StagedShard[]
): Promise<{ root: string; out: string }> => {
  const root = await mkdtemp(join(tmpdir(), 'timings-shards-'));
  const out = join(root, 'merged');
  for (const shard of shards) {
    const shardRoot = join(root, 'shards', shard.name);
    const timingsDir = join(shardRoot, TIMINGS_DIR);
    await mkdir(timingsDir, { recursive: true });
    await writeFile(join(timingsDir, `${shard.lane}.json`), JSON.stringify(slice(shard.files)));
    if (shard.junit !== false) {
      const junitDir = join(shardRoot, JUNIT_DIR);
      await mkdir(junitDir, { recursive: true });
      await writeFile(join(junitDir, `${shard.lane}.xml`), '<testsuite/>');
    }
  }
  return { root: join(root, 'shards'), out };
};

describe('mergeLaneSlices', () => {
  it('unions the slices when the shards partitioned the lane', () => {
    const { merged, problem } = mergeLaneSlices('api', [
      slice({ 'tests/unit/a.test.ts': 10, 'tests/unit/c.test.ts': 30 }),
      slice({ 'tests/unit/b.test.ts': 20 }),
    ]);
    expect(problem).toBeNull();
    expect(Object.keys(merged.files).sort()).toEqual([
      'tests/unit/a.test.ts',
      'tests/unit/b.test.ts',
      'tests/unit/c.test.ts',
    ]);
    expect(merged.version).toBe(1);
  });

  // The failure this whole script exists for: two shards reading different
  // timings files both claim the same file, so between them they never run
  // something else — and both still exit 0.
  it('reports a file claimed by two shards', () => {
    const { problem } = mergeLaneSlices('api', [
      slice({ 'tests/unit/a.test.ts': 10, 'tests/unit/b.test.ts': 20 }),
      slice({ 'tests/unit/b.test.ts': 21, 'tests/unit/c.test.ts': 30 }),
    ]);
    expect(problem).not.toBeNull();
    expect(problem?.kind).toBe('duplicate');
    expect(problem?.files).toEqual(['tests/unit/b.test.ts']);
  });

  it('names every duplicate, not just the first', () => {
    const { problem } = mergeLaneSlices('api', [
      slice({ a: 1, b: 2, c: 3 }),
      slice({ a: 1, c: 3 }),
    ]);
    expect(problem?.files).toEqual(['a', 'c']);
  });
});

describe('mergeTimingsShards', () => {
  it('writes one merged file per lane that reported', async () => {
    const { root, out } = await stageShards([
      { name: 'test-shard-1', lane: 'api', files: { 'tests/unit/a.test.ts': 10 } },
      { name: 'test-shard-2', lane: 'api', files: { 'tests/unit/b.test.ts': 20 } },
    ]);

    const result = await mergeTimingsShards(root, out);

    expect(result.problems).toEqual([]);
    expect(result.lanes).toHaveLength(1);
    expect(result.lanes[0]).toMatchObject({ lane: 'api', shards: 2, files: 2, totalMs: 30 });

    const written = (await Bun.file(join(out, 'api.json')).json()) as TimingsFile;
    expect(written.version).toBe(1);
    expect(Object.keys(written.files).sort()).toEqual([
      'tests/unit/a.test.ts',
      'tests/unit/b.test.ts',
    ]);
  });

  it('surfaces a cross-shard duplicate as a problem', async () => {
    const { root, out } = await stageShards([
      { name: 'test-shard-1', lane: 'api', files: { 'tests/unit/a.test.ts': 10 } },
      { name: 'test-shard-2', lane: 'api', files: { 'tests/unit/a.test.ts': 11 } },
    ]);

    const result = await mergeTimingsShards(root, out);

    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toMatchObject({ lane: 'api', kind: 'duplicate' });
  });

  // A cold cache and a lane that legitimately has nothing on most shards look
  // the same from here, and neither is an error — Bun falls back to the
  // round-robin split when the file is missing.
  it('skips a lane no shard reported rather than writing an empty file', async () => {
    const { root, out } = await stageShards([
      { name: 'test-shard-1', lane: 'api', files: { 'tests/unit/a.test.ts': 10 } },
    ]);

    const result = await mergeTimingsShards(root, out);

    expect(result.lanes.map((lane) => lane.lane)).toEqual(['api']);
    expect(await Bun.file(join(out, 'runtime.json')).exists()).toBe(false);
  });

  // A malformed shard file is not the same as a missing one: it is evidence a
  // write landed corrupt or mid-fan-out, and merging around it would silently
  // shrink the partition rather than fail the run that produced it.
  it('reports a malformed slice as a problem instead of silently dropping it', async () => {
    const { root, out } = await stageShards([
      { name: 'test-shard-1', lane: 'api', files: { 'tests/unit/a.test.ts': 10 } },
    ]);
    const bad = join(root, 'test-shard-2', TIMINGS_DIR);
    await mkdir(bad, { recursive: true });
    await writeFile(join(bad, 'api.json'), '{"version":2,"files":{}}');
    const badJunit = join(root, 'test-shard-2', JUNIT_DIR);
    await mkdir(badJunit, { recursive: true });
    await writeFile(join(badJunit, 'api.xml'), '<testsuite/>');

    const result = await mergeTimingsShards(root, out);

    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toMatchObject({ lane: 'api', kind: 'malformed' });
    expect(result.problems[0]?.files).toEqual([join(bad, 'api.json')]);
    // The remaining valid shard still merges so the file is available for
    // debugging; `problems` is what fails the CI step, not a missing output.
    expect(result.lanes[0]).toMatchObject({ shards: 1, files: 1 });
  });

  // PR #903's own CI: shard 4/8 restored the full 398-entry `api` baseline,
  // then `runtime` failed first in the same turbo invocation and turbo never
  // scheduled `api` at all — the restored file sat on disk untouched and
  // would have duplicate-claimed every file the shards that actually ran
  // `api` already covered. No JUnit report for the lane is the only signal
  // that distinguishes this from a genuine full-coverage contribution.
  it('discards a restored baseline the shard never touched', async () => {
    const { root, out } = await stageShards([
      { name: 'test-shard-1', lane: 'api', files: { 'tests/unit/a.test.ts': 10 } },
      { name: 'test-shard-2', lane: 'api', files: { 'tests/unit/b.test.ts': 20 } },
      {
        name: 'test-shard-3',
        lane: 'api',
        files: { 'tests/unit/a.test.ts': 10, 'tests/unit/b.test.ts': 20 },
        junit: false,
      },
    ]);

    const result = await mergeTimingsShards(root, out);

    expect(result.problems).toEqual([]);
    expect(result.lanes[0]).toMatchObject({ lane: 'api', shards: 2, files: 2 });
  });
});
