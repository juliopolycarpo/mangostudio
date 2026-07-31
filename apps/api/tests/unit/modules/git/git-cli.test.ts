import { describe, expect, it } from 'bun:test';
import {
  buildGitArgv,
  buildGitEnvironment,
  GitCliError,
  runGit,
} from '../../../../src/modules/git/infrastructure/git-cli';

const hasGit = Bun.which('git') !== null;

describe('hub git CLI facade', () => {
  it('re-exports argv and env helpers from the runtime', () => {
    expect(buildGitArgv(['status'])).toEqual(['git', 'status']);
    expect(buildGitEnvironment({ PATH: '/bin', SECRET: 'no' })).toMatchObject({
      PATH: '/bin',
      GIT_TERMINAL_PROMPT: '0',
      GIT_OPTIONAL_LOCKS: '0',
      LC_ALL: 'C',
    });
    expect(buildGitEnvironment({ PATH: '/bin', SECRET: 'no' }).SECRET).toBeUndefined();
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
