import { describe, expect, it } from 'bun:test';

import { countTsErrors } from './typescript';

/** Named fake of tsc: what it prints and exits with. */
const makeFakeTsc = (result: { stdout?: string; stderr?: string; exitCode: number }) => {
  const commands: string[][] = [];
  const run = (cmd: readonly string[]) => {
    commands.push([...cmd]);
    return Promise.resolve({ stdout: result.stdout ?? '', stderr: result.stderr ?? '', ...result });
  };
  return { run, commands };
};

describe('countTsErrors', () => {
  it('counts diagnostics from a failing type-check', async () => {
    const tsc = makeFakeTsc({
      exitCode: 2,
      stdout: 'a.ts(1,1): error TS2322: bad\nb.ts(2,2): error TS7006: worse\n',
    });

    expect(await countTsErrors('apps/api', tsc.run)).toBe(2);
    expect(tsc.commands[0]).toContain('apps/api/tsconfig.json');
  });

  it('reports a clean type-check as a real zero', async () => {
    expect(await countTsErrors('scripts', makeFakeTsc({ exitCode: 0 }).run)).toBe(0);
  });

  // Regression: the exit code was ignored, so a tsc that was killed or could
  // not start printed no `error TS` lines and read as a measured zero.
  it.each([
    ['killed (OOM)', { exitCode: 137, stderr: 'Killed' }],
    ['failed to spawn', { exitCode: 127, stderr: 'bunx: tsc: command not found' }],
    ['crashed', { exitCode: 1, stderr: 'RangeError: Maximum call stack size exceeded' }],
  ])('throws instead of reporting zero errors when tsc %s', async (_label, result) => {
    const tsc = makeFakeTsc(result);

    await expect(countTsErrors('packages/protocol', tsc.run)).rejects.toThrow(
      `tsc for packages/protocol exited ${result.exitCode} with no diagnostics: ${result.stderr}`
    );
  });

  it('clips stderr in the failure message', async () => {
    const tsc = makeFakeTsc({ exitCode: 1, stderr: 'x'.repeat(5000) });

    await expect(countTsErrors('scripts', tsc.run)).rejects.toThrow(/^.{0,400}$/);
  });
});
