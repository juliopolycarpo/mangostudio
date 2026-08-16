import { describe, expect, it } from 'bun:test';
import { RuntimeToolArgumentError } from '../../../src/errors';
import {
  buildGitArgv,
  buildGitEnvironment,
  execGit,
  GitExecutionError,
} from '../../../src/services/git';

const hasGit = Bun.which('git') !== null;
const isWindows = process.platform === 'win32';

describe('git CLI boundary', () => {
  it('assembles a direct argv without shell interpolation', () => {
    expect(buildGitArgv(['status', '--porcelain=v2', '--branch', '-z'])).toEqual([
      'git',
      'status',
      '--porcelain=v2',
      '--branch',
      '-z',
    ]);
  });

  it('forwards only Git runtime variables and pins parse-safe settings', () => {
    const env = buildGitEnvironment({
      PATH: '/bin',
      HOME: '/home/test',
      XDG_CONFIG_HOME: '/config',
      SSH_AUTH_SOCK: '/run/agent.sock',
      GNUPGHOME: '/home/test/.gnupg',
      LC_ALL: 'pt_BR.UTF-8',
      GITHUB_TOKEN: 'never-forward',
      PROVIDER_API_KEY: 'never-forward',
    });

    expect(env).toEqual({
      PATH: '/bin',
      HOME: '/home/test',
      XDG_CONFIG_HOME: '/config',
      // Commit signing needs the agent socket and GnuPG home to reach the key.
      SSH_AUTH_SOCK: '/run/agent.sock',
      GNUPGHOME: '/home/test/.gnupg',
      GIT_TERMINAL_PROMPT: '0',
      GIT_OPTIONAL_LOCKS: '0',
      LC_ALL: 'C',
    });
  });

  it('rejects non-array args', async () => {
    await expect(
      execGit({ args: 'status' as unknown as string[], cwd: process.cwd() })
    ).rejects.toBeInstanceOf(RuntimeToolArgumentError);
  });

  it('rejects args containing NUL bytes', async () => {
    await expect(execGit({ args: ['status\0'], cwd: process.cwd() })).rejects.toBeInstanceOf(
      RuntimeToolArgumentError
    );
  });

  it('rejects an empty cwd', async () => {
    await expect(execGit({ args: ['status'], cwd: '' })).rejects.toBeInstanceOf(
      RuntimeToolArgumentError
    );
  });

  it('rejects timeouts that would fire the kill timer immediately', async () => {
    for (const timeoutMs of [0, -1, Number.NaN, '5000' as unknown as number]) {
      await expect(
        execGit({ args: ['status'], cwd: process.cwd(), timeoutMs })
      ).rejects.toBeInstanceOf(RuntimeToolArgumentError);
    }
  });

  it('rejects accepted exit codes that are not an integer array', async () => {
    for (const acceptedExitCodes of [1 as unknown as number[], [1.5], ['1' as unknown as number]]) {
      await expect(
        execGit({ args: ['status'], cwd: process.cwd(), acceptedExitCodes })
      ).rejects.toBeInstanceOf(RuntimeToolArgumentError);
    }
  });

  it('rejects a string command field', async () => {
    await expect(
      execGit({
        args: ['status'],
        cwd: process.cwd(),
        command: 'git status',
      } as { args: string[]; cwd: string; command: string })
    ).rejects.toBeInstanceOf(RuntimeToolArgumentError);
  });

  it.skipIf(!hasGit)('maps non-zero exits to a structured GitExecutionError', async () => {
    const error = await execGit(
      { args: ['not-a-real-git-subcommand'], cwd: process.cwd() },
      undefined
    ).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(GitExecutionError);
    expect(error).toMatchObject({
      kind: 'git_execution',
      data: {
        exitCode: 1,
        args: ['not-a-real-git-subcommand'],
      },
    });
    expect((error as GitExecutionError).data.stderr).not.toEndWith('\n');
  });

  it.skipIf(!hasGit || isWindows)(
    'times out even when a descendant keeps the pipes open',
    async () => {
      // A shell alias that backgrounds a process inheriting stdout and stderr.
      // Killing Git alone leaves both streams open, so a capture that waits for
      // EOF never returns and the timeout it reports never reaches the caller.
      const startedAt = Date.now();
      const error = await execGit({
        args: ['-c', 'alias.hang=!sh -c "sleep 60 & echo started; sleep 60"', 'hang'],
        cwd: process.cwd(),
        timeoutMs: 1000,
      }).catch((cause: unknown) => cause);

      expect(error).toBeInstanceOf(GitExecutionError);
      expect((error as GitExecutionError).message).toBe('Git command timed out.');
      expect(Date.now() - startedAt).toBeLessThan(30_000);
    },
    60_000
  );

  it.skipIf(!hasGit || isWindows)(
    'returns when Git exits but a helper still holds the pipes',
    async () => {
      const startedAt = Date.now();
      const result = await execGit({
        args: ['-c', 'alias.hang=!sh -c "sleep 60 & echo done"', 'hang'],
        cwd: process.cwd(),
        timeoutMs: 400,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('done');
      expect(Date.now() - startedAt).toBeLessThan(10_000);
    },
    30_000
  );

  it.skipIf(!hasGit || isWindows)(
    'still reports a cap hit when leftover helpers hold the pipes',
    async () => {
      const error = await execGit({
        args: ['-c', 'alias.hang=!sh -c "head -c 1100000 /dev/zero; sleep 60 &"', 'hang'],
        cwd: process.cwd(),
        timeoutMs: 5_000,
      }).catch((cause: unknown) => cause);

      expect(error).toBeInstanceOf(GitExecutionError);
      expect((error as GitExecutionError).message).toContain('exceeded');
    },
    30_000
  );
});
