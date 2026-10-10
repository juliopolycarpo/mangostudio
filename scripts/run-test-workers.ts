#!/usr/bin/env bun
// Runs a test lane as several isolated `bun test` processes and reports it as
// one lane. The API workspace's `test:unit` script and the root
// `test:scripts:workers` script are the callers:
//
//   bun ../../scripts/run-test-workers.ts --lane=api-unit -- bun test --timeout 15000 --parallel=1 tests/unit
//   bun ./scripts/run-test-workers.ts --lane=root -- bun test --timeout 15000 scripts
//
// The lane (scripts/lib/test-lanes.ts) says which directory it owns; the
// command after `--` is the serial command, unchanged. `MANGO_TEST_WORKERS`
// sets the width (1 to 8, default six for unit and four for integration, never
// more than half the cores, and one on
// Windows: see resolveWorkerCount).
//
// A command with anything after the lane's directory (`bun run test --changed`
// appends `--changed=<sha>`) selects files, so it is not the whole lane and
// runs as one process exactly as before.
//
// The merged JUnit goes to `workerReportPath(lane)`, never to the lane's
// `junitPath`, which is its coverage run's evidence.
//
// Exit code: 0 when every worker passed and left a whole report, 128 plus the
// signal when interrupted, else 1.

import { rmSync } from 'node:fs';
import { availableParallelism, constants } from 'node:os';
import { join } from 'node:path';

import { ROOT_DIR } from './lib/config';
import { error, info, log } from './lib/log';
import { runWithTestHome } from './lib/test-home';
import { laneById, type TestLaneId, workerReportPath } from './lib/test-lanes';
import { startWorkerProcess, workerEnvironment } from './lib/test-worker-process';
import {
  formatLaneSummary,
  laneSpec,
  resolveWorkerCount,
  runWorkerLane,
  type StartWorker,
  splitLaneCommand,
  WORKERS_ENV,
} from './lib/test-workers';

const INTERRUPTS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
type Interrupt = (typeof INTERRUPTS)[number];

/** Everything `main` takes from the machine, so a test can hand it fakes. */
export interface RunnerDeps {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cpus: number;
  readonly platform: NodeJS.Platform;
  /** Starts one worker; the real one prefixes its output with the worker's name. */
  readonly start: StartWorker;
  /** Runs the lane command as one process, as before the runner existed. */
  readonly runSerial: (command: readonly string[]) => Promise<number>;
  /** Registers the handler for SIGINT, SIGTERM and SIGHUP. */
  readonly onInterrupt: (handler: (signal: Interrupt) => void) => void;
  readonly print: (line: string, isFailure: boolean) => void;
  /** Where the merged JUnit goes; `workerReportPath(lane)` under `rootDir` by default. */
  readonly mergedPath?: string;
  /** The repository root the default merged path is under. */
  readonly rootDir?: string;
  /** What starts each worker's `bun test`; the temporary-HOME launcher by default. */
  readonly launcher?: readonly string[];
}

export const systemDeps = (): RunnerDeps => ({
  env: process.env,
  cpus: availableParallelism(),
  platform: process.platform,
  start: (plan) =>
    startWorkerProcess(plan, plan.count > 1 ? `[${plan.laneId} ${plan.index}/${plan.count}] ` : ''),
  runSerial: (command) => runWithTestHome(command, workerEnvironment(process.env, { env: {} })),
  onInterrupt: (handler) => {
    for (const name of INTERRUPTS) process.on(name, () => handler(name));
  },
  print: (line, isFailure) => (isFailure ? error(line) : log(line)),
});

function parseArguments(argv: readonly string[]): { laneId: string; command: string[] } {
  const separator = argv.indexOf('--');
  const options = separator === -1 ? argv : argv.slice(0, separator);
  const laneId = options.find((arg) => arg.startsWith('--lane='))?.slice('--lane='.length);
  if (!laneId || separator === -1) {
    throw new Error(
      `run-test-workers: expected --lane=<id> -- <bun test command> | received: ${JSON.stringify(argv.join(' '))}`
    );
  }
  return { laneId, command: argv.slice(separator + 1) };
}

/**
 * Runs the lane named in `argv` and returns the exit code.
 *
 * @example
 * const code = await main(['--lane=api-unit', '--', 'bun', 'test', '--parallel=1', 'tests/unit']);
 */
export async function main(
  argv: readonly string[],
  deps: RunnerDeps = systemDeps()
): Promise<number> {
  const { laneId, command } = parseArguments(argv);
  const lane = laneById(laneId as TestLaneId);
  const spec = laneSpec(lane, command, deps.launcher, deps.platform);
  const mergedPath = deps.mergedPath ?? join(deps.rootDir ?? ROOT_DIR, workerReportPath(lane));

  const { extra } = splitLaneCommand(command, spec.testDir);
  if (extra.length > 0) {
    // Not the whole lane, so no merged report: and none left over from another run.
    rmSync(mergedPath, { force: true });
    info(`${laneId}: ${extra.join(' ')} selects files, so this run is one process`);
    return deps.runSerial(command);
  }

  const count = resolveWorkerCount(deps.env, deps.cpus, deps.platform, lane.workers?.defaultWidth);
  const cancellation = new AbortController();
  const interrupt: { by: Interrupt | null } = { by: null };
  deps.onInterrupt((signal) => {
    interrupt.by ??= signal;
    cancellation.abort();
  });

  info(`${laneId}: ${count} worker${count === 1 ? '' : 's'} (${WORKERS_ENV} overrides)`);
  const { verdict, wallMs } = await runWorkerLane({
    spec,
    count,
    mergedPath,
    signal: cancellation.signal,
    start: deps.start,
  });

  for (const line of formatLaneSummary(laneId, verdict, wallMs)) {
    deps.print(line, line.startsWith('FAILED '));
  }
  if (interrupt.by) return 128 + (constants.signals[interrupt.by] ?? 0);
  return verdict.failures.length > 0 ? 1 : 0;
}

if (import.meta.main) {
  try {
    process.exit(await main(process.argv.slice(2)));
  } catch (caught) {
    error(caught instanceof Error ? caught.message : String(caught));
    process.exit(1);
  }
}
