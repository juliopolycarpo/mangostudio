import { expect, test } from 'bun:test';
import { join } from 'node:path';

import { ROOT_DIR } from '../lib/config';
import { hermeticTurboEnv, runTurbo, turboDryRun, type TurboResult } from './support/turbo-run';

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

/** The environment of a developer who exported cache-affecting Turbo overrides. */
const CALLER_TURBO_OVERRIDES = {
  TURBO_FORCE: 'true',
  TURBO_CACHE_DIR: '/caller/turbo-cache',
  TURBO_TEAM: 'caller-team',
  PATH: '/caller/bin',
} satisfies NodeJS.ProcessEnv;

function expectEnvUnset(env: NodeJS.ProcessEnv, name: string): void {
  expect(
    env[name],
    `(turbo env): expected ${name}: unset | received: ${env[name]}`
  ).toBeUndefined();
}

test("the spawned Turbo env drops the caller's TURBO_* overrides and keeps the rest", () => {
  const env = hermeticTurboEnv({}, CALLER_TURBO_OVERRIDES);
  for (const name of ['TURBO_FORCE', 'TURBO_CACHE_DIR', 'TURBO_TEAM']) expectEnvUnset(env, name);
  expect(env.PATH, `(turbo env): expected PATH: /caller/bin | received: ${env.PATH}`).toBe(
    '/caller/bin'
  );
});

test('a TURBO_* variable a test passes on purpose wins over the scrub', () => {
  const env = hermeticTurboEnv(
    { TURBO_CACHE_DIR: '/fixture/cache', TURBO_FORCE: 'false' },
    CALLER_TURBO_OVERRIDES
  );
  expect(env.TURBO_CACHE_DIR).toBe('/fixture/cache');
  expect(env.TURBO_FORCE).toBe('false');
});

test('runTurbo hands the owner an env without the ambient TURBO_FORCE', async () => {
  const owner = new CapturedTurbo();
  const ambient = process.env.TURBO_FORCE;
  process.env.TURBO_FORCE = 'true';
  try {
    await runTurbo(ROOT_DIR, ['run', 'typecheck'], {}, owner.run);
  } finally {
    if (ambient === undefined) delete process.env.TURBO_FORCE;
    else process.env.TURBO_FORCE = ambient;
  }
  expectEnvUnset(owner.calls[0]?.env ?? {}, 'TURBO_FORCE');
});
