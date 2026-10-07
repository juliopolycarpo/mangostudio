// Runs one `bun test` lane as several worker processes and folds their reports
// back into the lane's single result.
//
// Why processes of their own and not `bun test --parallel=N`: Bun's workers
// share one process, and that process is where oven-sh/bun#37968 aborts whole
// files (see docs/reference/testing.md, "Known upstream blocker"). A worker here
// is a complete `bun test` that owns its file subset (`--shard=i/N`), its
// temporary HOME (the launcher gives every process a fresh one), its in-memory
// database, its OS-assigned ports and its own JUnit report, so nothing is shared
// between workers but the checkout. That is the shape the sharded CI lanes
// already run in.
//
// The lane is only as good as its weakest worker, so the verdict is strict:
// a worker that fails, is killed, is cancelled, never starts or leaves no whole
// report fails the lane, and the files the reports name must be exactly the
// files the lane owns, each in one report.
//
// Everything that touches a process or a disk is injected (`StartWorker`,
// `readReport`), so the verdict is tested against named fakes. The real
// process is in ./test-worker-process.ts. This file and its imports are named
// in `apps/api/turbo.json`'s `test:unit` inputs; keep the list in step.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Glob } from 'bun';

import { ROOT_DIR } from './config';
import { endOfOpenTag, type JunitCounts, parseJunitXml, readAttributes } from './junit-report';
import type { TestLane } from './test-lanes';

/** Overrides the worker count; read by the runner, kept out of Turbo's cache key. */
export const WORKERS_ENV = 'MANGO_TEST_WORKERS';

/** Most workers an override may ask for. Each costs roughly 0.5 GB of resident memory. */
export const MAX_WORKERS = 8;

/**
 * Median lane wall time on a 34-CPU host, three runs per width: 262 s at one
 * worker, 76 s at four, 49 s at six, 38 s at eight. The default is six, the
 * smaller of the two widths that beat four by more than 10% with every report
 * equal to the serial lane's.
 */
const DEFAULT_WORKERS = 6;

/**
 * How many workers to start: `MANGO_TEST_WORKERS` when set, else six, but never
 * more than half the cores: the lane shares the host with the other lanes of
 * `bun run test`, and a small machine would otherwise run the 15 s case timeouts
 * on an oversubscribed CPU.
 *
 * On Windows the default is one worker, the serial lane. With six concurrent
 * processes `chatgpt-loopback.test.ts` failed with ECONNRESET in 12 of 72 runs,
 * and 0 of 40 serially; a Bun server that sends `Connection: close` or stops
 * while it answers is reset about 40% of the time under six processes there, in a
 * script with no MangoStudio code. Lift this when that is understood. An
 * explicit `MANGO_TEST_WORKERS` still wins, with the same validation.
 *
 * @example
 * resolveWorkerCount({}, 34, 'linux'); // => 6
 * resolveWorkerCount({}, 34, 'win32'); // => 1
 * resolveWorkerCount({ MANGO_TEST_WORKERS: '2' }, 34, 'win32'); // => 2
 */
export function resolveWorkerCount(
  env: Readonly<Record<string, string | undefined>>,
  cpus: number,
  platform: NodeJS.Platform = process.platform
): number {
  const raw = env[WORKERS_ENV]?.trim();
  if (!raw) {
    if (platform === 'win32') return 1;
    return Math.max(1, Math.min(DEFAULT_WORKERS, Math.floor(cpus / 2)));
  }

  const count = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (Number.isInteger(count) && count >= 1 && count <= MAX_WORKERS) return count;
  throw new Error(
    `test workers: expected ${WORKERS_ENV}: an integer from 1 to ${MAX_WORKERS} | received: ${JSON.stringify(env[WORKERS_ENV])}`
  );
}

/** What a lane needs to be split: where it runs, what it runs, and what it owns. */
export interface WorkerLaneSpec {
  /** Lane id, e.g. `api-unit`; leads every message. */
  readonly id: string;
  /** Absolute directory the command runs in (the workspace). */
  readonly cwd: string;
  /** The serial command, e.g. `bun test --timeout 15000 --parallel=1 tests/unit`. */
  readonly command: readonly string[];
  /** Workspace-relative directory the command's last argument names. */
  readonly testDir: string;
  /** What starts each worker's `bun test`: the temporary-HOME launcher. */
  readonly launcher: readonly string[];
}

/**
 * The spec for a lane that declares `workers`, from the serial command its
 * package script runs. Every worker starts through `scripts/with-test-home.ts`,
 * so each has a temporary HOME of its own and never the developer's.
 *
 * @example
 * laneSpec(laneById('api-unit'), ['bun', 'test', '--parallel=1', 'tests/unit']).testDir;
 * // => 'tests/unit'
 */
export function laneSpec(lane: TestLane, command: readonly string[]): WorkerLaneSpec {
  if (!lane.workers) {
    throw new Error(
      `test workers: expected a lane with workers | received: ${lane.id} (see scripts/lib/test-lanes.ts)`
    );
  }
  return {
    id: lane.id,
    cwd: join(ROOT_DIR, dirname(lane.manifest)),
    command,
    testDir: lane.workers.testDir,
    launcher: [process.execPath, join(ROOT_DIR, 'scripts', 'with-test-home.ts')],
  };
}

/** One worker process: its slice of the lane and the report only it writes. */
export interface WorkerPlan {
  /** 1-based, as in `--shard=index/count`. */
  readonly index: number;
  readonly count: number;
  readonly laneId: string;
  readonly cwd: string;
  readonly argv: readonly string[];
  readonly reportPath: string;
}

/** `api-unit worker 3/4`, the name every message about a worker starts with. */
const workerName = (plan: Pick<WorkerPlan, 'laneId' | 'index' | 'count'>): string =>
  `${plan.laneId} worker ${plan.index}/${plan.count}`;

/**
 * The lane's command split at its test directory: the lane's own arguments, and
 * whatever was appended after them (`--changed=<sha>` from `bun run test
 * --changed`, or a name filter). An appended argument selects files, so such a
 * run is not the whole lane and is not split.
 *
 * @example
 * splitLaneCommand(['bun', 'test', 'tests/unit', '--changed=abc'], 'tests/unit').extra;
 * // => ['--changed=abc']
 */
export function splitLaneCommand(
  command: readonly string[],
  testDir: string
): { readonly lane: readonly string[]; readonly extra: readonly string[] } {
  const at = command.lastIndexOf(testDir);
  if (command[0] !== 'bun' || command[1] !== 'test' || at < 2) {
    throw new Error(
      `test workers: expected a command like "bun test <flags> ${testDir}" | received: ${JSON.stringify(command.join(' '))}`
    );
  }
  return { lane: command.slice(0, at + 1), extra: command.slice(at + 1) };
}

const OWNED_FLAGS = ['--reporter', '--reporter-outfile', '--shard', '--no-orphans'];

/**
 * One plan per worker. Each gets `--shard=i/N` (none for a single worker, which
 * runs the serial command as it was), `--no-orphans`, and `--reporter=junit`
 * writing to a path inside `reportDir` that no other worker has.
 *
 * @example
 * planWorkers(spec, 4, '/tmp/run-1').map((plan) => plan.reportPath);
 * // => ['/tmp/run-1/worker-1-of-4.xml', ..., '/tmp/run-1/worker-4-of-4.xml']
 */
export function planWorkers(
  spec: WorkerLaneSpec,
  count: number,
  reportDir: string
): readonly WorkerPlan[] {
  const { lane } = splitLaneCommand(spec.command, spec.testDir);
  const owned = lane.find((arg) => OWNED_FLAGS.some((flag) => arg.split('=')[0] === flag));
  if (owned) {
    throw new Error(
      `test workers: expected a lane command without ${OWNED_FLAGS.join(', ')}, which the runner sets per worker | received: ${owned}`
    );
  }

  return Array.from({ length: count }, (_, offset) => {
    const index = offset + 1;
    const reportPath = join(reportDir, `worker-${index}-of-${count}.xml`);
    const flags = [
      // The worker dies with its launcher and takes its own descendants along, so
      // the SIGKILL that ends a cancelled lane (which no launcher can forward) does
      // not leave a `bun test`, or a process one of its tests started, behind.
      '--no-orphans',
      '--reporter=junit',
      `--reporter-outfile=${reportPath}`,
      ...(count > 1 ? [`--shard=${index}/${count}`] : []),
    ];
    const [program, subcommand, ...rest] = spec.command;
    return {
      index,
      count,
      laneId: spec.id,
      cwd: spec.cwd,
      argv: [...spec.launcher, program as string, subcommand as string, ...flags, ...rest],
      reportPath,
    };
  });
}

/** How a worker process ended. Exactly one of the two is set once it has. */
export interface WorkerExit {
  readonly exitCode: number | null;
  readonly signal: string | null;
}

/** A started worker. `kill` asks it to stop; `exited` settles once it has. */
export interface WorkerHandle {
  readonly exited: Promise<WorkerExit>;
  kill(signal: 'SIGTERM' | 'SIGKILL'): void;
}

/** Starts a worker process; the real one is `startWorkerProcess`. */
export type StartWorker = (plan: WorkerPlan) => WorkerHandle;

/** What happened to one worker. */
export interface WorkerRun {
  readonly plan: WorkerPlan;
  /** Null when the worker never started or its `exited` promise rejected. */
  readonly exit: WorkerExit | null;
  /** Why the worker could not be started or awaited. */
  readonly startError: string | null;
  /** Cancellation reached the worker before it ended on its own. */
  readonly cancelled: boolean;
  readonly durationMs: number;
}

export interface RunWorkersOptions {
  /** Aborting stops every worker that is still running. */
  readonly signal?: AbortSignal;
  /** How long a worker gets after SIGTERM before SIGKILL. */
  readonly killAfterMs?: number;
}

const errorText = (caught: unknown): string =>
  caught instanceof Error ? caught.message : String(caught);

async function runWorker(
  plan: WorkerPlan,
  start: StartWorker,
  { signal, killAfterMs = 10_000 }: RunWorkersOptions
): Promise<WorkerRun> {
  const began = performance.now();
  const settle = (partial: Pick<WorkerRun, 'exit' | 'startError' | 'cancelled'>): WorkerRun => ({
    plan,
    ...partial,
    durationMs: Math.round(performance.now() - began),
  });

  let handle: WorkerHandle;
  try {
    handle = start(plan);
  } catch (caught) {
    return settle({ exit: null, startError: errorText(caught), cancelled: false });
  }

  let ended = false;
  let cancelled = false;
  let escalation: ReturnType<typeof setTimeout> | undefined;
  const cancel = (): void => {
    if (ended) return;
    cancelled = true;
    handle.kill('SIGTERM');
    escalation = setTimeout(() => handle.kill('SIGKILL'), killAfterMs);
  };
  if (signal?.aborted) cancel();
  else signal?.addEventListener('abort', cancel, { once: true });

  try {
    return settle({ exit: await handle.exited, startError: null, cancelled });
  } catch (caught) {
    return settle({ exit: null, startError: errorText(caught), cancelled });
  } finally {
    ended = true;
    clearTimeout(escalation);
    signal?.removeEventListener('abort', cancel);
  }
}

/**
 * Starts every worker at once and settles when all of them have, whatever each
 * did. A worker that fails does not stop its siblings: the serial lane also
 * reports every failure, not the first. Aborting `signal` is the exception and
 * stops them all.
 *
 * @example
 * const runs = await runWorkers(plans, startWorkerProcess, { signal: controller.signal });
 */
export function runWorkers(
  plans: readonly WorkerPlan[],
  start: StartWorker,
  options: RunWorkersOptions = {}
): Promise<readonly WorkerRun[]> {
  return Promise.all(plans.map((plan) => runWorker(plan, start, options)));
}

/** The files a lane owns, as the report's `file` attribute spells them: `tests/unit/a.test.ts`. */
export function discoverTestFiles(cwd: string, testDir: string): string[] {
  // The names and extensions `bun test` itself runs.
  const glob = new Glob('**/*{.test,_test,.spec,_spec}.{js,jsx,mjs,cjs,ts,tsx,mts,cts}');
  const root = testDir.replaceAll('\\', '/').replace(/\/$/, '');
  return [...glob.scanSync({ cwd: join(cwd, testDir) })]
    .map((file) => `${root}/${file.replaceAll('\\', '/')}`)
    .sort();
}

/** A case reduced to what two reports must agree on. */
export interface ReportedCase {
  readonly identity: string;
  readonly outcome: string;
}

const caseKey = (reported: ReportedCase): string => `${reported.outcome}\0${reported.identity}`;

function firstSurplus(
  from: readonly ReportedCase[],
  against: readonly ReportedCase[]
): ReportedCase | null {
  const remaining = new Map<string, number>();
  for (const reported of against) {
    remaining.set(caseKey(reported), (remaining.get(caseKey(reported)) ?? 0) + 1);
  }
  for (const reported of from) {
    const left = remaining.get(caseKey(reported)) ?? 0;
    if (left === 0) return reported;
    remaining.set(caseKey(reported), left - 1);
  }
  return null;
}

/**
 * Where two reports disagree on their cases and outcomes, or null when they are
 * the same multiset. Order does not matter, repeats do: a case that ran twice is
 * not the case that ran once.
 *
 * @example
 * describeCaseDifference(serial.cases, merged.cases); // => null
 * // => 'expected 5227 cases | received 5226 | first missing: a.test.ts|||5 [passed]'
 */
export function describeCaseDifference(
  expected: readonly ReportedCase[],
  actual: readonly ReportedCase[]
): string | null {
  const missing = firstSurplus(expected, actual);
  const extra = firstSurplus(actual, expected);
  if (!missing && !extra) return null;

  const show = (reported: ReportedCase | null): string =>
    reported ? `${reported.identity} [${reported.outcome}]` : 'none';
  return `expected ${expected.length} cases | received ${actual.length} | first missing: ${show(missing)} | first extra: ${show(extra)}`;
}

const escapeAttribute = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const SUITES_CLOSE = '</testsuites>';

function splitReport(xml: string): { attributes: Record<string, string>; body: string } {
  const open = xml.indexOf('<testsuites');
  const end = open === -1 ? -1 : endOfOpenTag(xml, open);
  const close = xml.lastIndexOf(SUITES_CLOSE);
  if (end === -1 || close < end) {
    throw new Error(
      `test workers: expected a JUnit document with a <testsuites> root | received: ${JSON.stringify(xml.slice(0, 80))}`
    );
  }
  return {
    attributes: { ...readAttributes(xml.slice(open, end)) },
    body: xml
      .slice(end, close)
      .replace(/^\s*\n/, '')
      .trimEnd(),
  };
}

/**
 * One document from several: every `<testsuite>` in worker order under a root
 * whose counters are the sums (and whose `time` is the slowest worker's, since
 * they ran side by side).
 *
 * @example
 * parseJunitXml(mergeReports([workerOneXml, workerTwoXml])).tests; // => both workers' cases
 */
export function mergeReports(documents: readonly string[]): string {
  const parts = documents.map(splitReport);
  const first = parts[0];
  if (!first) throw new Error('test workers: expected at least one report to merge | received: 0');

  const merged = Object.entries(first.attributes).map(([name, firstValue]) => {
    const values = parts.map((part) => part.attributes[name]);
    const numbers = values.map((value) => (value === undefined ? Number.NaN : Number(value)));
    if (numbers.some(Number.isNaN)) return [name, firstValue] as const;
    const combined = name === 'time' ? Math.max(...numbers) : numbers.reduce((a, b) => a + b, 0);
    return [name, String(combined)] as const;
  });
  const root = merged.map(([name, value]) => `${name}="${escapeAttribute(value)}"`).join(' ');

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites ${root}>`,
    ...parts.map((part) => part.body),
    `${SUITES_CLOSE}\n`,
  ].join('\n');
}

/** One worker's line in the lane summary. */
interface WorkerSummary {
  readonly name: string;
  readonly files: number;
  readonly cases: number;
  readonly failed: number;
  readonly durationMs: number;
  /** `exit 0`, `exit 1`, `killed by SIGKILL`, `cancelled`, `did not start`. */
  readonly ended: string;
}

export interface LaneVerdict {
  /** Empty when the lane passed. Each entry names its worker. */
  readonly failures: readonly string[];
  readonly workers: readonly WorkerSummary[];
  readonly totals: {
    readonly files: number;
    readonly cases: number;
    readonly passed: number;
    readonly failed: number;
    readonly skipped: number;
    readonly todo: number;
  };
  /** The lane's one JUnit document; null unless every worker left a whole report. */
  readonly mergedXml: string | null;
}

export interface JudgeInput {
  readonly runs: readonly WorkerRun[];
  /** The report text at a path, or null when nothing was written there. */
  readonly readReport: (path: string) => string | null;
  /** Every test file the lane owns, or null when the run selected a subset. */
  readonly census: readonly string[] | null;
  readonly testDir: string;
}

const problem = (run: WorkerRun, what: string, expected: string, received: string): string =>
  `${workerName(run.plan)} ${what} | expected: ${expected} | received: ${received}`;

function endedWith(run: WorkerRun): string {
  if (run.startError) return 'did not start';
  if (run.cancelled) return 'cancelled';
  if (run.exit?.signal) return `killed by ${run.exit.signal}`;
  return `exit ${run.exit?.exitCode ?? '?'}`;
}

function exitProblem(run: WorkerRun): string | null {
  if (run.startError) {
    return problem(run, 'did not start', 'a running process', run.startError);
  }
  if (run.cancelled) return problem(run, 'was cancelled', 'to run to completion', 'cancelled');
  const { exitCode, signal } = run.exit ?? { exitCode: null, signal: null };
  if (signal) return problem(run, `was killed by ${signal}`, 'exit code 0', `signal ${signal}`);
  if (exitCode === 0) return null;
  const shellSignal =
    exitCode !== null && exitCode > 128 ? ` (128 + signal ${exitCode - 128})` : '';
  return problem(run, 'failed', 'exit code 0', `${exitCode}${shellSignal}`);
}

interface ReadReport {
  readonly run: WorkerRun;
  readonly xml: string;
  readonly counts: JunitCounts;
  readonly files: ReadonlySet<string>;
}

function readWorkerReport(
  run: WorkerRun,
  readReport: JudgeInput['readReport'],
  failures: string[]
): ReadReport | null {
  // A worker that never ran has no report to wait for; its own failure is the news.
  if (run.startError || run.cancelled) return null;

  const xml = readReport(run.plan.reportPath);
  if (xml === null) {
    failures.push(
      problem(run, 'wrote no report', `a JUnit report at ${run.plan.reportPath}`, 'no file')
    );
    return null;
  }
  const counts = parseJunitXml(xml);
  if (counts.truncated) {
    failures.push(
      problem(run, 'wrote an incomplete report', 'a whole JUnit document', counts.truncated)
    );
    return null;
  }
  const files = new Set(
    counts.cases.flatMap((reported) => (reported.file ? [reported.file.replaceAll('\\', '/')] : []))
  );
  return { run, xml, counts, files };
}

function caseProblems(report: ReadReport): string[] {
  const { run, counts } = report;
  if (run.exit?.exitCode !== 0) return [];
  if (counts.failed > 0) {
    return [problem(run, 'exited 0 with failing cases', '0 failed cases', String(counts.failed))];
  }
  if (counts.tests === 0) {
    return [problem(run, 'ran green but reported no cases', 'at least 1 case', '0')];
  }
  return [];
}

function censusProblems(
  reports: readonly ReadReport[],
  census: readonly string[],
  testDir: string
): string[] {
  const owners = new Map<string, string[]>();
  for (const { run, files } of reports) {
    for (const file of files) owners.set(file, [...(owners.get(file) ?? []), workerName(run.plan)]);
  }

  const failures: string[] = [];
  const shared = [...owners].find(([, who]) => who.length > 1);
  if (shared) {
    failures.push(
      `${shared[0]} was reported by ${shared[1].join(' and ')} | expected: one worker per file | received: ${shared[1].length}`
    );
  }
  const owned = new Set(census);
  const extra = [...owners].find(([file]) => !owned.has(file));
  if (extra) {
    failures.push(
      `${extra[1][0]} reported ${extra[0]} | expected: a file under ${testDir} | received: a file the lane does not own`
    );
  }
  const unreported = census.filter((file) => !owners.has(file));
  if (unreported.length > 0) {
    failures.push(
      `no worker reported ${unreported[0]} | expected: all ${census.length} files under ${testDir} | received: ${unreported.length} unreported`
    );
  }
  return failures;
}

/**
 * Decides whether the lane passed and builds its one report. Pure: the workers'
 * runs and a way to read their reports go in, a verdict comes out.
 *
 * @example
 * const verdict = judgeWorkers({ runs, readReport: readReportOrNull, census, testDir });
 * if (verdict.failures.length > 0) console.error(verdict.failures.join('\n'));
 */
export function judgeWorkers(input: JudgeInput): LaneVerdict {
  const failures: string[] = [];
  const reports: ReadReport[] = [];

  for (const run of input.runs) {
    const exit = exitProblem(run);
    if (exit) failures.push(exit);
    const report = readWorkerReport(run, input.readReport, failures);
    if (!report) continue;
    reports.push(report);
    failures.push(...caseProblems(report));
  }

  const whole = reports.length === input.runs.length;
  if (whole && input.census) failures.push(...censusProblems(reports, input.census, input.testDir));

  const sum = (pick: (counts: JunitCounts) => number): number =>
    reports.reduce((total, { counts }) => total + pick(counts), 0);
  const allFiles = new Set(reports.flatMap(({ files }) => [...files]));

  return {
    failures,
    workers: input.runs.map((run) => {
      const report = reports.find((candidate) => candidate.run === run);
      return {
        name: workerName(run.plan),
        files: report?.files.size ?? 0,
        cases: report?.counts.tests ?? 0,
        failed: report?.counts.failed ?? 0,
        durationMs: run.durationMs,
        ended: endedWith(run),
      };
    }),
    totals: {
      files: allFiles.size,
      cases: sum((counts) => counts.tests),
      passed: sum((counts) => counts.passed),
      failed: sum((counts) => counts.failed),
      skipped: sum((counts) => counts.skipped),
      todo: sum((counts) => counts.todo),
    },
    mergedXml: whole && reports.length > 0 ? mergeReports(reports.map(({ xml }) => xml)) : null,
  };
}

/**
 * The lines the lane prints when it ends: one for the lane, one per worker, and
 * every failure.
 *
 * @example
 * formatLaneSummary('api-unit', verdict, 73_100)[0];
 * // => 'api-unit: 4 workers, 427 files, 5227 cases (5174 passed, 53 skipped, 0 failed) in 73.1s'
 */
export function formatLaneSummary(
  laneId: string,
  verdict: LaneVerdict,
  wallMs: number
): readonly string[] {
  const { totals, workers } = verdict;
  const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;
  return [
    `${laneId}: ${workers.length} worker${workers.length === 1 ? '' : 's'}, ${totals.files} files, ${totals.cases} cases (${totals.passed} passed, ${totals.skipped + totals.todo} skipped, ${totals.failed} failed) in ${seconds(wallMs)}`,
    ...workers.map(
      (worker) =>
        `  ${worker.name}: ${worker.ended}, ${worker.files} files, ${worker.cases} cases, ${seconds(worker.durationMs)}`
    ),
    ...verdict.failures.map((failure) => `FAILED ${failure}`),
  ];
}

export interface LaneRunOptions {
  readonly spec: WorkerLaneSpec;
  readonly count: number;
  readonly start: StartWorker;
  /** Where the lane's one JUnit document goes. */
  readonly mergedPath: string;
  readonly signal?: AbortSignal;
  readonly killAfterMs?: number;
  /** Where each run's private report directory is made; the OS temp directory by default. */
  readonly scratchRoot?: string;
}

/**
 * Runs the whole lane: plans the workers, starts them, waits for all, judges
 * their reports and writes the merged one to `mergedPath`.
 *
 * Reports are read only from the directory this call made for these workers,
 * so a report a previous run left anywhere cannot be counted. `mergedPath` is
 * removed first and written only for a verdict with whole reports, so a failed
 * lane cannot leave the last green run's totals behind.
 *
 * @example
 * const { verdict } = await runWorkerLane({ spec, count: 4, start, mergedPath });
 * process.exitCode = verdict.failures.length > 0 ? 1 : 0;
 */
export async function runWorkerLane(
  options: LaneRunOptions
): Promise<{ readonly verdict: LaneVerdict; readonly wallMs: number }> {
  const { spec } = options;
  const began = performance.now();
  rmSync(options.mergedPath, { force: true });
  mkdirSync(dirname(options.mergedPath), { recursive: true });

  // Counted before any worker runs: this is the file set the lane owned when it started.
  const census = discoverTestFiles(spec.cwd, spec.testDir);
  const reportDir = mkdtempSync(join(options.scratchRoot ?? tmpdir(), 'mangostudio-test-workers-'));
  try {
    const plans = planWorkers(spec, options.count, reportDir);
    const runs = await runWorkers(plans, options.start, options);
    const verdict = judgeWorkers({
      runs,
      census,
      testDir: spec.testDir,
      readReport: (path) => (existsSync(path) ? readFileSync(path, 'utf8') : null),
    });
    if (verdict.mergedXml) writeFileSync(options.mergedPath, verdict.mergedXml);
    return { verdict, wallMs: Math.round(performance.now() - began) };
  } finally {
    rmSync(reportDir, { recursive: true, force: true });
  }
}
