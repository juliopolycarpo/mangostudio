import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ROOT_DIR } from '../lib/config';
import { useScratchDirs } from './support/scratch-dirs';

const makeScratchDir = useScratchDirs();
const CLI = join(ROOT_DIR, 'scripts', 'ci', 'runtime-base-reuse.ts');
const DIGEST = 'c'.repeat(64);

/**
 * Runs the real CLI with a `PATH` that holds no `gh`: every case below must be
 * decided before the first API read, so a read would fail loudly as a missing binary.
 */
function runCli(args: readonly string[], env: Record<string, string>) {
  const scratch = makeScratchDir('runtime-base-cli-');
  const output = join(scratch, 'output');
  const summary = join(scratch, 'summary.md');
  const child = Bun.spawnSync({
    cmd: [process.execPath, '--no-install', CLI, ...args],
    env: {
      PATH: scratch,
      GITHUB_OUTPUT: output,
      GITHUB_STEP_SUMMARY: summary,
      REPOSITORY: 'owner/repo',
      SOURCE_SHA: 'b'.repeat(40),
      CURRENT_RUN_ID: '900',
      EVENT_NAME: 'push',
      REF: 'refs/heads/main',
      ...env,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    exitCode: child.exitCode,
    stdout: child.stdout.toString(),
    stderr: child.stderr.toString(),
    output: existsSync(output) ? readFileSync(output, 'utf8') : '',
    summary: existsSync(summary) ? readFileSync(summary, 'utf8') : '',
  };
}

const RESOLVE = ['resolve', '--platform', 'linux-x64', '--profile', 'shipping', '--digest', DIGEST];

describe('runtime-base-reuse CLI', () => {
  test.each([
    [
      'a pull request',
      { EVENT_NAME: 'pull_request' },
      'expected event push | received: pull_request',
    ],
    ['a dispatch', { EVENT_NAME: 'workflow_dispatch' }, 'received: workflow_dispatch'],
    [
      'a release tag',
      { REF: 'refs/tags/v1.0.0' },
      'expected ref refs/heads/main | received: refs/tags/v1.0.0',
    ],
  ])('resolve on %s exits 0, says built from source and reads nothing', (_name, env, reason) => {
    const result = runCli(RESOLVE, env);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('reuse=false\n');
    expect(result.output).toContain(reason);
    expect(result.summary).toContain('### Runtime base linux-x64: built from source');
  });

  test('resolve for the light profile refuses', () => {
    const result = runCli(
      ['resolve', '--platform', 'linux-x64', '--profile', 'light', '--digest', DIGEST],
      {}
    );
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('reason=context: expected profile shipping | received: light');
  });

  test('an unknown command fails naming it and the accepted ones', () => {
    const result = runCli(['rebuild'], {});
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('expected command resolve | verify | received: rebuild');
  });

  test('verify refuses a context that may never reuse, before reading anything', () => {
    const result = runCli(
      [
        'verify',
        '--platform',
        'linux-x64',
        '--profile',
        'shipping',
        '--digest',
        DIGEST,
        '--dir',
        '/nowhere',
        '--record-out',
        '/nowhere',
        '--run-id',
        '7',
        '--artifact-id',
        '8',
      ],
      { EVENT_NAME: 'pull_request' }
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('expected a reusable context | received: expected event push');
    expect(result.output).toBe('');
  });

  test('verify without a run id fails naming the flag', () => {
    const result = runCli(
      [
        'verify',
        '--platform',
        'linux-x64',
        '--profile',
        'shipping',
        '--digest',
        DIGEST,
        '--dir',
        '/nowhere',
        '--record-out',
        '/nowhere',
        '--artifact-id',
        '8',
      ],
      {}
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('expected --run-id a positive integer | received: (unset)');
  });
});
