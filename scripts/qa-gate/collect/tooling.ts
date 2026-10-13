// Repository tooling signal from this collector's local Check subprocess.
// Human output is never evidence: the versioned result must match the caller.

import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CHECK_RESULT_MAX_BYTES, parseCheckResult } from '../../lib/check-result';
import { runCapture } from './support';
import type { ToolingCheckStats } from './types';

interface CheckReportFile {
  stat(): Promise<{ readonly size: number; isFile(): boolean }>;
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number
  ): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
}

/** Check and read the same descriptor, bounded even if the report grows. */
export const readCheckReport = async (
  path: string,
  openFile: (path: string) => Promise<CheckReportFile> = (path) =>
    open(path, constants.O_RDONLY | constants.O_NONBLOCK)
): Promise<string> => {
  const file = await openFile(path);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > CHECK_RESULT_MAX_BYTES) {
      throw new Error(`expected a report file of at most ${CHECK_RESULT_MAX_BYTES} bytes`);
    }
    // Reading one extra byte detects growth beyond the cap after fstat. Short
    // reads are retried on this descriptor; its path is never opened again.
    const buffer = Buffer.alloc(CHECK_RESULT_MAX_BYTES + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await file.read(buffer, total, buffer.length - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    if (total > CHECK_RESULT_MAX_BYTES) {
      throw new Error(`Check report grew beyond ${CHECK_RESULT_MAX_BYTES} bytes`);
    }
    return buffer.subarray(0, total).toString('utf8');
  } finally {
    await file.close();
  }
};

/**
 * Run Check locally and validate its report before extracting failed labels.
 * Missing/invalid/incomplete evidence throws into measure()'s unavailable state.
 * Per-component TypeScript counts still come from collect/typescript.ts.
 * // Usage: await collectToolingStats()
 */
export const collectToolingStats = async (
  run: typeof runCapture = runCapture
): Promise<ToolingCheckStats> => {
  const directory = await mkdtemp(join(tmpdir(), 'mango-check-result-'));
  const path = join(directory, 'result.json');
  const invocationId = randomUUID();
  const args = ['--all'];
  try {
    const result = await run([
      'bun',
      'run',
      'check',
      ...args,
      '--report-file',
      path,
      '--report-id',
      invocationId,
    ]);
    let text: string;
    try {
      text = await readCheckReport(path);
    } catch (caught) {
      const reason = caught instanceof Error ? caught.message : String(caught);
      throw new Error(`Check exited ${result.exitCode} without a readable report: ${reason}`);
    }
    const report = parseCheckResult(text, { invocationId, args, exitCode: result.exitCode });
    if (report.state === 'unavailable') {
      const reasons = report.tasks
        .filter((task) => task.state === 'unavailable')
        .map((task) => `${task.label}: ${task.reason}`);
      if (report.error) reasons.unshift(report.error);
      throw new Error(`Check result unavailable (exit ${result.exitCode}): ${reasons.join('; ')}`);
    }
    return {
      checkExitCode: report.exitCode,
      failedTasks: report.tasks
        .filter((task) => task.state === 'executed' && task.exitCode !== 0)
        .map((task) => task.label),
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};
