import { describe, expect, it } from 'bun:test';
import { RuntimeToolArgumentError } from '../../../src/errors';
import {
  buildGitArgv,
  buildGitEnvironment,
  execGit,
  GitExecutionError,
} from '../../../src/services/git';

const hasGit = Bun.which('git') !== null;

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
});
