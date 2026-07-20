import { describe, expect, it } from 'bun:test';
import {
  buildGitArgv,
  buildGitEnvironment,
  GitCliError,
  runGit,
} from '../../../../src/modules/git/infrastructure/git-cli';

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
      LC_ALL: 'pt_BR.UTF-8',
      GITHUB_TOKEN: 'never-forward',
      PROVIDER_API_KEY: 'never-forward',
    });

    expect(env).toEqual({
      PATH: '/bin',
      HOME: '/home/test',
      XDG_CONFIG_HOME: '/config',
      GIT_TERMINAL_PROMPT: '0',
      GIT_OPTIONAL_LOCKS: '0',
      LC_ALL: 'C',
    });
  });

  it.skipIf(!hasGit)('maps non-zero exits to a structured GitCliError', async () => {
    const error = await runGit(['not-a-real-git-subcommand'], { cwd: process.cwd() }).catch(
      (cause: unknown) => cause
    );

    expect(error).toBeInstanceOf(GitCliError);
    expect(error).toMatchObject({
      exitCode: 1,
      args: ['not-a-real-git-subcommand'],
    });
    expect((error as GitCliError).stderr).not.toEndWith('\n');
  });
});
