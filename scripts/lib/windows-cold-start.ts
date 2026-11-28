// First-start timings for the Windows pull-request test job.
//
// 18 of about 500 `Windows API and scripts tests` jobs between 2026-11-17 and 2026-11-28 lost a
// spawn-bound test to the 15 s default timeout (#2661); four more on one branch were the same
// two signal tests failing deterministically and are not counted. In 14 of 93 jobs before the
// install.ps1 warm-up (#2669) the first case of install-ps1-layout took 5.5 to 17 s while the
// cases after it took about 0.7 s, and the same shape showed on the first `install.sh layout`
// case (13.3 s and 15.1 s, then 1.3 s and 2.3 s, then 0.15 s). A first start that decays over
// three cases points at something cold, not at a slow test. This module times that directly,
// before any test runs, so the stall is reported by name outside a test's 15 s bound.
//
// It tests the cold-start hypothesis only. Three of the 18 jobs were slow across many tests at
// once (20 to 70 s, the burst shape in #2661), minutes into the job, and a probe that runs at
// minute 0 cannot see a host that stalls later. Those bursts stay unexplained until a sampler
// that runs beside the lanes records them. This step reports:
//
// - each tool the layout tests start, run twice (first and second start);
// - a read of every file under the trees those tools load from, to see whether the disk is
//   what is cold;
// - the Defender state, which rules a scan in or out per VM.
//
// It never fails the job. The pre-read warms the same files the tests will touch, so a first
// run with this step in place is also the experiment: the first-case durations in the test
// lane should fall to the second-case level.

import { closeSync, fstatSync, openSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, win32 } from 'node:path';

/** One start-up measurement: the same command run twice, back to back. */
export interface StartTiming {
  readonly label: string;
  readonly firstMs: number;
  readonly secondMs: number;
  readonly exitCode: number | null;
}

/** What reading one directory tree cost. */
export interface TreeReadTiming {
  readonly label: string;
  readonly root: string;
  readonly files: number;
  readonly bytes: number;
  readonly ms: number;
  /** Files skipped because they were over the per-file cap or unreadable. */
  readonly skipped: number;
  /** True when the time budget ran out before the tree was read to its end. */
  readonly truncated: boolean;
}

/** A command whose first start the tests pay for. */
export interface StartTarget {
  readonly label: string;
  readonly command: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}

/** Runs a command to completion and returns its exit code; the seam for a named fake. */
export type RunCommand = (
  command: readonly string[],
  env: Readonly<Record<string, string>> | undefined
) => number | null;

/**
 * Starts `target` twice and times each run.
 *
 * @example
 * timeStarts({ label: 'bash', command: ['bash', '-c', 'true'] }, run, performance.now);
 */
export function timeStarts(target: StartTarget, run: RunCommand, now: () => number): StartTiming {
  const first = now();
  const exitCode = run(target.command, target.env);
  const firstMs = Math.round(now() - first);
  const second = now();
  run(target.command, target.env);
  return { label: target.label, firstMs, secondMs: Math.round(now() - second), exitCode };
}

/** Every file under `root`, depth first; unreadable directories are skipped. */
function listFiles(root: string): string[] {
  const files: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop() as string;
    let entries: string[];
    try {
      entries = readdirSync(directory);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(directory, entry);
      try {
        if (statSync(path).isDirectory()) pending.push(path);
        else files.push(path);
      } catch {
        // A vanished or locked entry is not part of the measurement.
      }
    }
  }
  return files;
}

/** The bounds of one tree read. */
export interface TreeReadLimits {
  /** Files over this size are skipped: a multi-hundred-megabyte toolchain file is not a start-up cost. */
  readonly maxFileBytes: number;
  /** The read stops once this much time has passed, so a very cold disk cannot hold the job. */
  readonly budgetMs: number;
}

/**
 * Reads every file under `root` once, discarding the bytes, and times it.
 *
 * @example
 * readTree('git', 'C:\\Program Files\\Git\\usr\\bin', { maxFileBytes: 64e6, budgetMs: 30e3 }, performance.now);
 */
export function readTree(
  label: string,
  root: string,
  limits: TreeReadLimits,
  now: () => number
): TreeReadTiming {
  const started = now();
  let files = 0;
  let bytes = 0;
  let skipped = 0;
  let truncated = false;
  for (const path of listFiles(root)) {
    if (now() - started > limits.budgetMs) {
      truncated = true;
      break;
    }
    // One descriptor for the size check and the read, so both see the same file.
    let descriptor: number | undefined;
    try {
      descriptor = openSync(path, 'r');
      if (fstatSync(descriptor).size > limits.maxFileBytes) {
        skipped += 1;
      } else {
        bytes += readFileSync(descriptor).byteLength;
        files += 1;
      }
    } catch {
      skipped += 1;
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  }
  return { label, root, files, bytes, ms: Math.round(now() - started), skipped, truncated };
}

/**
 * The Git for Windows install root that holds `bin\bash.exe`, found by walking
 * up from the `git.exe` on PATH. Which `git.exe` PATH names depends on the
 * shell: `<Git>\cmd\git.exe` from PowerShell, `<Git>\ucrt64\bin\git.exe` (or
 * `mingw64`) from a Git Bash step, so "one level up" is the root only for the
 * first. The first probe run looked under `<Git>\ucrt64` and timed nothing.
 *
 * @example
 * findGitRoot('C:\\Program Files\\Git\\ucrt64\\bin\\git.exe', existsSync); // 'C:\\Program Files\\Git'
 */
export function findGitRoot(
  gitExecutable: string,
  exists: (path: string) => boolean
): string | undefined {
  let directory = win32.dirname(gitExecutable);
  // Four levels cover every layout Git for Windows ships; a stray git.exe elsewhere finds nothing.
  for (let level = 0; level < 4; level += 1) {
    if (exists(win32.join(directory, 'bin', 'bash.exe'))) return directory;
    const parent = win32.dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
  return undefined;
}

/** Marks a run whose first start is far above its second: the cold start the tests hit. */
const COLD_START_RATIO = 4;
const COLD_START_FLOOR_MS = 1_500;

/**
 * One log line for a start timing, flagged when the first start is the cold kind.
 *
 * @example
 * formatStartTiming({ label: 'bash', firstMs: 9000, secondMs: 300, exitCode: 0 });
 */
export function formatStartTiming(timing: StartTiming): string {
  const cold =
    timing.firstMs >= COLD_START_FLOOR_MS && timing.firstMs >= timing.secondMs * COLD_START_RATIO;
  return `[windows-cold-start] start ${timing.label}: first ${timing.firstMs} ms, second ${timing.secondMs} ms, exit ${timing.exitCode}${cold ? ' COLD' : ''}`;
}

/**
 * One log line for a tree read.
 *
 * @example
 * formatTreeRead({ label: 'git', root: 'C:\\Git', files: 3, bytes: 3_000_000, ms: 1200, skipped: 0, truncated: false });
 */
export function formatTreeRead(timing: TreeReadTiming): string {
  const megabytes = (timing.bytes / 1_000_000).toFixed(1);
  const tail = `${timing.skipped > 0 ? `, ${timing.skipped} skipped` : ''}${timing.truncated ? ', TRUNCATED at the budget' : ''}`;
  return `[windows-cold-start] read ${timing.label}: ${timing.files} files, ${megabytes} MB in ${timing.ms} ms${tail} (${timing.root})`;
}
