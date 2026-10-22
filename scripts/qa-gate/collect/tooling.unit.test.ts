import { describe, expect, it } from 'bun:test';
import { access, mkdir, mkdtemp, open, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { CHECK_RESULT_MAX_BYTES, type CheckResult } from '../../lib/check-result';
import { completedCheckFixture, executedCheckTask } from '../../tests/support/check-result-fixture';
import { measure, type RunResult } from './support';
import { collectToolingStats, readCheckReport } from './tooling';

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

describe('bounded Check report descriptor', () => {
  it('reads the checked descriptor when another file replaces its path', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mango-report-descriptor-'));
    const path = join(directory, 'result.json');
    await writeFile(path, 'checked file');
    const file = await open(path, 'r');
    let opens = 0;
    let closes = 0;
    try {
      const text = await readCheckReport(path, () => {
        opens++;
        return Promise.resolve({
          stat: async () => {
            const info = await file.stat();
            await rename(path, join(directory, 'original.json'));
            await writeFile(path, 'replacement file');
            return info;
          },
          read: file.read.bind(file),
          close: async () => {
            closes++;
            await file.close();
          },
        });
      });
      expect(text).toBe('checked file');
      expect(opens).toBe(1);
      expect(closes).toBe(1);
      await expect(file.stat()).rejects.toThrow();
    } finally {
      await file.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('bounds bytes read and closes the descriptor when a small checked file grows', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mango-report-growth-'));
    const path = join(directory, 'result.json');
    await writeFile(path, '{}');
    const file = await open(path, 'r');
    let bytesRead = 0;
    let closes = 0;
    try {
      await expect(
        readCheckReport(path, async () => ({
          stat: async () => {
            const info = await file.stat();
            await writeFile(path, 'x'.repeat(CHECK_RESULT_MAX_BYTES * 2));
            return info;
          },
          read: async (buffer, offset, length, position) => {
            const result = await file.read(buffer, offset, length, position);
            bytesRead += result.bytesRead;
            return result;
          },
          close: async () => {
            closes++;
            await file.close();
          },
        }))
      ).rejects.toThrow('grew beyond');
      expect(bytesRead).toBe(CHECK_RESULT_MAX_BYTES + 1);
      expect(closes).toBe(1);
      await expect(file.stat()).rejects.toThrow();
    } finally {
      await file.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('continues short reads on one descriptor and accepts exactly the byte cap', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mango-report-short-read-'));
    const path = join(directory, 'result.json');
    const text = 'x'.repeat(CHECK_RESULT_MAX_BYTES);
    await writeFile(path, text);
    const file = await open(path, 'r');
    let reads = 0;
    try {
      expect(
        await readCheckReport(path, async () => ({
          stat: file.stat.bind(file),
          read: (buffer, offset, length, position) => {
            reads++;
            return file.read(buffer, offset, Math.min(length, 1024), position);
          },
          close: file.close.bind(file),
        }))
      ).toBe(text);
      expect(reads).toBeGreaterThan(1);
      await expect(file.stat()).rejects.toThrow();
    } finally {
      await file.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects a nonregular descriptor and closes it', async () => {
    let read = false;
    let closed = false;
    await expect(
      readCheckReport('nonregular', async () => ({
        stat: () => Promise.resolve({ size: 0, isFile: () => false }),
        read: () => {
          read = true;
          throw new Error('must not read');
        },
        close: () => {
          closed = true;
          return Promise.resolve();
        },
      }))
    ).rejects.toThrow('expected a report file');
    expect(read).toBe(false);
    expect(closed).toBe(true);
  });

  it('closes the descriptor after a read failure', async () => {
    const failure = new Error('descriptor read failed');
    let closed = false;
    await expect(
      readCheckReport('read-failure', async () => ({
        stat: () => Promise.resolve({ size: 1, isFile: () => true }),
        read: () => Promise.reject(failure),
        close: () => {
          closed = true;
          return Promise.resolve();
        },
      }))
    ).rejects.toBe(failure);
    expect(closed).toBe(true);
  });
});

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

  it('rejects a directory report and removes the temporary directory', async () => {
    const commands: string[][] = [];
    const run = async (cmd: readonly string[]) => {
      commands.push([...cmd]);
      await mkdir(cmd[cmd.indexOf('--report-file') + 1]);
      return success;
    };
    await expect(collectToolingStats(run)).rejects.toThrow('without a readable report');
    await expect(access(commands[0][5])).rejects.toThrow();
  });

  it('propagates a thrown runner error and removes the caller temporary directory', async () => {
    const error = new Error('spawn bun ENOENT');
    const check = makeFakeCheck(error);
    await expect(collectToolingStats(check.run)).rejects.toBe(error);
    // The fake throws before writing a report, so only the directory proves cleanup.
    await expect(access(dirname(check.commands[0][5]))).rejects.toThrow();
  });
});
