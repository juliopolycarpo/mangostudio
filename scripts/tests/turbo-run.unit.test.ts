import { expect, test } from 'bun:test';
import { join } from 'node:path';

import { ROOT_DIR } from '../lib/config';
import { runTurbo, turboDryRun, type TurboResult } from './support/turbo-run';

class CapturedTurbo {
  calls: { cmd: readonly string[]; cwd: string; env: NodeJS.ProcessEnv }[] = [];
  result: TurboResult = { exitCode: 0, stdout: '{"tasks":[]}', stderr: '' };

  run = (cmd: readonly string[], cwd: string, env: NodeJS.ProcessEnv) => {
    this.calls.push({ cmd, cwd, env });
    return Promise.resolve(this.result);
  };
}

test('dry runs use the fixture command owner instead of starting an unowned process', async () => {
  const owner = new CapturedTurbo();
  expect(await turboDryRun(ROOT_DIR, ['--fixture-never-execute'], owner.run)).toEqual([]);
  expect(owner.calls[0]?.cmd).toEqual([
    join(ROOT_DIR, 'node_modules', '.bin', 'turbo'),
    '--fixture-never-execute',
    '--dry=json',
  ]);
});

test('Turbo execution preserves output and passes fixture environment through the owner', async () => {
  const owner = new CapturedTurbo();
  owner.result = { exitCode: 7, stdout: 'out', stderr: 'err' };
  expect(
    await runTurbo(ROOT_DIR, ['run', 'typecheck'], { FIXTURE_ONLY: 'yes' }, owner.run)
  ).toEqual(owner.result);
  expect(owner.calls[0]?.cwd).toBe(ROOT_DIR);
  expect(owner.calls[0]?.env).toMatchObject({
    FIXTURE_ONLY: 'yes',
    TURBO_TELEMETRY_DISABLED: '1',
    TURBO_NO_UPDATE_NOTIFIER: '1',
    DO_NOT_TRACK: '1',
  });
});

test('dry run failures identify the exit, arguments and stderr from the owner', async () => {
  const owner = new CapturedTurbo();
  owner.result = { exitCode: 7, stdout: '', stderr: ' invalid fixture config\n' };
  await expect(turboDryRun(ROOT_DIR, ['run', 'typecheck'], owner.run)).rejects.toThrow(
    'expected turbo dry run exit: 0 | received: 7 | args: run typecheck | stderr: invalid fixture config'
  );
});
