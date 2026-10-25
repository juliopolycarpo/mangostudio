import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  expectedLcovShards,
  listShardDirs,
  mergeTestShards,
  ShardSetError,
  summarizeShardMeta,
} from '../ci/merge-test-shards';
import { ROOT_DIR } from '../lib/config';
import { SHARDED_LCOV_PATHS } from '../lib/test-lanes';
import { parseLcovSummary } from '../qa-gate/parse-lcov';
import { receiptText, shardReceipts } from './support/shard-receipt-fixtures';

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
  /** Per-path override of what the shard wrote: `null` leaves the report out, a string replaces its text. */
  readonly lcovOverrides?: Readonly<Record<string, string | null>>;
  readonly meta?: { shard: number | string; exitCode: number; durationSeconds: number };
  readonly unhandledErrors?: { errors: number; headlines: [] };
}

const writeShards = async (root: string, shards: readonly ShardFiles[]): Promise<void> => {
  for (const shard of shards) {
    const dir = join(root, shard.name);
    if (shard.lcovLines) {
      for (const lcovPath of Object.values(SHARDED_LCOV_PATHS)) {
        const override = shard.lcovOverrides?.[lcovPath];
        if (override === null) continue;
        await Bun.write(join(dir, lcovPath), override ?? lcov(shard.lcovLines));
      }
    }
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

  // `shard-meta.json` is read with a cast, not a schema, so valid JSON of the
  // wrong shape arrives with `exitCode: undefined`. Read naively that matches
  // the "failed" predicate and then folds back to 0 — a green suite over a
  // shard that reported nothing — and shadows shard 2's real failure.
  it('treats an unparseable exit code as failed instead of green', () => {
    expect(summarizeShardMeta([{}, { shard: 2, exitCode: 5, durationSeconds: 20 }])).toEqual({
      exitCode: 1,
      durationSeconds: null,
    });
  });

  // Same shape from the other side: Math.max with an absent duration is NaN,
  // which serializes as null and renders as a suite with no wall clock.
  it('keeps an absent legacy duration unavailable rather than reporting measured zero', () => {
    expect(
      summarizeShardMeta([
        { shard: 1, exitCode: 0 },
        { shard: 2, exitCode: 0, durationSeconds: 20 },
      ]).durationSeconds
    ).toBeNull();
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

describe('expectedLcovShards', () => {
  const jobs = ['test-shard-1', 'test-shard-2', 'test-shard-frontend'];

  it('owes a sharded workspace one report per numbered shard and none from the frontend job', () => {
    expect(expectedLcovShards('api', jobs)).toEqual(['test-shard-1', 'test-shard-2']);
    expect(expectedLcovShards('shared', jobs)).toEqual(['test-shard-1', 'test-shard-2']);
  });

  it('owes the unsharded frontend a report from its own job only', () => {
    expect(expectedLcovShards('frontend', jobs)).toEqual(['test-shard-frontend']);
  });
});

describe('mergeTestShards', () => {
  it.each([
    ['wrong producer', { ...shardReceipts.currentPass, shard: 2 }],
    ['missing producer', { ...shardReceipts.currentPass, shard: undefined }],
    ['negative duration', { ...shardReceipts.currentPass, durationSeconds: -1 }],
    ['malformed attempts', { ...shardReceipts.currentPass, attempts: 0 }],
  ])(
    'fails closed for %s evidence while leaving LCOV responsibilities intact',
    async (_name, receipt) => {
      const root = await makeTemp();
      const output = await makeTemp();
      await writeShards(root, [{ name: 'test-shard-1', lcovLines: [[1, 1]] }]);
      await Bun.write(join(root, 'test-shard-1/shard-meta.json'), receiptText(receipt));
      const summary = await mergeTestShards(root, output);
      expect(summary.exitCode).toBe(1);
      expect(summary.durationSeconds).toBeNull();
      expect(summary.coverageErrors?.api).toBeUndefined();
    }
  );

  it('retains earlier findings after a clean retry', async () => {
    const root = await makeTemp();
    const output = await makeTemp();
    await writeShards(root, [{ name: 'test-shard-1', lcovLines: [[1, 1]] }]);
    await Bun.write(
      join(root, 'test-shard-1/shard-meta.json'),
      receiptText(shardReceipts.retainedFindings)
    );
    expect(await mergeTestShards(root, output)).toMatchObject({ exitCode: 1, durationSeconds: 42 });
  });
  it('merges coverage and folds run metadata', async () => {
    const shards = await makeTemp();
    const output = await makeTemp();
    await writeShards(shards, [
      {
        name: 'test-shard-1',
        lcovLines: [
          [1, 4],
          [2, 0],
        ],
        meta: { shard: 1, exitCode: 0, durationSeconds: 61 },
        unhandledErrors: { errors: 0, headlines: [] },
      },
      {
        name: 'test-shard-2',
        lcovLines: [
          [1, 0],
          [2, 3],
        ],
        meta: { shard: 2, exitCode: 0, durationSeconds: 66 },
        unhandledErrors: { errors: 0, headlines: [] },
      },
      {
        name: 'test-shard-frontend',
        lcovLines: [[1, 1]],
        meta: { shard: 'frontend', exitCode: 0, durationSeconds: 40 },
      },
    ]);

    // Two numbered shards plus the separate frontend are the complete job set.
    const summary = await mergeTestShards(shards, output, 3);
    expect(summary).toMatchObject({ shards: 3, exitCode: 0, durationSeconds: 66 });
    expect(summary.coverageErrors).toBeUndefined();

    const merged = await parseLcovSummary(join(output, SHARDED_LCOV_PATHS.api));
    expect(merged.lines).toMatchObject({ total: 2, covered: 2 });
  });

  it('merges the frontend from its own job only, never from the numbered shards', async () => {
    const shards = await makeTemp();
    const output = await makeTemp();
    await writeShards(shards, [
      {
        name: 'test-shard-1',
        lcovLines: [[1, 0]],
        meta: { shard: 1, exitCode: 0, durationSeconds: 1 },
      },
      {
        name: 'test-shard-frontend',
        lcovLines: [[1, 1]],
        meta: { shard: 'frontend', exitCode: 0, durationSeconds: 1 },
      },
    ]);

    const summary = await mergeTestShards(shards, output);

    expect(summary.coverageErrors).toBeUndefined();
    const frontend = await parseLcovSummary(join(output, SHARDED_LCOV_PATHS.frontend));
    expect(frontend.lines).toMatchObject({ total: 1, covered: 1 });
  });

  // Each of these used to skip the missing input and merge the rest, so a
  // shard that never delivered its report read as a slightly lower, complete
  // number. Now the workspace is reported with the shard's name and its merged
  // file does not exist for the collector to read.
  describe('coverage of a shard that did not deliver', () => {
    const twoShardsAndFrontend = (shard2: Partial<ShardFiles>): ShardFiles[] => [
      {
        name: 'test-shard-1',
        lcovLines: [[1, 1]],
        meta: { shard: 1, exitCode: 0, durationSeconds: 1 },
      },
      {
        name: 'test-shard-2',
        lcovLines: [[1, 1]],
        meta: { shard: 2, exitCode: 0, durationSeconds: 1 },
        ...shard2,
      },
      {
        name: 'test-shard-frontend',
        lcovLines: [[1, 1]],
        meta: { shard: 'frontend', exitCode: 0, durationSeconds: 1 },
      },
    ];

    it('names the shard whose report is missing and leaves only that workspace unavailable', async () => {
      const shards = await makeTemp();
      const output = await makeTemp();
      await writeShards(
        shards,
        twoShardsAndFrontend({ lcovOverrides: { [SHARDED_LCOV_PATHS.shared]: null } })
      );

      const summary = await mergeTestShards(shards, output);

      expect(Object.keys(summary.coverageErrors ?? {})).toEqual(['shared']);
      expect(summary.coverageErrors?.shared).toContain('shard test-shard-2: missing report');
      expect(await Bun.file(join(output, SHARDED_LCOV_PATHS.shared)).exists()).toBe(false);
      expect(await Bun.file(join(output, SHARDED_LCOV_PATHS.api)).exists()).toBe(true);
      expect(await Bun.file(join(output, SHARDED_LCOV_PATHS.frontend)).exists()).toBe(true);
    });

    it('names the shard whose report was truncated', async () => {
      const shards = await makeTemp();
      const output = await makeTemp();
      await writeShards(
        shards,
        twoShardsAndFrontend({
          lcovOverrides: { [SHARDED_LCOV_PATHS.api]: lcov([[1, 1]]).replace('end_of_record', '') },
        })
      );

      const summary = await mergeTestShards(shards, output);

      expect(summary.coverageErrors?.api).toContain(
        'shard test-shard-2: truncated: record for src/a.ts has no end_of_record'
      );
    });

    it('reports a frontend job that uploaded no report under its own name', async () => {
      const shards = await makeTemp();
      const output = await makeTemp();
      await writeShards(shards, [
        {
          name: 'test-shard-1',
          lcovLines: [[1, 1]],
          meta: { shard: 1, exitCode: 0, durationSeconds: 1 },
        },
      ]);

      const summary = await mergeTestShards(shards, output);

      expect(summary.coverageErrors?.frontend).toContain(
        'shard test-shard-frontend: missing report'
      );
      expect(summary.coverageErrors?.api).toBeUndefined();
    });

    it('removes a merged file a previous run left behind when this merge fails', async () => {
      const shards = await makeTemp();
      const output = await makeTemp();
      await Bun.write(join(output, SHARDED_LCOV_PATHS.shared), lcov([[1, 1]]));
      await writeShards(
        shards,
        twoShardsAndFrontend({ lcovOverrides: { [SHARDED_LCOV_PATHS.shared]: null } })
      );

      await mergeTestShards(shards, output);

      expect(await Bun.file(join(output, SHARDED_LCOV_PATHS.shared)).exists()).toBe(false);
    });

    it('removes every staged file when the uploaded job set is itself incomplete', async () => {
      const shards = await makeTemp();
      const output = await makeTemp();
      await Bun.write(join(output, SHARDED_LCOV_PATHS.api), lcov([[1, 1]]));
      await writeShards(shards, [{ name: 'test-shard-1', lcovLines: [[1, 1]] }]);

      await expect(mergeTestShards(shards, output, 9)).rejects.toBeInstanceOf(ShardSetError);

      expect(await Bun.file(join(output, SHARDED_LCOV_PATHS.api)).exists()).toBe(false);
    });
  });

  // The frontend job uploads the same artifact shape as a numbered shard, with
  // a string id in its meta; the fold must treat it like any other job.
  it('folds the frontend job meta alongside the numbered shards', async () => {
    const shards = await makeTemp();
    const output = await makeTemp();
    await writeShards(shards, [
      {
        name: 'test-shard-1',
        lcovLines: [[1, 1]],
        meta: { shard: 1, exitCode: 0, durationSeconds: 30 },
      },
      {
        name: 'test-shard-frontend',
        lcovLines: [[1, 1]],
        meta: { shard: 'frontend', exitCode: 3, durationSeconds: 45 },
      },
    ]);
    expect(await mergeTestShards(shards, output)).toMatchObject({
      shards: 2,
      exitCode: 3,
      durationSeconds: 45,
    });
  });

  it('treats a shard that wrote no metadata as failed rather than green', async () => {
    const shards = await makeTemp();
    const output = await makeTemp();
    await writeShards(shards, [
      {
        name: 'test-shard-1',
        lcovLines: [[1, 1]],
        meta: { shard: 1, exitCode: 0, durationSeconds: 30 },
      },
      { name: 'test-shard-2', lcovLines: [[1, 1]] },
    ]);
    expect((await mergeTestShards(shards, output)).exitCode).toBe(1);
  });

  it('fails loudly when there are no shards at all', async () => {
    const shards = await makeTemp();
    await expect(mergeTestShards(shards, await makeTemp())).rejects.toThrow(/No shard directories/);
  });

  // A shard job that dies before "Upload shard results" runs (runner OOM, a
  // cancelled/timed-out job) leaves its directory missing, not empty, so the
  // remaining shards can merge clean and green over an incomplete file set.
  it('fails loudly when fewer shards uploaded than expected', async () => {
    const shards = await makeTemp();
    const output = await makeTemp();
    await writeShards(shards, [
      {
        name: 'test-shard-1',
        lcovLines: [[1, 1]],
        meta: { shard: 1, exitCode: 0, durationSeconds: 30 },
      },
    ]);
    await expect(mergeTestShards(shards, output, 8)).rejects.toThrow(
      /Expected 8 test-job directories/
    );
  });

  // Same count, wrong identities: shard 2 never uploaded and a stray shard 3
  // did. The count alone would wave that through.
  it('rejects a right-sized set with the wrong directories, naming both sides', async () => {
    const shards = await makeTemp();
    await writeShards(shards, [
      { name: 'test-shard-1', lcovLines: [[1, 1]] },
      { name: 'test-shard-3', lcovLines: [[1, 1]] },
      { name: 'test-shard-frontend', lcovLines: [[1, 1]] },
    ]);
    await expect(mergeTestShards(shards, await makeTemp(), 3)).rejects.toThrow(
      /found 3; missing: test-shard-2; unexpected: test-shard-3\./
    );
  });

  it('names the job directories that never uploaded', async () => {
    const shards = await makeTemp();
    await writeShards(shards, [
      { name: 'test-shard-1', lcovLines: [[1, 1]] },
      { name: 'test-shard-3', lcovLines: [[1, 1]] },
      { name: 'test-shard-frontend', lcovLines: [[1, 1]] },
    ]);
    await expect(mergeTestShards(shards, await makeTemp(), 4)).rejects.toThrow(
      /found 3; missing: test-shard-2\b/
    );
  });

  it('accepts a full shard set when an expected count is given', async () => {
    const shards = await makeTemp();
    const output = await makeTemp();
    await writeShards(shards, [
      {
        name: 'test-shard-1',
        lcovLines: [[1, 1]],
        meta: { shard: 1, exitCode: 0, durationSeconds: 30 },
      },
      {
        name: 'test-shard-frontend',
        lcovLines: [[1, 1]],
        meta: { shard: 'frontend', exitCode: 0, durationSeconds: 30 },
      },
    ]);
    const summary = await mergeTestShards(shards, output, 2);
    expect(summary.shards).toBe(2);
    expect(summary.coverageErrors).toBeUndefined();
  });
});

describe('merge-test-shards CLI verdict', () => {
  it.each([
    ['passing receipt', receiptText(shardReceipts.currentPass), 0, 0],
    ['failing receipt', receiptText({ ...shardReceipts.currentPass, exitCode: 7 }), 7, 1],
    ['invalid receipt', '{}', 1, 1],
    ['wrong producer', receiptText({ ...shardReceipts.currentPass, shard: 2 }), 1, 1],
    ['retained findings', receiptText(shardReceipts.retainedFindings), 1, 1],
  ])('enforces a %s after emitting its summary', async (_name, receipt, verdict, status) => {
    // Run the shipped CLI in an isolated checkout so its coverage writes cannot
    // replace the developer's reports or those of a concurrent test lane.
    const root = await makeTemp();
    const script = 'scripts/ci/merge-test-shards.ts';
    for (const path of [
      script,
      'scripts/lib/config.ts',
      'scripts/lib/shard-receipt.ts',
      'scripts/lib/test-lanes.ts',
      'scripts/lib/log-lines.ts',
      'scripts/qa-gate/merge-lcov-shards.ts',
      'scripts/qa-gate/unhandled-errors.ts',
    ]) {
      await Bun.write(join(root, path), Bun.file(join(ROOT_DIR, path)));
    }
    const shards = join(root, 'shards');
    await writeShards(shards, [
      { name: 'test-shard-1', lcovLines: [[1, 1]] },
      {
        name: 'test-shard-frontend',
        lcovLines: [[1, 1]],
        meta: { shard: 'frontend', exitCode: 0, durationSeconds: 30 },
      },
    ]);
    await Bun.write(join(shards, 'test-shard-1/shard-meta.json'), receipt);
    const proc = Bun.spawn({
      cmd: ['bun', join(root, script), shards, '1'],
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    const summary = JSON.parse(stdout);
    expect(summary.exitCode).toBe(verdict);
    expect(summary.coverageErrors).toBeUndefined();
    expect(stderr).toContain(`Merged 2 shard(s): exit ${verdict}`);
    expect(exitCode).toBe(status);
  });
});

describe('collect-test-metrics degradation', () => {
  const script = join(import.meta.dir, '..', 'qa-gate', 'collect-test-metrics.ts');

  const collect = async (summaryPath: string, shardsRoot?: string) => {
    const proc = Bun.spawn({
      cmd: ['bun', script, summaryPath, ...(shardsRoot ? [shardsRoot] : [])],
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return { stdout, exitCode };
  };

  // On a checkout with real coverage artifacts the collector also derives
  // frontend statement/branch coverage from the sources, which alone takes
  // ~4s — hence the explicit per-test timeout on every spawn below.
  const COLLECT_TIMEOUT = 20_000;

  // This step runs under `if: !cancelled()` so a broken merge still produces a
  // fragment for the QA report. A truncated summary is exactly what a merge
  // that died mid-write leaves behind, and throwing here would defeat that.
  it.each([
    ['empty', ''],
    ['truncated', '{"shards": 8, "exit'],
    ['not an object', '[]'],
    ['exitCode only', '{"exitCode":0}'],
    ['negative exitCode', '{"shards":8,"exitCode":-1,"durationSeconds":1}'],
    ['negative duration', '{"shards":8,"exitCode":0,"durationSeconds":-1}'],
    ['fractional shard count', '{"shards":1.5,"exitCode":0,"durationSeconds":1}'],
    [
      'malformed unhandledErrors',
      '{"shards":8,"exitCode":0,"durationSeconds":1,"unhandledErrors":{"errors":"nope"}}',
    ],
  ])(
    'reports a failing suite rather than throwing on a %s summary',
    async (_label, contents) => {
      const dir = await makeTemp();
      const summaryPath = join(dir, 'shard-summary.json');
      await Bun.write(summaryPath, contents);

      const { stdout, exitCode } = await collect(summaryPath);
      expect(exitCode).toBe(0);
      const fragment = JSON.parse(stdout) as { tests: { value: { exitCode: number } } };
      expect(fragment.tests.value.exitCode).toBe(1);
    },
    COLLECT_TIMEOUT
  );

  interface CollectedFragment {
    coverage: Record<string, { state: string; reasons?: string[] }>;
    tests: { value: { exitCode: number } };
  }

  // The merge names the shard; the fragment must carry that reason as
  // `unavailable`, not read a leftover file or fall back to a lower number.
  it(
    'marks a workspace whose shard merge failed unavailable with the shard named',
    async () => {
      const dir = await makeTemp();
      const summaryPath = join(dir, 'shard-summary.json');
      const reason = 'Merging api coverage failed: shard test-shard-3: missing report at x';
      await Bun.write(
        summaryPath,
        JSON.stringify({
          shards: 9,
          exitCode: 0,
          durationSeconds: 12,
          unhandledErrors: { errors: 0, headlines: [] },
          coverageErrors: { api: reason },
        })
      );

      const { stdout } = await collect(summaryPath);

      const fragment = JSON.parse(stdout) as CollectedFragment;
      expect(fragment.coverage.api).toEqual({ state: 'unavailable', reasons: [reason] });
      expect(fragment.tests.value.exitCode).toBe(0);
    },
    COLLECT_TIMEOUT
  );

  it(
    'rejects a summary whose coverageErrors is not a reason per workspace',
    async () => {
      const dir = await makeTemp();
      const summaryPath = join(dir, 'shard-summary.json');
      await Bun.write(
        summaryPath,
        JSON.stringify({
          shards: 9,
          exitCode: 0,
          durationSeconds: 12,
          coverageErrors: { api: 3 },
        })
      );

      const { stdout } = await collect(summaryPath);

      expect((JSON.parse(stdout) as CollectedFragment).tests.value.exitCode).toBe(1);
    },
    COLLECT_TIMEOUT
  );

  it(
    'reports a failing suite when the summary was never written',
    async () => {
      const dir = await makeTemp();
      const { stdout, exitCode } = await collect(join(dir, 'missing.json'), join(dir, 'no-shards'));
      expect(exitCode).toBe(0);
      expect(
        (JSON.parse(stdout) as { tests: { value: { exitCode: number } } }).tests.value.exitCode
      ).toBe(1);
    },
    COLLECT_TIMEOUT
  );

  it(
    'accepts a complete summary rather than degrading it',
    async () => {
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
      expect(
        (JSON.parse(stdout) as { tests: { value: { exitCode: number } } }).tests.value.exitCode
      ).toBe(0);
    },
    COLLECT_TIMEOUT
  );

  it.each([0, null])(
    'preserves duration %s in the metrics fragment',
    async (durationSeconds) => {
      const dir = await makeTemp();
      const summaryPath = join(dir, 'shard-summary.json');
      await Bun.write(summaryPath, JSON.stringify({ shards: 8, exitCode: 0, durationSeconds }));
      const { stdout } = await collect(summaryPath);
      const fragment = JSON.parse(stdout) as {
        tests: { value: { exitCode: number; durationSeconds: number | null } };
      };
      expect(fragment.tests.value.exitCode).toBe(0);
      expect(fragment.tests.value.durationSeconds).toBe(durationSeconds);
    },
    COLLECT_TIMEOUT
  );
});
