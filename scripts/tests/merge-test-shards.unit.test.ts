import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { listShardDirs, mergeTestShards, summarizeShardMeta } from '../ci/merge-test-shards';
import { SHARDED_LCOV_PATHS, VITEST_BLOB_DIR } from '../lib/test-lanes';
import { parseLcovSummary } from '../qa-gate/parse-lcov';

const temps: string[] = [];

const makeTemp = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'mango-shard-merge-'));
  temps.push(dir);
  return dir;
};

afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const lcov = (lines: ReadonlyArray<[number, number]>): string =>
  [
    'TN:',
    'SF:src/a.ts',
    'FNF:1',
    `FNH:${lines.some(([, hits]) => hits > 0) ? 1 : 0}`,
    ...lines.map(([line, hits]) => `DA:${line},${hits}`),
    `LF:${lines.length}`,
    `LH:${lines.filter(([, hits]) => hits > 0).length}`,
    'end_of_record',
  ].join('\n');

interface ShardFiles {
  readonly name: string;
  readonly lcovLines?: ReadonlyArray<[number, number]>;
  readonly blob?: string;
  readonly meta?: { shard: number; exitCode: number; durationSeconds: number };
  readonly unhandledErrors?: { errors: number; headlines: [] };
}

const writeShards = async (root: string, shards: readonly ShardFiles[]): Promise<void> => {
  for (const shard of shards) {
    const dir = join(root, shard.name);
    if (shard.lcovLines) {
      for (const lcovPath of Object.values(SHARDED_LCOV_PATHS)) {
        await Bun.write(join(dir, lcovPath), lcov(shard.lcovLines));
      }
    }
    if (shard.blob) await Bun.write(join(dir, VITEST_BLOB_DIR, shard.blob), '{}');
    if (shard.meta) await Bun.write(join(dir, 'shard-meta.json'), JSON.stringify(shard.meta));
    if (shard.unhandledErrors) {
      await Bun.write(join(dir, 'unhandled-errors.json'), JSON.stringify(shard.unhandledErrors));
    }
  }
};

describe('summarizeShardMeta', () => {
  it('is green only when every shard was', () => {
    expect(
      summarizeShardMeta([
        { shard: 1, exitCode: 0, durationSeconds: 60 },
        { shard: 2, exitCode: 0, durationSeconds: 70 },
      ])
    ).toEqual({ exitCode: 0, durationSeconds: 70 });
  });

  it('carries the first failing exit code rather than the last shard to finish', () => {
    expect(
      summarizeShardMeta([
        { shard: 1, exitCode: 0, durationSeconds: 60 },
        { shard: 2, exitCode: 7, durationSeconds: 12 },
        { shard: 3, exitCode: 0, durationSeconds: 80 },
      ])
    ).toEqual({ exitCode: 7, durationSeconds: 80 });
  });

  // Duration is the lane's wall clock, not its CPU time: the shards run
  // concurrently, so the slowest one is how long the lane took.
  it('reports the slowest shard, not the sum', () => {
    expect(
      summarizeShardMeta([
        { shard: 1, exitCode: 0, durationSeconds: 40 },
        { shard: 2, exitCode: 0, durationSeconds: 55 },
      ]).durationSeconds
    ).toBe(55);
  });
});

describe('listShardDirs', () => {
  it('lists only directories', async () => {
    const root = await makeTemp();
    await Bun.write(join(root, 'shard-1', 'x'), '');
    await Bun.write(join(root, 'loose.json'), '{}');
    expect(await listShardDirs(root)).toEqual([join(root, 'shard-1')]);
  });

  // The merge job downloads `test-shard-*`, which also matches the
  // `test-shard-<n>-log` failure artifacts. Those directories have no
  // shard-meta or coverage, and counting them inflates the merge.
  it('skips failure-log artifact directories', async () => {
    const root = await makeTemp();
    await Bun.write(join(root, 'test-shard-1', 'shard-meta.json'), '{}');
    await Bun.write(join(root, 'test-shard-1-log', 'coverage-run.log'), 'log');
    expect(await listShardDirs(root)).toEqual([join(root, 'test-shard-1')]);
  });
});

describe('mergeTestShards', () => {
  it('merges coverage, stages blobs, and folds run metadata', async () => {
    const shards = await makeTemp();
    const output = await makeTemp();
    await writeShards(shards, [
      {
        name: 'test-shard-1',
        lcovLines: [
          [1, 4],
          [2, 0],
        ],
        blob: 'blob-1.json',
        meta: { shard: 1, exitCode: 0, durationSeconds: 61 },
        unhandledErrors: { errors: 0, headlines: [] },
      },
      {
        name: 'test-shard-2',
        lcovLines: [
          [1, 0],
          [2, 3],
        ],
        blob: 'blob-2.json',
        meta: { shard: 2, exitCode: 0, durationSeconds: 66 },
        unhandledErrors: { errors: 0, headlines: [] },
      },
    ]);

    const summary = await mergeTestShards(shards, output);
    expect(summary).toMatchObject({ shards: 2, exitCode: 0, durationSeconds: 66 });

    const merged = await parseLcovSummary(join(output, SHARDED_LCOV_PATHS.api));
    expect(merged.lines).toMatchObject({ total: 2, covered: 2 });
    expect(await Bun.file(join(output, VITEST_BLOB_DIR, 'blob-2.json')).exists()).toBe(true);
  });

  // Shard directories sort lexically, so `test-shard-10` lands before
  // `test-shard-2`. Blob names are reassigned on copy rather than derived from
  // that order, so no shard's report is silently overwritten.
  it('stages every blob when there are more than nine shards', async () => {
    const shards = await makeTemp();
    const output = await makeTemp();
    await writeShards(
      shards,
      Array.from({ length: 12 }, (_, index) => ({
        name: `test-shard-${index + 1}`,
        lcovLines: [[1, index]] as ReadonlyArray<[number, number]>,
        blob: `blob-${index + 1}.json`,
        meta: { shard: index + 1, exitCode: 0, durationSeconds: index },
      }))
    );

    const summary = await mergeTestShards(shards, output);
    expect(summary.shards).toBe(12);
    for (let index = 1; index <= 12; index++) {
      expect(await Bun.file(join(output, VITEST_BLOB_DIR, `blob-${index}.json`)).exists()).toBe(
        true
      );
    }
  });

  it('treats a shard that wrote no metadata as failed rather than green', async () => {
    const shards = await makeTemp();
    const output = await makeTemp();
    await writeShards(shards, [
      {
        name: 'test-shard-1',
        lcovLines: [[1, 1]],
        blob: 'blob-1.json',
        meta: { shard: 1, exitCode: 0, durationSeconds: 30 },
      },
      { name: 'test-shard-2', lcovLines: [[1, 1]], blob: 'blob-2.json' },
    ]);
    expect((await mergeTestShards(shards, output)).exitCode).toBe(1);
  });

  it('fails loudly when no shard produced a Vitest blob', async () => {
    const shards = await makeTemp();
    const output = await makeTemp();
    await writeShards(shards, [{ name: 'test-shard-1', lcovLines: [[1, 1]] }]);
    expect(mergeTestShards(shards, output)).rejects.toThrow(/No Vitest blob reports/);
  });

  it('fails loudly when there are no shards at all', async () => {
    const shards = await makeTemp();
    expect(mergeTestShards(shards, await makeTemp())).rejects.toThrow(/No shard directories/);
  });
});

describe('collect-test-metrics degradation', () => {
  const script = join(import.meta.dir, '..', 'qa-gate', 'collect-test-metrics.ts');

  const collect = async (summaryPath: string, shardsRoot?: string, gateExitCode?: string) => {
    const proc = Bun.spawn({
      cmd: [
        'bun',
        script,
        summaryPath,
        ...(shardsRoot ? [shardsRoot] : []),
        ...(gateExitCode === undefined ? [] : [gateExitCode]),
      ],
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return { stdout, exitCode };
  };

  // This step runs under `if: !cancelled()` so a broken merge still produces a
  // fragment for the QA report. A truncated summary is exactly what a merge
  // that died mid-write leaves behind, and throwing here would defeat that.
  it.each([
    ['empty', ''],
    ['truncated', '{"shards": 8, "exit'],
    ['not an object', '[]'],
    ['exitCode only', '{"exitCode":0}'],
    [
      'malformed unhandledErrors',
      '{"shards":8,"exitCode":0,"durationSeconds":1,"unhandledErrors":{"errors":"nope"}}',
    ],
  ])('reports a failing suite rather than throwing on a %s summary', async (_label, contents) => {
    const dir = await makeTemp();
    const summaryPath = join(dir, 'shard-summary.json');
    await Bun.write(summaryPath, contents);

    const { stdout, exitCode } = await collect(summaryPath);
    expect(exitCode).toBe(0);
    const fragment = JSON.parse(stdout) as { tests: { exitCode: number } };
    expect(fragment.tests.exitCode).toBe(1);
  });

  it('reports a failing suite when the summary was never written', async () => {
    const dir = await makeTemp();
    const { stdout, exitCode } = await collect(join(dir, 'missing.json'), join(dir, 'no-shards'));
    expect(exitCode).toBe(0);
    expect((JSON.parse(stdout) as { tests: { exitCode: number } }).tests.exitCode).toBe(1);
  });

  it('accepts a complete summary rather than degrading it', async () => {
    const dir = await makeTemp();
    const summaryPath = join(dir, 'shard-summary.json');
    await Bun.write(
      summaryPath,
      JSON.stringify({
        shards: 8,
        exitCode: 0,
        durationSeconds: 12,
        unhandledErrors: { errors: 0, headlines: [] },
      })
    );

    const { stdout, exitCode } = await collect(summaryPath);
    expect(exitCode).toBe(0);
    expect((JSON.parse(stdout) as { tests: { exitCode: number } }).tests.exitCode).toBe(0);
  });

  // The frontend coverage thresholds moved out of the sharded run and into the
  // merge job, so the shard summary can be all-green while the run is red. If
  // the gate's outcome did not reach the fragment, verdict.ts — which keys
  // entirely on `tests.exitCode` — would render a passing suite on a red CI run.
  it('reports the merge job coverage gate failure on an all-green shard summary', async () => {
    const dir = await makeTemp();
    const summaryPath = join(dir, 'shard-summary.json');
    await Bun.write(
      summaryPath,
      JSON.stringify({
        shards: 8,
        exitCode: 0,
        durationSeconds: 12,
        unhandledErrors: { errors: 0, headlines: [] },
      })
    );

    const { stdout } = await collect(summaryPath, join(dir, 'no-shards'), '1');
    expect((JSON.parse(stdout) as { tests: { exitCode: number } }).tests.exitCode).toBe(1);
  });
});
