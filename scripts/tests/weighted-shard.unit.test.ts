/**
 * The CI coverage shards of the api-integration lane split by tracked weight.
 * Nothing here times anything: the split is a function of the file list and
 * `LANE_WEIGHTS`, both committed, so these checks pin what that function must
 * give for the commit under test — the same partition every time, every file in
 * exactly one shard, and shard totals close to the mean.
 */
import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ROOT_DIR } from '../lib/config';
import { laneById } from '../lib/test-lanes';
import {
  DEFAULT_FILE_WEIGHT,
  laneCensus,
  laneSpec,
  partitionByWeight,
  planWorkers,
} from '../lib/test-workers';
import { weightedShard } from '../lib/weighted-shard';
import { readText } from './support/read-text';

const apiScripts = (
  JSON.parse(readText('apps/api/package.json')) as {
    scripts: Record<string, string>;
  }
).scripts;

/** The lane command as the package script spells it, after the wrapper's `--`. */
const COVERAGE_SCRIPT = apiScripts['test:coverage:integration'] ?? '';
const COVERAGE_COMMAND = COVERAGE_SCRIPT.slice(COVERAGE_SCRIPT.indexOf('-- ') + 3)
  .split(/\s+/)
  // The shell expands the variable: empty for a whole run, `--shard=i/N` in a shard.
  .filter((token) => token !== '$MANGOSTUDIO_BUN_TEST_ARGS');

const lane = laneById('api-integration');
const spec = laneSpec(lane, COVERAGE_COMMAND, undefined, 'linux');
const census = laneCensus(spec);
const weights = spec.weights ?? {};
const weightOf = (file: string): number => weights[file] ?? DEFAULT_FILE_WEIGHT;
const heaviest = Math.max(...Object.values(weights));

/** The command a shard runs, with `$MANGOSTUDIO_BUN_TEST_ARGS` expanded. */
const shardCommand = (index: number, count: number): string[] => [
  ...COVERAGE_COMMAND.slice(0, -1),
  `--shard=${index}/${count}`,
  COVERAGE_COMMAND.at(-1) ?? '',
];

const shardLoads = (count: number): number[] =>
  Array.from({ length: count }, (_, offset) =>
    (weightedShard(spec, shardCommand(offset + 1, count), census).files ?? []).reduce(
      (sum, file) => sum + weightOf(file),
      0
    )
  );

/** The shard count the Test workflow fans out to. */
const workflowShardCount = (): number => {
  const declared = /^ {2}SHARD_COUNT: (\d+)$/m.exec(readText('.github/workflows/test.yml'))?.[1];
  if (!declared)
    throw new Error('expected SHARD_COUNT in .github/workflows/test.yml | received: none');
  return Number(declared);
};

describe('weightedShard on the api-integration lane', () => {
  it('runs the weighted wrapper in the coverage script and keeps the variable and directory', () => {
    expect(COVERAGE_SCRIPT).toContain('run-weighted-shard.ts --lane=api-integration -- ');
    expect(COVERAGE_COMMAND.at(-1)).toBe('tests/integration');
    expect(COVERAGE_SCRIPT).toContain('$MANGOSTUDIO_BUN_TEST_ARGS tests/integration');
  });

  it('leaves a whole-lane command alone', () => {
    const whole = weightedShard(spec, COVERAGE_COMMAND, census);
    expect(whole).toEqual({ command: COVERAGE_COMMAND, shard: null, files: null });
  });

  it('leaves a lane without tracked weights on Bun --shard', () => {
    const command = ['bun', 'test', '--shard=1/2', 'tests/unit'];
    expect(weightedShard({ ...spec, weights: undefined }, command, census).command).toBe(command);
  });

  it.each([...new Set([2, 3, 4, 8, workflowShardCount()])])(
    'gives every file to exactly one of %i shards and leaves no --shard behind',
    (count) => {
      const placed: string[] = [];
      for (let index = 1; index <= count; index += 1) {
        const planned = weightedShard(spec, shardCommand(index, count), census);
        expect(
          planned.command,
          `(shard ${index}/${count}): expected no --shard argument next to explicit files | received: ${planned.command.join(' ')}`
        ).not.toContain(`--shard=${index}/${count}`);
        expect(planned.command.at(-1)).toStartWith('./tests/integration/');
        expect(planned.command).not.toContain('tests/integration');
        placed.push(...(planned.files ?? []));
      }
      expect(
        placed.sort(),
        `(${count} shards): expected each of ${census.length} files in exactly one shard | received: ${placed.length} placements`
      ).toEqual(census);
    }
  );

  it.each([2, workflowShardCount()])(
    'gives a retried shard the partition of its first attempt (%i shards)',
    (count) => {
      // Only committed data goes in, so a second call, a retry on another
      // machine, and a differently ordered file listing all agree.
      for (let index = 1; index <= count; index += 1) {
        const first = weightedShard(spec, shardCommand(index, count), census);
        expect(weightedShard(spec, shardCommand(index, count), census)).toEqual(first);
        expect(weightedShard(spec, shardCommand(index, count), [...census].reverse())).toEqual(
          first
        );
      }
    }
  );

  it.each([2, 3, 4, 5, 6, 7, 8, workflowShardCount()])(
    'balances %i shards within the heaviest file and within 5% of the mean',
    (count) => {
      const loads = shardLoads(count);
      const total = loads.reduce((sum, load) => sum + load, 0);
      const mean = total / count;
      const detail = `shard totals ${JSON.stringify(loads)} of ${total} (mean ${mean.toFixed(1)}, heaviest file ${heaviest})`;

      // Holds for any least-loaded-first split: the last file placed went to the
      // lightest shard, so no shard exceeds another by more than one file.
      expect(
        Math.max(...loads) - Math.min(...loads),
        `(${count} shards): expected spread <= ${heaviest} | received ${detail}`
      ).toBeLessThanOrEqual(heaviest);
      // The current file set: 352 weight split two ways is 176 and 176. A miss
      // means the weights went stale against the file set; refresh them (see
      // scripts/lib/test-lane-weights.ts) or revisit this bound.
      expect(
        Math.max(...loads),
        `(${count} shards): expected max <= 1.05 x mean | received ${detail}`
      ).toBeLessThanOrEqual(mean * 1.05);
    }
  );

  it('splits the way the local worker runner does at the same width', () => {
    // `MANGO_TEST_WORKERS=2 bun run test:integration` and CI shards 1 and 2 of 2
    // put the same files together, so a cross-file leak reproduces locally.
    const reportDir = mkdtempSync(join(tmpdir(), 'mangostudio-weighted-shard-'));
    try {
      const serial = (apiScripts['test:integration'] ?? '').split(' -- ')[1]?.split(/\s+/) ?? [];
      const workers = planWorkers(laneSpec(lane, serial, undefined, 'linux'), 2, reportDir, census);
      for (const worker of workers) {
        const planned = weightedShard(spec, shardCommand(worker.index, 2), census);
        expect(planned.files).toEqual(worker.files);
      }
    } finally {
      rmSync(reportDir, { recursive: true, force: true });
    }
  });

  it('reports the split the tracked weights give at the workflow shard count', () => {
    const count = workflowShardCount();
    expect(shardLoads(count)).toEqual(
      partitionByWeight(census, weights, count).map((group) =>
        group.reduce((sum, file) => sum + weightOf(file), 0)
      )
    );
  });

  describe('refuses what it cannot split safely', () => {
    it.each([
      [
        'a malformed shard',
        ['bun', 'test', '--shard=x', 'tests/integration'],
        "Invalid --shard value: 'x'",
      ],
      [
        'a shard past the count',
        ['bun', 'test', '--shard=3/2', 'tests/integration'],
        'Invalid --shard index: 3',
      ],
      [
        'two shard arguments',
        ['bun', 'test', '--shard=1/2', '--shard=2/2', 'tests/integration'],
        'expected one --shard=<index>/<count> argument',
      ],
      [
        'a space-separated shard',
        ['bun', 'test', '--shard', '1/2', 'tests/integration'],
        'expected one --shard=<index>/<count> argument',
      ],
      [
        'a command that does not end in the lane directory',
        ['bun', 'test', '--shard=1/2', 'tests/integration', '--bail'],
        'expected the command to end with tests/integration | received: "--bail"',
      ],
    ])('%s', (_name, command, message) => {
      expect(() => weightedShard(spec, command, census)).toThrow(message);
    });

    it('a shard that would get no file, which would run the whole working directory', () => {
      expect(() =>
        weightedShard(
          spec,
          ['bun', 'test', '--shard=3/3', 'tests/integration'],
          ['tests/integration/a.test.ts', 'tests/integration/b.test.ts']
        )
      ).toThrow('expected at least one file per shard | received: 2 files for shard 3/3');
    });
  });
});

describe('run-weighted-shard', () => {
  const runner = join(ROOT_DIR, 'scripts', 'run-weighted-shard.ts');

  /** Named fake for `bun test`: prints the arguments it was given and exits as told. */
  const withFakeBunTest = async (
    exitCode: number,
    check: (fake: string) => Promise<void>
  ): Promise<void> => {
    const dir = mkdtempSync(join(tmpdir(), 'mangostudio-weighted-shard-fake-'));
    const fake = join(dir, 'fake-bun-test.ts');
    writeFileSync(
      fake,
      `console.log('FAKE-ARGS ' + JSON.stringify(process.argv.slice(2))); process.exit(${exitCode});`
    );
    try {
      await check(fake);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  const invoke = async (command: readonly string[]) => {
    const child = Bun.spawn({
      cmd: [process.execPath, runner, '--lane=api-integration', '--', ...command],
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { stdout, stderr, code };
  };

  it('hands the command its shard files in place of --shard and the directory, and keeps its exit code', async () => {
    await withFakeBunTest(7, async (fake) => {
      const { stdout, code } = await invoke([
        process.execPath,
        fake,
        '--bail',
        '--shard=2/2',
        'tests/integration',
      ]);
      const args = JSON.parse(/FAKE-ARGS (.*)/.exec(stdout)?.[1] ?? 'null') as string[] | null;
      const expected = weightedShard(
        spec,
        ['bun', 'test', '--shard=2/2', 'tests/integration'],
        census
      );

      expect(code, `expected the command's exit code: 7 | received: ${code}`).toBe(7);
      expect(args).toEqual(['--bail', ...(expected.files ?? []).map((file) => `./${file}`)]);
    });
  });

  it('fails the step on a bad shard argument and never starts the command', async () => {
    await withFakeBunTest(0, async (fake) => {
      const { stdout, stderr, code } = await invoke([
        process.execPath,
        fake,
        '--shard=9/2',
        'tests/integration',
      ]);

      expect(code).toBe(1);
      expect(stderr).toContain('Invalid --shard index: 9');
      expect(stdout).not.toContain('FAKE-ARGS');
    });
  });
});
