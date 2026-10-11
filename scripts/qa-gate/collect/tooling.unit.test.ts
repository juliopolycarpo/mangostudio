import { describe, expect, it } from 'bun:test';

import type { RunResult } from './support';
import { collectToolingStats } from './tooling';

/** Named fake of the check process: its output, exit code, or spawn error. */
const makeFakeCheck = (result: RunResult | Error) => {
  const commands: string[][] = [];
  const run = (cmd: readonly string[]) => {
    commands.push([...cmd]);
    if (result instanceof Error) throw result;
    return Promise.resolve(result);
  };
  return { run, commands };
};

describe('collectToolingStats', () => {
  it('retains the failed check exit code and ANSI task labels from both output streams', async () => {
    const check = makeFakeCheck({
      exitCode: 1,
      stdout: '  \u001b[31mFAIL\u001b[0m \u001b[1mtypecheck\u001b[0m 12 ms\n  PASS format 4 ms\n',
      stderr: '  \u001b[31mFAIL\u001b[0m \u001b[1mlint\u001b[0m 5 ms\n',
    });

    expect(await collectToolingStats(check.run)).toEqual({
      checkExitCode: 1,
      failedTasks: ['typecheck', 'lint'],
    });
    expect(check.commands).toEqual([['bun', 'run', 'check']]);
  });

  it('records a successful check without failed tasks', async () => {
    const check = makeFakeCheck({
      exitCode: 0,
      stdout: '  PASS typecheck 12 ms\n',
      stderr: '  PASS lint 5 ms\n',
    });

    expect(await collectToolingStats(check.run)).toEqual({
      checkExitCode: 0,
      failedTasks: [],
    });
  });

  it('retains a signal exit code even when no task label was emitted', async () => {
    const check = makeFakeCheck({ exitCode: 143, stdout: '', stderr: 'Terminated\n' });

    expect(await collectToolingStats(check.run)).toEqual({
      checkExitCode: 143,
      failedTasks: [],
    });
  });

  it('propagates a thrown runner error', async () => {
    const error = new Error('spawn bun ENOENT');
    const check = makeFakeCheck(error);

    await expect(collectToolingStats(check.run)).rejects.toBe(error);
  });
});
