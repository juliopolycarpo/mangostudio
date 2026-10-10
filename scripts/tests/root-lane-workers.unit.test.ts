/**
 * The root scripts lane as one worker-split lane: what its plain script runs,
 * what the coverage script keeps doing, what the runner makes of a lane with
 * this tree, and what Turbo hashes for it. The worker verdict itself is
 * tested in test-workers.unit.test.ts; here the lane is the real `root` one,
 * so the file census is the real `scripts/` tree and the workers are named fakes.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Bun parses JSONC natively, so the import tolerates turbo.jsonc's comments.
import turboConfigJson from '../../turbo.jsonc';
import { ROOT_DIR } from '../lib/config';
import { parseJunitXml } from '../lib/junit-report';
import { createRootScriptsCommand } from '../lib/test';
import { laneById, workerReportPath } from '../lib/test-lanes';
import {
  discoverTestFiles,
  laneSpec,
  planWorkers,
  type StartWorker,
  splitLaneCommand,
  WORKERS_ENV,
} from '../lib/test-workers';
import { main, type RunnerDeps } from '../run-test-workers';
import { importClosure } from './support/import-closure';
import {
  crashingWorker,
  diskWorker,
  type FakeTestFile,
  killedWorker,
  silentWorker,
  withWorker,
} from './support/test-worker-fakes';

const WORKERS_SCRIPT = 'test:scripts:workers';
const WORKERS_TASK = `//#${WORKERS_SCRIPT}`;
const COVERAGE_TASK = '//#test:scripts';

const scripts = JSON.parse(readFileSync(join(ROOT_DIR, 'package.json'), 'utf8')).scripts as Record<
  string,
  string
>;

/** The lane command after `--` in the plain script, split on spaces as the shell would. */
function laneCommand(script: string): string[] {
  const match = /run-test-workers\.ts\s+--lane=root\s+--\s+(bun test\b.*)$/.exec(script);
  if (!match?.[1]) {
    throw new Error(
      `expected root ${WORKERS_SCRIPT} to run ... run-test-workers.ts --lane=root -- bun test ... | received: ${script || '(script missing)'}`
    );
  }
  return match[1].trim().split(/\s+/);
}

/** The runner's argv for the lane, from the plain script. */
const laneArgv = (): string[] => [
  '--lane=root',
  '--',
  ...laneCommand(scripts[WORKERS_SCRIPT] ?? ''),
];
/** The files the lane owns, as the census spells them: the scripts tree and the lane's named extras. */
const laneFiles = (): string[] =>
  [...discoverTestFiles(ROOT_DIR, 'scripts'), ...(laneById('root').workers?.alsoRuns ?? [])].sort();
const REAL_FILES: FakeTestFile[] = laneFiles().map((path) => ({ path, cases: ['one', 'two'] }));

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Deps whose workers are `start`, with the merged report in a throwaway directory. */
function harness(start: StartWorker, env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mangostudio-root-lane-'));
  scratch.push(dir);
  const started: number[] = [];
  const serial: (readonly string[])[] = [];
  const lines: string[] = [];
  const deps: RunnerDeps = {
    env,
    cpus: 34,
    platform: 'linux',
    mergedPath: join(dir, 'out', 'root.xml'),
    start: (plan) => {
      started.push(plan.index);
      return start(plan);
    },
    runSerial: (command) => {
      serial.push(command);
      return Promise.resolve(7);
    },
    onInterrupt: () => undefined,
    print: (line) => lines.push(line),
  };
  return { deps, started, serial, lines, mergedPath: deps.mergedPath as string };
}

describe('the root lane is declared as a worker lane', () => {
  it('owns the scripts directory and the api files its filter also selects', () => {
    const workers = laneById('root').workers;

    expect(
      workers?.testDir,
      `expected the root lane to declare workers over testDir: scripts | received: ${JSON.stringify(workers)}`
    ).toBe('scripts');
    expect(
      workers?.alsoRuns?.every((file) => file.startsWith('apps/api/') && file.includes('scripts')),
      `expected alsoRuns to name the api files whose path contains "scripts" | received: ${JSON.stringify(workers?.alsoRuns)}`
    ).toBe(true);
  });

  it('is split by a plain script whose command is the serial lane without its report flags', () => {
    const command = laneCommand(scripts[WORKERS_SCRIPT] ?? '');

    expect(
      splitLaneCommand(command, 'scripts').extra,
      `expected the lane command to end at the scripts directory | received: ${command.join(' ')}`
    ).toEqual([]);
    expect(
      command.join(' '),
      `expected the same bun test arguments as the coverage script apart from the JUnit flags the runner owns | received: ${command.join(' ')}`
    ).toBe('bun test --timeout 15000 scripts');
  });

  it('starts every worker through the temporary-home launcher with a shard and a report of its own', () => {
    const spec = laneSpec(laneById('root'), laneCommand(scripts[WORKERS_SCRIPT] ?? ''));
    const plans = planWorkers(spec, 4, tmpdir());

    expect(spec.alsoRuns).toEqual(laneById('root').workers?.alsoRuns);
    expect(plans.map((plan) => plan.argv.at(-1))).toEqual([
      'scripts',
      'scripts',
      'scripts',
      'scripts',
    ]);
    for (const plan of plans) {
      const launcher = plan.argv.slice(0, spec.launcher.length);
      expect(
        launcher.at(-1)?.replaceAll('\\', '/'),
        `expected worker ${plan.index}/${plan.count} to start through scripts/with-test-home.ts | received: ${plan.argv.join(' ')}`
      ).toEndWith('/scripts/with-test-home.ts');
      expect(plan.argv).toContain(`--shard=${plan.index}/4`);
      expect(plan.argv).toContain('--no-orphans');
      expect(plan.argv).toContain(`--reporter-outfile=${plan.reportPath}`);
      expect(plan.cwd, 'expected the workers to run at the repository root').toBe(ROOT_DIR);
    }
  });
});

/** Test files Bun's file walk skips: under a dot directory or `node_modules`. */
const skippedByBun = (file: string): boolean =>
  file.split('/').some((segment) => segment.startsWith('.') || segment === 'node_modules');
const BUN_TEST_FILE = /(\.test|_test|\.spec|_spec)\.(js|jsx|mjs|cjs|ts|tsx|mts|cts)$/;

/** The test files `bun test <filter>` selects in the repository: a substring of the path, as Bun matches it. */
function filterSelects(filter: string): string[] {
  const listed = Bun.spawnSync({
    cmd: ['git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    cwd: ROOT_DIR,
  });
  return listed.stdout
    .toString()
    .split('\0')
    .filter((file) => file && BUN_TEST_FILE.test(file) && !skippedByBun(file))
    .filter((file) => file.includes(filter))
    .sort();
}

describe('the lane owns what the serial command runs', () => {
  it('names every file the scripts filter selects outside the scripts directory', () => {
    const selected = filterSelects('scripts');
    const owned = laneFiles();
    const missing = selected.filter((file) => !owned.includes(file));
    const surplus = owned.filter((file) => !selected.includes(file));

    expect(
      missing,
      `expected 'bun test scripts' to select no file the root lane does not list | received: ${missing[0]} (add it to workers.alsoRuns in scripts/lib/test-lanes.ts)`
    ).toEqual([]);
    expect(
      surplus,
      `expected every file the root lane lists to be selected by 'bun test scripts' | received: ${surplus[0]} (remove it from workers.alsoRuns)`
    ).toEqual([]);
  });
});

describe('the coverage script and the CI shards stay what they were', () => {
  it('keeps test:scripts one bun test that writes the coverage evidence', () => {
    const script = scripts['test:scripts'] ?? '';

    expect(
      script,
      `expected test:scripts to stay a single bun test | received: ${script}`
    ).not.toContain('run-test-workers');
    expect(script).toContain('--reporter-outfile=.mango/artifacts/junit/root.xml');
    expect(script).toContain('$MANGOSTUDIO_BUN_TEST_ARGS');
  });

  it('runs a sharded command as one process, which is how CI reaches it', async () => {
    const run = harness(diskWorker(REAL_FILES), { [WORKERS_ENV]: '4' });
    const command = [...laneCommand(scripts[WORKERS_SCRIPT] ?? ''), '--shard=2/8'];

    const code = await main(['--lane=root', '--', ...command], run.deps);

    expect(code, 'expected the serial runner’s exit code').toBe(7);
    expect(run.started, 'expected no worker for a command that selects files').toEqual([]);
    expect(run.serial).toEqual([command]);
  });

  it('gives the unit phase the workers task and the coverage phase the serial one', () => {
    const task = (phase: 'unit' | 'coverage') => createRootScriptsCommand(phase, null)[2];

    expect(
      task('unit'),
      `expected the unit phase to run ${WORKERS_TASK} | received: ${task('unit')}`
    ).toBe(WORKERS_TASK);
    expect(
      task('coverage'),
      `expected the coverage phase to keep ${COVERAGE_TASK}, the task that writes root.xml | received: ${task('coverage')}`
    ).toBe(COVERAGE_TASK);
    expect(createRootScriptsCommand('unit', 'abc123').slice(-2)).toEqual([
      '--',
      '--changed=abc123',
    ]);
  });
});

describe('the runner over the root tree', () => {
  it.each([
    { label: 'four on a large POSIX host', cpus: 34, platform: 'linux' as const, count: 4 },
    { label: 'half the cores on a smaller host', cpus: 6, platform: 'linux' as const, count: 3 },
    { label: 'one on a single-core host', cpus: 1, platform: 'linux' as const, count: 1 },
    { label: 'one on Windows', cpus: 34, platform: 'win32' as const, count: 1 },
  ])('defaults to $label when the worker override is absent', async ({ cpus, platform, count }) => {
    const run = harness(diskWorker(REAL_FILES));

    expect(await main(laneArgv(), { ...run.deps, cpus, platform })).toBe(0);
    expect(run.started).toHaveLength(count);
    expect(run.lines[0]).toContain(
      `root: ${count} worker${count === 1 ? '' : 's'}, ${REAL_FILES.length} files`
    );
  });

  it('census the real scripts tree and exits 0 when every worker passes', async () => {
    expect(REAL_FILES.length, 'expected the scripts tree to hold test files').toBeGreaterThan(100);
    const run = harness(diskWorker(REAL_FILES), { [WORKERS_ENV]: '4' });

    expect(await main(laneArgv(), run.deps)).toBe(0);

    expect(run.started.sort()).toEqual([1, 2, 3, 4]);
    expect(parseJunitXml(readFileSync(run.mergedPath, 'utf8')).tests).toBe(REAL_FILES.length * 2);
    expect(run.lines[0]).toContain(`root: 4 workers, ${REAL_FILES.length} files`);
  });

  it('writes its merged report beside the other workers’ and not over the coverage evidence', () => {
    const lane = laneById('root');

    expect(
      workerReportPath(lane),
      'expected the merged report outside .mango/artifacts/junit | received: the lane’s junitPath'
    ).toBe('.mango/artifacts/test-workers/root.xml');
    expect(workerReportPath(lane)).not.toBe(lane.junitPath);
  });

  it('fails the lane, naming the worker, when one is killed', async () => {
    const run = harness(withWorker(3, killedWorker('SIGKILL'), diskWorker(REAL_FILES)), {
      [WORKERS_ENV]: '4',
    });

    expect(await main(laneArgv(), run.deps)).toBe(1);

    expect(run.lines.filter((line) => line.startsWith('FAILED '))[0]).toContain(
      'root worker 3/4 was killed by SIGKILL'
    );
    expect(existsSync(run.mergedPath), 'expected no merged report from a failed lane').toBe(false);
  });

  it('fails the lane when a worker exits non-zero', async () => {
    const run = harness(withWorker(2, crashingWorker(3), diskWorker(REAL_FILES)), {
      [WORKERS_ENV]: '4',
    });

    expect(await main(laneArgv(), run.deps)).toBe(1);
    expect(run.lines.join('\n')).toContain('root worker 2/4 failed');
  });

  it('fails the lane when a worker exits 0 and leaves no report', async () => {
    const run = harness(withWorker(1, silentWorker, diskWorker(REAL_FILES)), {
      [WORKERS_ENV]: '4',
    });

    expect(await main(laneArgv(), run.deps)).toBe(1);
    expect(run.lines.join('\n')).toContain('root worker 1/4 wrote no report');
  });

  it('fails the lane when a file its filter selects outside scripts is run by no worker', async () => {
    const outside = REAL_FILES.filter((file) => !file.path.startsWith('scripts/'));
    expect(
      outside.length,
      'expected the root census to include files outside scripts/'
    ).toBeGreaterThan(0);
    const run = harness(diskWorker(REAL_FILES.filter((file) => !outside.includes(file))), {
      [WORKERS_ENV]: '4',
    });

    expect(await main(laneArgv(), run.deps)).toBe(1);
    expect(run.lines.join('\n')).toContain(`no worker reported ${outside[0]?.path}`);
  });

  it('fails the lane when a test file is run by no worker', async () => {
    const run = harness(diskWorker(REAL_FILES.slice(1)), { [WORKERS_ENV]: '4' });

    expect(await main(laneArgv(), run.deps)).toBe(1);
    expect(run.lines.join('\n')).toContain(`no worker reported ${REAL_FILES[0]?.path}`);
  });

  it('runs one worker, unsharded, on Windows unless the width is set', async () => {
    const run = harness(diskWorker(REAL_FILES));

    expect(await main(laneArgv(), { ...run.deps, platform: 'win32' })).toBe(0);
    expect(run.started).toEqual([1]);
  });
});

describe('what Turbo hashes for the plain root lane', () => {
  interface DryRunTask {
    taskId: string;
    hash: string;
    inputs: Record<string, string>;
    resolvedTaskDefinition: { cache: boolean; passThroughEnv: string[] | null };
  }

  async function dryRun(extraEnv: Record<string, string> = {}): Promise<DryRunTask> {
    const probe = Bun.spawn({
      cmd: [join(ROOT_DIR, 'node_modules', '.bin', 'turbo'), 'run', WORKERS_TASK, '--dry=json'],
      cwd: ROOT_DIR,
      env: { ...(process.env as Record<string, string>), ...extraEnv },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [out, err, code] = await Promise.all([
      new Response(probe.stdout).text(),
      new Response(probe.stderr).text(),
      probe.exited,
    ]);
    expect(code, `expected turbo dry run exit: 0 | received: ${code} | stderr: ${err.trim()}`).toBe(
      0
    );
    const task = (JSON.parse(out) as { tasks: DryRunTask[] }).tasks.find(
      (candidate) => candidate.taskId === WORKERS_TASK
    );
    if (!task)
      throw new Error(`expected a ${WORKERS_TASK} task in the Turbo dry run | received: none`);
    return task;
  }

  it('is a cached task that hashes every file the runner loads', async () => {
    const task = await dryRun();
    expect(task.resolvedTaskDefinition.cache, `expected ${WORKERS_TASK} to be cached`).toBe(true);

    const hashed = Object.keys(task.inputs);
    const loaded = importClosure(['scripts/with-test-home.ts', 'scripts/run-test-workers.ts']);
    expect(
      loaded.length,
      'expected the runner closure to hold the launcher and the runner'
    ).toBeGreaterThan(8);
    for (const file of loaded) {
      expect(
        hashed.includes(file),
        `a change to ${file} must invalidate the cached ${WORKERS_TASK} result | expected: ${file} among the task's inputs | received: ${hashed.length} hashed files, none of them ${file}`
      ).toBe(true);
    }
  });

  it('passes the worker count through without changing the hash', async () => {
    const [unset, narrow, other] = [
      await dryRun(),
      await dryRun({ [WORKERS_ENV]: '2' }),
      await dryRun({ MANGOSTUDIO_SOMETHING_ELSE: '2' }),
    ];

    expect(
      unset.resolvedTaskDefinition.passThroughEnv,
      `expected ${WORKERS_ENV} in passThroughEnv of ${WORKERS_TASK}, because Turbo's strict environment drops it before the runner reads it`
    ).toContain(WORKERS_ENV);
    expect(
      narrow.hash,
      `${WORKERS_ENV}=2 must hit the entry written without it | expected: ${unset.hash} | received: ${narrow.hash}`
    ).toBe(unset.hash);
    // The control: a MANGOSTUDIO_* variable is hashed, so the comparison can differ.
    expect(other.hash).not.toBe(unset.hash);
  });

  it('defines the plain task beside the coverage task, with no JUnit output to restore', () => {
    const tasks = (turboConfigJson as { tasks: Record<string, { outputs?: string[] }> }).tasks;

    expect(
      Object.keys(tasks).filter((name) => name.startsWith('//#test:scripts')),
      `expected the coverage and the plain root tasks in turbo.jsonc | received: ${Object.keys(tasks).join(', ')}`
    ).toEqual([COVERAGE_TASK, WORKERS_TASK]);
    expect(
      tasks[WORKERS_TASK]?.outputs,
      `expected ${WORKERS_TASK} to restore nothing: its merged report is not the coverage evidence | received: ${JSON.stringify(tasks[WORKERS_TASK]?.outputs)}`
    ).toBeUndefined();
  });
});
