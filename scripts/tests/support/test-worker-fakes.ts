// Named fakes for the test-worker runner: reports shaped like Bun's, and workers
// that end the way real ones do (pass, fail, vanish, get killed, hang). None
// starts a process, so a verdict test states which failure it is about.

import { writeFileSync } from 'node:fs';

import type { Leftover } from '../../lib/test-worker-settle';
import type { StartWorker, WorkerExit, WorkerHandle, WorkerPlan } from '../../lib/test-workers';

/** A test file and the names of the cases it registers. */
export interface FakeTestFile {
  readonly path: string;
  readonly cases: readonly string[];
  /** Outcome of every case in the file; passing by default. */
  readonly outcome?: 'pass' | 'fail' | 'skip';
}

const attr = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function caseXml(file: FakeTestFile, name: string, line: number): string {
  const open = `<testcase name="${attr(name)}" classname="" time="0.001" file="${file.path}" line="${line}" assertions="1"`;
  if (file.outcome === 'fail') {
    return `    ${open}>\n      <failure type="AssertionError" message="boom" />\n    </testcase>`;
  }
  if (file.outcome === 'skip') return `    ${open}>\n      <skipped />\n    </testcase>`;
  return `    ${open} />`;
}

/**
 * A whole Bun-shaped report for `files`: one `<testsuite>` per file, a header
 * whose counters agree with the cases.
 * // Usage: reportOf([{ path: 'tests/unit/a.test.ts', cases: ['one', 'two'] }])
 */
export function reportOf(files: readonly FakeTestFile[]): string {
  const count = (outcome: FakeTestFile['outcome']): number =>
    files
      .filter((file) => (file.outcome ?? 'pass') === (outcome ?? 'pass'))
      .reduce((total, file) => total + file.cases.length, 0);
  const total = files.reduce((sum, file) => sum + file.cases.length, 0);
  const suites = files.map((file) =>
    [
      `  <testsuite name="${file.path}" file="${file.path}" tests="${file.cases.length}" assertions="${file.cases.length}" failures="0" skipped="0" time="0.5">`,
      ...file.cases.map((name, index) => caseXml(file, name, index + 1)),
      '  </testsuite>',
    ].join('\n')
  );
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites name="bun test" tests="${total}" assertions="${total}" failures="${count('fail')}" skipped="${count('skip')}" time="1.5">`,
    ...suites,
    '</testsuites>',
    '',
  ].join('\n');
}

/**
 * A lane of `fileCount` files with `casesPerFile` cases each, named so a missing
 * one is recognisable in a message.
 * // Usage: const lane = fakeLane(9, 3);
 */
export function fakeLane(fileCount: number, casesPerFile: number): FakeTestFile[] {
  return Array.from({ length: fileCount }, (_, file) => {
    const path = `tests/unit/area-${String(file).padStart(2, '0')}/thing-${file}.test.ts`;
    return {
      path,
      cases: Array.from({ length: casesPerFile }, (_, item) => `case ${file}.${item}`),
    };
  });
}

/**
 * The files `--shard=index/count` gives a worker: file `k` of the sorted list
 * goes to shard `k % count + 1`, which is Bun's rule without a timings file.
 */
export function shardOf(
  files: readonly FakeTestFile[],
  plan: Pick<WorkerPlan, 'index' | 'count'>
): FakeTestFile[] {
  return [...files]
    .sort((a, b) => a.path.localeCompare(b.path))
    .filter((_, position) => position % plan.count === plan.index - 1);
}

/** In-memory report files, keyed by path, standing in for the disk. */
export class FakeReportDisk {
  readonly files = new Map<string, string>();

  write(path: string, xml: string): void {
    this.files.set(path, xml);
  }

  read = (path: string): string | null => this.files.get(path) ?? null;
}

const settled = (exit: WorkerExit): WorkerHandle => ({
  exited: Promise.resolve(exit),
  kill: () => undefined,
});

/** Ends with exit 0 after writing the report for its shard of `lane`. */
export const healthyWorker =
  (lane: readonly FakeTestFile[], disk: FakeReportDisk): StartWorker =>
  (plan) => {
    disk.write(plan.reportPath, reportOf(shardOf(lane, plan)));
    return {
      ...settled({ exitCode: 0, signal: null }),
      settle: plan.settle ? () => Promise.resolve([]) : undefined,
    };
  };

/** Like {@link healthyWorker}, but the report lands on the real disk, where `runWorkerLane` reads it. */
export const diskWorker =
  (lane: readonly FakeTestFile[]): StartWorker =>
  (plan) => {
    writeFileSync(plan.reportPath, reportOf(shardOf(lane, plan)));
    return {
      ...settled({ exitCode: 0, signal: null }),
      settle: plan.settle ? () => Promise.resolve([]) : undefined,
    };
  };

/** Like {@link healthyWorker}, except `index` ends with `exit` instead. */
export const withWorker =
  (index: number, replacement: StartWorker, others: StartWorker): StartWorker =>
  (plan) =>
    (plan.index === index ? replacement : others)(plan);

/** Fails its cases: writes a whole report that lists them and exits 1, as `bun test` does. */
export const failingWorker =
  (lane: readonly FakeTestFile[], disk: FakeReportDisk): StartWorker =>
  (plan) => {
    const failing = shardOf(lane, plan).map((file) => ({ ...file, outcome: 'fail' as const }));
    disk.write(plan.reportPath, reportOf(failing));
    return settled({ exitCode: 1, signal: null });
  };

/** Exits non-zero before writing anything. */
export const crashingWorker =
  (exitCode: number): StartWorker =>
  () =>
    settled({ exitCode, signal: null });

/** Exits 0 and leaves no report, the way Bun does when `--reporter-outfile`'s directory is missing. */
export const silentWorker: StartWorker = () => settled({ exitCode: 0, signal: null });

/** Is ended by `signal` (the OOM killer's SIGKILL, say) without a report. */
export const killedWorker =
  (signal: string): StartWorker =>
  () =>
    settled({ exitCode: null, signal });

/** Exits 0 after writing `xml`, whatever it is. */
export const writingWorker =
  (xml: string, disk: FakeReportDisk): StartWorker =>
  (plan) => {
    disk.write(plan.reportPath, xml);
    return settled({ exitCode: 0, signal: null });
  };

/** Cannot be started at all, as a missing executable cannot. */
export const unstartableWorker =
  (reason: string): StartWorker =>
  () => {
    throw new Error(reason);
  };

/** A worker that runs until it is killed and records the signals it received. */
export class HangingWorker {
  readonly signals: string[] = [];
  /** Signals that actually end it; SIGTERM alone does not when `ignoresSigterm` is set. */
  constructor(private readonly ignoresSigterm = false) {}

  start: StartWorker = () => {
    let end: (exit: WorkerExit) => void = () => undefined;
    const exited = new Promise<WorkerExit>((resolve) => {
      end = resolve;
    });
    return {
      exited,
      kill: (signal) => {
        this.signals.push(signal);
        if (signal === 'SIGTERM' && this.ignoresSigterm) return;
        end({ exitCode: null, signal });
      },
    };
  };
}

/**
 * The same worker, with a settlement check that finds `leftovers` still running
 * once it has exited, as a worker whose test leaked a child would.
 * // Usage: withLeftovers(healthyWorker(lane, disk), [{ pid: 4242, command: 'sleep 600' }])
 */
export const withLeftovers =
  (inner: StartWorker, leftovers: readonly Leftover[]): StartWorker =>
  (plan) => ({ ...inner(plan), settle: () => Promise.resolve(leftovers) });

/** The same worker, whose settlement check cannot read the process table. */
export const withUnreadableProcessTable =
  (inner: StartWorker, reason: string): StartWorker =>
  (plan) => ({ ...inner(plan), settle: () => Promise.reject(new Error(reason)) });
