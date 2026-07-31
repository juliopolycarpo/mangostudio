import { afterEach, describe, expect, it } from 'bun:test';
import type { RuntimeCapabilityManifest } from '@mangostudio/shared/runtime-protocol';
import {
  buildGitArgv,
  buildGitEnvironment,
  GitCliError,
  runGit,
} from '../../../../src/modules/git/infrastructure/git-cli';
import type { RuntimeClient } from '../../../../src/services/runtime-client/runtime-client';
import {
  RuntimeConnectionManager,
  setRuntimeConnectionManagerForTests,
} from '../../../../src/services/runtime-client/runtime-connection-manager';

const hasGit = Bun.which('git') !== null;
const TEST_MANIFEST: RuntimeCapabilityManifest = {
  platform: 'linux',
  arch: 'x64',
  pathStyle: 'posix',
  homeDir: '/remote/home',
  shells: ['bash'],
  git: { available: true, version: '2.51.0' },
  features: {
    tools: true,
    git: true,
    probing: false,
    mcp: false,
    library: false,
    checkpoints: true,
  },
};

afterEach(() => {
  setRuntimeConnectionManagerForTests(undefined);
});

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

  it('executes against the explicitly selected environment runtime', async () => {
    const resolutions: Array<{ userId: string; environmentId: string }> = [];
    const executions: Array<{ args: readonly string[]; cwd: string }> = [];
    const client = {
      manifest: TEST_MANIFEST,
      git: {
        exec: (params: { args: readonly string[]; cwd: string }) => {
          executions.push(params);
          return Promise.resolve({ stdout: 'remote status', stderr: '', exitCode: 0 });
        },
      },
    } as RuntimeClient;
    const manager = new RuntimeConnectionManager({
      resolveEnvironment: (userId, environmentId) => {
        resolutions.push({ userId, environmentId });
        return Promise.resolve({
          id: environmentId,
          userId,
          name: 'Remote',
          transportKind: 'stdio',
          config: {},
          enabled: true,
        });
      },
      connectors: {
        stdio: () => Promise.resolve({ client, close: () => undefined }),
      },
    });
    setRuntimeConnectionManagerForTests(manager);

    const result = await runGit(['status', '--short'], {
      cwd: '/remote/repo',
      userId: 'user-1',
      environmentId: 'devbox',
    });

    expect(result.stdout).toBe('remote status');
    expect(resolutions).toEqual([{ userId: 'user-1', environmentId: 'devbox' }]);
    expect(executions).toEqual([{ args: ['status', '--short'], cwd: '/remote/repo' }]);
  });
});
