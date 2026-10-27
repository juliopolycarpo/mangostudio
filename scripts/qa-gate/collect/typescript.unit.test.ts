import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { countTsErrors } from './typescript';

/** Named fake of Bun check: what it prints and exits with. */
const makeFakeChecker = (result: { stdout?: string; stderr?: string; exitCode: number }) => {
  const commands: string[][] = [];
  const run = (cmd: readonly string[]) => {
    commands.push([...cmd]);
    return Promise.resolve({ stdout: result.stdout ?? '', stderr: result.stderr ?? '', ...result });
  };
  return { run, commands };
};

describe('countTsErrors', () => {
  it('counts diagnostics from a failing type-check', async () => {
    const checker = makeFakeChecker({
      exitCode: 2,
      stdout: 'a.ts(1,1): error TS2322: bad\nb.ts(2,2): error TS7006: worse\n',
    });

    expect(await countTsErrors('apps/api', checker.run)).toBe(2);
    expect(checker.commands[0]).toEqual([
      'bun',
      'check',
      '--no-script',
      '--all',
      '--no-pretty',
      '-p',
      'apps/api/tsconfig.json',
    ]);
  });

  it('counts all real diagnostics even when the project has a check script', async () => {
    const root = mkdtempSync(join(tmpdir(), 'chore-bun-typecheck-qa-'));
    try {
      writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { check: 'exit 99' } }));
      writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ include: ['source.ts'] }));
      writeFileSync(
        join(root, 'source.ts'),
        Array.from({ length: 60 }, (_, i) => `const value${i}: number = 'bad';`).join('\n')
      );
      expect(await countTsErrors(root)).toBe(60);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports a clean type-check as a real zero', async () => {
    expect(await countTsErrors('scripts', makeFakeChecker({ exitCode: 0 }).run)).toBe(0);
  });

  // Regression: the exit code was ignored, so a checker that was killed or could
  // not start printed no `error TS` lines and read as a measured zero.
  it.each([
    ['killed (OOM)', { exitCode: 137, stderr: 'Killed' }],
    ['failed to spawn', { exitCode: 127, stderr: 'bun: command not found' }],
    ['crashed', { exitCode: 1, stderr: 'RangeError: Maximum call stack size exceeded' }],
  ])('throws instead of reporting zero errors when Bun check %s', async (_label, result) => {
    const checker = makeFakeChecker(result);

    await expect(countTsErrors('packages/protocol', checker.run)).rejects.toThrow(
      `bun check for packages/protocol exited ${result.exitCode} with no diagnostics: ${result.stderr}`
    );
  });

  it('clips stderr in the failure message', async () => {
    const checker = makeFakeChecker({ exitCode: 1, stderr: 'x'.repeat(5000) });

    await expect(countTsErrors('scripts', checker.run)).rejects.toThrow(/^.{0,400}$/);
  });
});
