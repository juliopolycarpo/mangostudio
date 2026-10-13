import { describe, expect, it } from 'bun:test';
import { access, writeFile } from 'node:fs/promises';

import { CHECK_RESULT_MAX_BYTES, type CheckResult } from '../../lib/check-result';
import { completedCheckFixture, executedCheckTask } from '../../tests/support/check-result-fixture';
import { measure, type RunResult } from './support';
import { collectToolingStats } from './tooling';

/** A local process fixture writes to the actual caller-selected report file. */
const makeFakeCheck = (
  result: RunResult | Error,
  report: ((fixture: CheckResult) => unknown) | string | null = (fixture) => fixture
) => {
  const commands: string[][] = [];
  const run = async (cmd: readonly string[]) => {
    commands.push([...cmd]);
    if (result instanceof Error) throw result;
    const path = cmd[cmd.indexOf('--report-file') + 1];
    const invocationId = cmd[cmd.indexOf('--report-id') + 1];
    const fixture = {
      ...completedCheckFixture(),
      invocationId,
    };
    if (report !== null) {
      await writeFile(path, typeof report === 'string' ? report : JSON.stringify(report(fixture)));
    }
    return result;
  };
  return { run, commands };
};

const success = { exitCode: 0, stdout: '', stderr: '' };
const failure = { exitCode: 1, stdout: '', stderr: '' };

describe('collectToolingStats', () => {
  it('retains multiple failures from structured tasks without parsing either console stream', async () => {
    const check = makeFakeCheck(failure, (fixture) => ({
      ...fixture,
      ...completedCheckFixture([
        executedCheckTask('workspaces:check', 2),
        executedCheckTask('root:biome', 7),
        executedCheckTask('root:dprint'),
      ]),
      invocationId: fixture.invocationId,
    }));
    expect(await collectToolingStats(check.run)).toEqual({
      checkExitCode: 1,
      failedTasks: ['workspaces:check', 'root:biome'],
    });
    expect(check.commands[0].slice(0, 5)).toEqual([
      'bun',
      'run',
      'check',
      '--all',
      '--report-file',
    ]);
    await expect(access(check.commands[0][5])).rejects.toThrow();
  });

  it('records success even if unrelated nested logs contain ANSI FAIL text', async () => {
    const check = makeFakeCheck({
      ...success,
      stdout: '  \u001b[31mFAIL\u001b[0m unrelated-fixture 12ms\n',
      stderr: '  FAIL another-nested-fixture 5ms\n',
    });
    expect(await collectToolingStats(check.run)).toEqual({ checkExitCode: 0, failedTasks: [] });
  });

  it.each([0, 1, 143])(
    'missing report after exit %i is unavailable, never green or zero',
    async (exitCode) => {
      const check = makeFakeCheck({ ...success, exitCode }, null);
      const measurement = await measure('tooling', () => collectToolingStats(check.run));
      expect(measurement.state).toBe('unavailable');
      expect(measurement).not.toHaveProperty('value');
      expect(JSON.stringify(measurement)).toContain(`Check exited ${exitCode}`);
    }
  );

  it.each(['', '{"kind":"mangostudio.check-result",'])(
    'empty or truncated report is unavailable: %s',
    async (text) => {
      const check = makeFakeCheck(success, text);
      await expect(collectToolingStats(check.run)).rejects.toThrow('not valid JSON');
    }
  );

  it('rejects unexpected report fields', async () => {
    const check = makeFakeCheck(success, (fixture) => ({ ...fixture, unexpected: true }));
    await expect(collectToolingStats(check.run)).rejects.toThrow('schema validation');
  });

  it('rejects a success report when the observed process fails or is interrupted', async () => {
    const check = makeFakeCheck({ ...success, exitCode: 143 });
    await expect(collectToolingStats(check.run)).rejects.toThrow('subprocess exit 143');
  });

  it('setup failure and unavailable task labels become explicit unavailable reasons', async () => {
    const check = makeFakeCheck(failure, (fixture) => ({
      ...fixture,
      state: 'unavailable',
      exitCode: 1,
      error: 'Tool setup failed',
      tasks: [{ label: 'workspaces:check', state: 'unavailable', reason: 'spawn turbo ENOENT' }],
    }));
    const measurement = await measure('tooling', () => collectToolingStats(check.run));
    expect(measurement.state).toBe('unavailable');
    expect(JSON.stringify(measurement)).toContain('Tool setup failed');
    expect(JSON.stringify(measurement)).toContain('workspaces:check: spawn turbo ENOENT');
  });

  it('rejects another local invocation identity', async () => {
    const check = makeFakeCheck(success, (fixture) => ({
      ...fixture,
      invocationId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    }));
    await expect(collectToolingStats(check.run)).rejects.toThrow('identity');
  });

  it('rejects an oversize report file', async () => {
    const check = makeFakeCheck(success, ' '.repeat(CHECK_RESULT_MAX_BYTES + 1));
    await expect(collectToolingStats(check.run)).rejects.toThrow('without a readable report');
  });

  it('propagates a thrown runner error and removes the caller temporary directory', async () => {
    const error = new Error('spawn bun ENOENT');
    const check = makeFakeCheck(error);
    await expect(collectToolingStats(check.run)).rejects.toBe(error);
    await expect(access(check.commands[0][5])).rejects.toThrow();
  });
});
