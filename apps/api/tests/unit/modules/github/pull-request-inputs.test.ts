import { afterEach, describe, expect, it } from 'bun:test';
import type { RuntimeCapabilityManifest } from '@mangostudio/shared/runtime-protocol';
import { splitNameWithOwner } from '../../../../src/modules/github/application/github-repo-resolver';
import {
  readCurrentBranch,
  readPullRequestTemplate,
} from '../../../../src/modules/github/infrastructure/pull-request-inputs';
import type { RuntimeClient } from '../../../../src/services/runtime-client/runtime-client';
import {
  RuntimeConnectionManager,
  setRuntimeConnectionManagerForTests,
} from '../../../../src/services/runtime-client/runtime-connection-manager';

const SOURCE = {
  workdir: '/remote/repo',
  selection: { userId: 'user-1', environmentId: 'devbox' },
};

const POSIX_MANIFEST: RuntimeCapabilityManifest = {
  platform: 'linux',
  arch: 'x64',
  pathStyle: 'posix',
  homeDir: '/remote/home',
  shells: ['bash'],
  git: { available: true, version: '2.51.0' },
  gh: { available: true, version: '2.97.0' },
  features: {
    tools: true,
    git: true,
    probing: false,
    mcp: false,
    library: false,
    checkpoints: true,
  },
};

interface ReadFileParams {
  readonly chatId: string;
  readonly inputPath: string;
  readonly resolvedPath: string;
}

/** A runtime whose `git` and `fs` answer from this test rather than a machine. */
class FakePullRequestRuntime {
  readonly gitArgs: string[][] = [];
  readonly readFileParams: ReadFileParams[] = [];

  constructor(
    private readonly gitStdout: string = 'feat/panel\n',
    private readonly readFile: (params: ReadFileParams) => Promise<{ content: string }> = () =>
      Promise.resolve({ content: '## Summary' }),
    private readonly manifest: RuntimeCapabilityManifest = POSIX_MANIFEST
  ) {}

  install(): void {
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
          stdio: () => Promise.resolve({ client: this.client(), close: () => undefined }),
        },
      })
    );
  }

  private client(): RuntimeClient {
    return {
      manifest: this.manifest,
      git: {
        exec: (params: { args: string[] }) => {
          this.gitArgs.push(params.args);
          return Promise.resolve({ stdout: this.gitStdout, stderr: '', exitCode: 0 });
        },
      },
      fs: {
        readFile: (params: ReadFileParams) => {
          this.readFileParams.push(params);
          return this.readFile(params);
        },
      },
      paths: {
        join: (base: string, path: string) => `${base}/${path}`,
      },
    } as unknown as RuntimeClient;
  }
}

afterEach(() => {
  setRuntimeConnectionManagerForTests(undefined);
});

describe('current branch', () => {
  it('reads the branch gh must be told to use as --head', async () => {
    // gh prompts for where to push when the current branch is not fully
    // pushed, and the runner disables prompts — so `--head` is not optional.
    const runtime = new FakePullRequestRuntime();
    runtime.install();

    await expect(readCurrentBranch(SOURCE)).resolves.toBe('feat/panel');
    expect(runtime.gitArgs).toEqual([['branch', '--show-current']]);
  });

  it('refuses a detached HEAD, which has no branch to open a pull request from', async () => {
    // `git branch --show-current` prints nothing on a detached HEAD, and an
    // empty `--head=` would be a flag with no value rather than an error.
    new FakePullRequestRuntime('\n').install();

    await expect(readCurrentBranch(SOURCE)).rejects.toBeInstanceOf(TypeError);
  });
});

describe('pull request template', () => {
  it('reads the template with the target machine’s own path separator', async () => {
    const runtime = new FakePullRequestRuntime();
    runtime.install();

    await expect(readPullRequestTemplate(SOURCE, 'chat-1')).resolves.toBe('## Summary');
    expect(runtime.readFileParams).toEqual([
      {
        chatId: 'chat-1',
        inputPath: '.github/pull_request_template.md',
        resolvedPath: '/remote/repo/.github/pull_request_template.md',
        startLine: 1,
        maxLines: 400,
      },
    ] as unknown as ReadFileParams[]);
  });

  it('treats a repository with no template as an empty body', async () => {
    // Most repositories have none, so a missing file is the normal case rather
    // than a failed request.
    new FakePullRequestRuntime('feat/panel\n', () =>
      Promise.reject(new Error('ENOENT: no such file'))
    ).install();

    await expect(readPullRequestTemplate(SOURCE, 'chat-1')).resolves.toBe('');
  });

  it('treats an unreachable runtime as an empty body', async () => {
    setRuntimeConnectionManagerForTests(
      new RuntimeConnectionManager({
        resolveEnvironment: () => Promise.reject(new Error('environment is gone')),
        connectors: { stdio: () => Promise.reject(new Error('unreachable')) },
      })
    );

    await expect(readPullRequestTemplate(SOURCE, 'chat-1')).resolves.toBe('');
  });
});

describe('splitNameWithOwner', () => {
  it('splits the two halves the GraphQL document takes separately', () => {
    expect(splitNameWithOwner('mango/mangostudio')).toEqual({
      owner: 'mango',
      name: 'mangostudio',
    });
  });

  it('refuses anything that is not an owner/name reference', () => {
    for (const value of ['mangostudio', '/mangostudio', 'mango/', '']) {
      expect(() => splitNameWithOwner(value)).toThrow(TypeError);
    }
  });
});
