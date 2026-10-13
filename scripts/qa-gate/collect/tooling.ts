// Repository tooling signal from this collector's local Check subprocess.
// Human output is never evidence: the versioned result must match the caller.

import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CHECK_RESULT_MAX_BYTES, parseCheckResult } from '../../lib/check-result';
import { runCapture } from './support';
import type { ToolingCheckStats } from './types';

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
      const file = await stat(path);
      if (!file.isFile() || file.size > CHECK_RESULT_MAX_BYTES) {
        throw new Error(`expected a report file of at most ${CHECK_RESULT_MAX_BYTES} bytes`);
      }
      text = await readFile(path, 'utf8');
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
