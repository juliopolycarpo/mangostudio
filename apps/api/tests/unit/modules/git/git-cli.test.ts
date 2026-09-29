import { afterEach, describe, expect, it } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RemoteError } from '@mangostudio/protocol';
import type { RuntimeCapabilityManifest } from '@mangostudio/shared/runtime-contract';
import {
  GitCliError,
  isMissingWorkdirError,
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

  it('rejects a capture the runtime flagged incomplete instead of returning it', async () => {
    const client = {
      manifest: TEST_MANIFEST,
      git: {
        exec: (_params: { args: readonly string[]; cwd: string }) =>
          Promise.resolve({ stdout: '', stderr: '', exitCode: 0, incomplete: true as const }),
      },
    } as RuntimeClient;
    const manager = new RuntimeConnectionManager({
      resolveEnvironment: (userId, environmentId) =>
        Promise.resolve({
          id: environmentId,
          userId,
          name: 'Remote',
          transportKind: 'stdio',
          config: {},
          enabled: true,
        }),
      connectors: {
        stdio: () => Promise.resolve({ client, close: () => undefined }),
      },
    });
    setRuntimeConnectionManagerForTests(manager);

    const error = await runGit(['status', '--porcelain=v2'], { cwd: '/remote/repo' }).catch(
      (cause: unknown) => cause
    );

    expect(error).toBeInstanceOf(GitCliError);
    expect((error as GitCliError).aborted).toBe(false);
    expect((error as GitCliError).message).toContain('incomplete');
  });
});

/** The failure `crates/mangostudio-runtime/src/commands/service.rs` sends for a cwd that is gone. */
function runtimeMissingCwdFailure(cwd: string): RemoteError {
  const message = `Invalid cwd ${JSON.stringify(cwd)}; expected an existing directory.`;
  return new RemoteError('INTERNAL', message, {
    kind: 'git_execution',
    exitCode: null,
    stdout: '',
    stderr: message,
    args: [],
  });
}

/** A runtime whose every `git.exec` rejects with `failure`. */
function useFailingRuntime(failure: RemoteError): void {
  const client = {
    manifest: TEST_MANIFEST,
    git: { exec: () => Promise.reject(failure) },
  } as unknown as RuntimeClient;
  setRuntimeConnectionManagerForTests(
    new RuntimeConnectionManager({
      resolveEnvironment: (userId, environmentId) =>
        Promise.resolve({
          id: environmentId,
          userId,
          name: 'Remote',
          transportKind: 'stdio',
          config: {},
          enabled: true,
        }),
      connectors: {
        stdio: () => Promise.resolve({ client, close: () => undefined }),
      },
    })
  );
}

describe('isMissingWorkdirError', () => {
  it.skipIf(!hasGit)('recognizes what the real runtime answers for a deleted cwd', async () => {
    // The only guard on the runtime's wording: the predicate matches its
    // message, so a reworded message has to fail here rather than in the logs.
    const error = await runGit(['rev-parse', '--show-toplevel'], {
      cwd: join(tmpdir(), `mango-missing-workdir-${crypto.randomUUID()}`),
    }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(GitCliError);
    expect({
      stderr: (error as GitCliError).stderr,
      matches: isMissingWorkdirError(error),
    }).toEqual({
      stderr: expect.stringContaining('Invalid cwd') as unknown as string,
      matches: true,
    });
  });

  it("recognizes the runtime's refusal of a deleted cwd after runGit maps it", async () => {
    useFailingRuntime(runtimeMissingCwdFailure('/home/user/test/exemplo-prova-matemática'));

    const error = await runGit(['rev-parse', '--show-toplevel'], { cwd: '/gone' }).catch(
      (cause: unknown) => cause
    );

    expect(error).toBeInstanceOf(GitCliError);
    expect(isMissingWorkdirError(error)).toBe(true);
  });

  it('rejects Git failures, cancellations, and foreign errors', () => {
    const gitFatal = new GitCliError(['status'], 128, 'fatal: detected dubious ownership');
    const exitedWithCwdText = new GitCliError(
      ['status'],
      1,
      'Invalid cwd "/gone"; expected an existing directory.'
    );
    const aborted = new GitCliError(
      [],
      null,
      'Invalid cwd "/gone"; expected an existing directory.',
      true
    );
    const mentionsCwd = new GitCliError(
      [],
      null,
      'hook said: Invalid cwd "/x"; expected an existing directory. retry'
    );

    expect(isMissingWorkdirError(gitFatal)).toBe(false);
    expect(isMissingWorkdirError(exitedWithCwdText)).toBe(false);
    expect(isMissingWorkdirError(aborted)).toBe(false);
    expect(isMissingWorkdirError(mentionsCwd)).toBe(false);
    expect(
      isMissingWorkdirError(new Error('Invalid cwd "/gone"; expected an existing directory.'))
    ).toBe(false);
  });
});
