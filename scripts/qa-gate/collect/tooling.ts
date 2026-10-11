// Repository tooling signal: runs `bun run check` and records its exit code
// plus any task labels reported as FAIL.

import { runCapture } from './support';
import type { ToolingCheckStats } from './types';

// biome-ignore lint/complexity/useRegexLiterals: Keep the escape code out of a regex literal.
const ANSI_RE = new RegExp(String.raw`\x1B\[[0-?]*[ -/]*[@-~]`, 'g');

const collectFailedTasks = (text: string): string[] => {
  const failedTasks: string[] = [];

  for (const line of text.replaceAll(ANSI_RE, '').split('\n')) {
    const match = line.match(/^\s+FAIL\s+(\S+)\s+/);
    if (match) failedTasks.push(match[1]);
  }

  return failedTasks;
};

/**
 * Run the repository check and retain its exit code and failed task labels.
 * `run` is injected so tests can fake the check process.
 * // Usage: await collectToolingStats()
 */
export const collectToolingStats = async (
  run: typeof runCapture = runCapture
): Promise<ToolingCheckStats> => {
  const result = await run(['bun', 'run', 'check']);
  const combined = `${result.stdout}\n${result.stderr}`;

  return {
    checkExitCode: result.exitCode,
    failedTasks: collectFailedTasks(combined),
  };
};
