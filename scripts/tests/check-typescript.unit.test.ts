import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writeTypeScriptReceipt } from '../check-typescript';
import { parseCheckerReceipt } from '../lib/ci-check-evidence';

function makeFakeChecker(output: { stdout: string; stderr: string; exitCode: number } | Error) {
  const calls: string[][] = [];
  return {
    calls,
    run(command: readonly string[]) {
      calls.push([...command]);
      return output instanceof Error ? Promise.reject(output) : Promise.resolve(output);
    },
  };
}
test('supervised checker receipt binds failures and complete diagnostic counts', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mango-check-worker-test-'));
  const path = join(directory, 'result.json');
  try {
    const checker = makeFakeChecker({
      stdout: 'file.ts: error TS1234: expected string',
      stderr: '',
      exitCode: 1,
    });
    expect(await writeTypeScriptReceipt('apps/api', path, 'invocation', checker.run)).toBe(1);
    const text = readFileSync(path, 'utf8');
    expect(parseCheckerReceipt(text, 'apps/api', 'invocation', 1)).toEqual({
      root: 'apps/api',
      state: 'completed',
      errors: 1,
    });
    expect(checker.calls).toEqual([
      ['bun', 'check', '--no-script', '--all', '--no-pretty', '-p', 'apps/api/tsconfig.json'],
    ]);
    expect(() => parseCheckerReceipt(text, 'scripts', 'invocation', 1)).toThrow('expected scripts');
    expect(() => parseCheckerReceipt(text, 'apps/api', 'different', 1)).toThrow('different');
    expect(() => parseCheckerReceipt(text, 'apps/api', 'invocation', 0)).toThrow('exit 0');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
test('checker setup failure produces an unavailable receipt rather than zero', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mango-check-worker-test-'));
  const path = join(directory, 'result.json');
  try {
    const checker = makeFakeChecker(new Error('checker unavailable'));
    expect(await writeTypeScriptReceipt('scripts', path, 'invocation', checker.run)).toBe(1);
    expect(
      parseCheckerReceipt(readFileSync(path, 'utf8'), 'scripts', 'invocation', 1)
    ).toMatchObject({ state: 'unavailable', reason: 'checker unavailable' });
    await writeTypeScriptReceipt('../outside', path, 'invocation', checker.run);
    expect(checker.calls).toHaveLength(1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
