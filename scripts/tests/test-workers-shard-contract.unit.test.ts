/**
 * The runner leaves the file split to `bun test --shard=i/N` (or hands each worker
 * explicit `./path` files, for a lane with weights) and checks the
 * result, so the split has to be what the check assumes: deterministic, every
 * file in exactly one shard, and the same files `discoverTestFiles` counts.
 * This runs real Bun over a throwaway tree, so a Bun release that changes any
 * of it fails here rather than as a lane that quietly skips a file.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { parseJunitXml } from '../lib/junit-report';
import { discoverTestFiles } from '../lib/test-workers';
import { readPidFile, signalPid } from './support/signal-pid';

const TEST_DIR = 'tests/unit';
// One file per name and extension pattern Bun runs, in nested and flat places.
const FILE_NAMES = [
  'a.test.ts',
  'b.test.ts',
  'c.test.ts',
  'd.test.ts',
  'e.test.ts',
  'deep/f.test.ts',
  'deep/er/g.test.ts',
  'deep/er/h.spec.ts',
  'deep/i_test.ts',
  'deep/j_spec.ts',
  'deep/k.test.ts',
  'deep/k.test.tsx',
  'deep/l.test.js',
  'deep/m.test.jsx',
  'deep/n.test.mjs',
  'deep/o.test.cjs',
  'deep/p.test.mts',
  'deep/q.test.cts',
];

let root = '';

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'mangostudio-shard-contract-'));
  FILE_NAMES.forEach((name, position) => {
    const path = join(root, TEST_DIR, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      `import { expect, test } from 'bun:test';\ntest('${name} a', () => expect(${position}).toBe(${position}));\ntest('${name} b', () => expect(1).toBe(1));\n`
    );
  });
  writeFileSync(join(root, TEST_DIR, 'helper.ts'), 'export const helper = 1;\n');
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

/** The files whose cases `bun test` reported, as the report spells them, in the order it ran them. */
function reportedFiles(
  label: string,
  flags: readonly string[],
  selection: readonly string[]
): string[] {
  const outfile = join(root, `${label}.xml`);
  const run = Bun.spawnSync(
    [
      process.execPath,
      'test',
      '--reporter=junit',
      `--reporter-outfile=${outfile}`,
      ...flags,
      ...selection,
    ],
    { cwd: root, stdout: 'pipe', stderr: 'pipe' }
  );
  expect(
    run.exitCode,
    `expected bun test ${flags.join(' ')} exit: 0 | received: ${run.exitCode} | ${run.stderr.toString()}`
  ).toBe(0);
  const files = parseJunitXml(readFileSync(outfile, 'utf8')).cases.flatMap((reported) =>
    reported.file ? [reported.file.replaceAll('\\', '/')] : []
  );
  return [...new Set(files)];
}

/** The files whose cases `bun test` reported, sorted, for the lane directory and `flags`. */
const filesOfRun = (label: string, ...flags: string[]): string[] =>
  reportedFiles(label, flags, [TEST_DIR]).sort();

/** Like {@link filesOfRun}, for the files or filters given in place of the lane directory. */
const filesOfArguments = (
  label: string,
  flags: readonly string[],
  selection: readonly string[]
): string[] => reportedFiles(label, flags, selection).sort();

describe('bun test --shard', () => {
  it('runs exactly the files discoverTestFiles counts', () => {
    expect(filesOfRun('whole')).toEqual(discoverTestFiles(root, TEST_DIR));
  });

  for (const count of [2, 3, 4, 8]) {
    it(`splits ${FILE_NAMES.length} files across ${count} shards, each file once`, () => {
      const shards = Array.from({ length: count }, (_, offset) =>
        filesOfRun(`n${count}-${offset + 1}`, `--shard=${offset + 1}/${count}`)
      );

      const claimed = shards.flat();
      const everything = discoverTestFiles(root, TEST_DIR);
      expect(
        [...claimed].sort(),
        `expected the ${count} shards to run every file once | received ${claimed.length} runs of ${new Set(claimed).size} files`
      ).toEqual(everything);
      expect(shards.every((files) => files.length > 0)).toBe(true);
    });

    it(`gives the same split on a second run at ${count} shards`, () => {
      const first = Array.from({ length: count }, (_, offset) =>
        filesOfRun(`again${count}-${offset + 1}`, `--shard=${offset + 1}/${count}`)
      );
      const second = Array.from({ length: count }, (_, offset) =>
        filesOfRun(`once${count}-${offset + 1}`, `--shard=${offset + 1}/${count}`)
      );
      expect(second).toEqual(first);
    });
  }
});

// A weighted lane hands each worker `./path` arguments (see `planWorkers`). A
// bare argument is a substring filter, so `a.test.ts` would also select
// `a.test.tsx`; a `./` one has to select its own file and nothing else.
describe('bun test with ./path arguments', () => {
  const named = (files: readonly string[]): string[] => files.map((file) => `./${file}`);

  it('selects the one file named, not a file whose path merely contains it', () => {
    const lone = `${TEST_DIR}/deep/k.test.ts`;

    expect(
      filesOfArguments('lone-prefix', [], named([lone])),
      `expected ./${lone} to select only ${lone}, not ${lone}x`
    ).toEqual([lone]);
  });

  // An unisolated lane's files share a module graph, so the order they run in
  // decides what each inherits. The runner passes each worker's files in path
  // order; this pins that Bun then runs them in the order given and not in an
  // order of its own, which would make the per-worker sort a no-op.
  it.each([
    ['path order', (files: string[]) => files],
    ['reverse path order', (files: string[]) => [...files].reverse()],
  ])('runs the files in the order they are given: %s', (label, arrange) => {
    const group = discoverTestFiles(root, TEST_DIR).filter((_, at) => at % 2 === 0);
    const given = arrange(group);

    expect(
      reportedFiles(`order-${label.replaceAll(' ', '-')}`, [], named(given)),
      `expected bun test to run ${given.length} files in the order given | received: another order`
    ).toEqual(given);
  });

  it('selects nothing for a prefix of a file name', () => {
    const run = Bun.spawnSync([process.execPath, 'test', `./${TEST_DIR}/deep/k.te`], {
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
    });

    expect(run.exitCode, 'expected a path prefix to select no file and fail').not.toBe(0);
    expect(run.stderr.toString()).toContain('had no matches');
  });

  it('runs the files of every group once when the lane is split into explicit groups', () => {
    const everything = discoverTestFiles(root, TEST_DIR);
    const groups = [
      everything.filter((_, at) => at % 3 === 0),
      everything.filter((_, at) => at % 3 === 1),
      everything.filter((_, at) => at % 3 === 2),
    ];

    const ran = groups.map((group, at) => filesOfArguments(`explicit-${at}`, [], named(group)));

    expect(ran).toEqual(groups.map((group) => [...group].sort()));
    expect(ran.flat().sort()).toEqual(everything);
  });
});

describe('bun test --no-orphans', () => {
  const isAlive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  /** Polls until `ready()` or the deadline; returns whether it became true. */
  async function until(ready: () => boolean, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (ready()) return true;
      await Bun.sleep(25);
    }
    return ready();
  }

  // The runner ends a cancelled worker with a SIGKILL that no launcher can pass
  // on, and relies on this flag for the `bun test` behind the launcher to go too,
  // along with what its tests started. Under `--parallel=1` the files run in that
  // process itself (there is no separate test worker), so the descendant to reap
  // is a process a test spawned, such as the runtime child many API tests start.
  it.skipIf(process.platform === 'win32')(
    'takes the process that ran the tests and a child a test started down with the launcher',
    async () => {
      const dir = join(root, 'hang');
      mkdirSync(dir, { recursive: true });
      const coordinatorFile = join(dir, 'coordinator.pid');
      const runnerFile = join(dir, 'runner.pid');
      const childFile = join(dir, 'child.pid');
      // The hanging test records the pid of the process that runs it and of a
      // child it starts, then waits for the end.
      writeFileSync(
        join(dir, 'hang.test.ts'),
        `import { test } from 'bun:test';\nimport { writeFileSync } from 'node:fs';\n` +
          `test('hangs', async () => {\n` +
          `  const child = Bun.spawn({ cmd: [process.execPath, '-e', 'setInterval(() => undefined, 1000)'], stdout: 'ignore', stderr: 'ignore' });\n` +
          `  writeFileSync(${JSON.stringify(childFile)}, String(child.pid));\n` +
          `  writeFileSync(${JSON.stringify(runnerFile)}, String(process.pid));\n` +
          `  await new Promise(() => setInterval(() => undefined, 1000));\n}, 600000);\n`
      );
      // The stand-in launcher: starts bun test, reports its pid, waits for it.
      const launcher = Bun.spawn({
        cmd: [
          'bash',
          '-c',
          `"${process.execPath}" test --no-orphans --parallel=1 --timeout 600000 hang/hang.test.ts & echo $! > "${coordinatorFile}"; wait`,
        ],
        cwd: root,
        stdout: 'ignore',
        stderr: 'ignore',
      });

      const started = await until(
        // Non-empty, not just present: `writeFileSync` creates the file before it writes the pid.
        () =>
          [coordinatorFile, runnerFile, childFile].every(
            (file) => existsSync(file) && readFileSync(file, 'utf8').trim() !== ''
          ),
        20_000
      );
      const pidOf = (file: string): number => (started ? readPidFile(file) : 0);
      const pids = [...new Set([coordinatorFile, runnerFile, childFile].map(pidOf))];
      try {
        expect(
          started,
          'expected the hanging test to be running | received: it never started'
        ).toBe(true);
        expect(
          pids.filter(isAlive),
          `expected every process of the run to be alive before the kill | received alive: ${pids.filter(isAlive)} of ${pids}`
        ).toEqual(pids);

        launcher.kill('SIGKILL');

        const gone = await until(() => pids.every((pid) => !isAlive(pid)), 10_000);
        expect(
          gone,
          `expected bun test and the child its test started (pids ${pids}) to exit with their launcher | received alive: ${pids.filter(isAlive)}`
        ).toBe(true);
      } finally {
        for (const pid of pids) {
          if (pid > 0 && isAlive(pid)) signalPid(pid, 'SIGKILL');
        }
      }
    },
    // Longer than the two waits inside it, so a failure reports itself.
    40_000
  );
});
