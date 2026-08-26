import { afterEach, describe, expect, it } from 'bun:test';
import { RuntimeRemoteError } from '@mangostudio/runtime';
import type { RuntimeCapabilityManifest } from '@mangostudio/shared/runtime-protocol';
import {
  buildGhArgv,
  buildGhEnvironment,
  createGhCli,
  GhCliError,
  type GhCommandRunner,
  isGhAvailable,
  runGh,
} from '../../../../src/modules/github/infrastructure/gh-cli';
import type { RuntimeClient } from '../../../../src/services/runtime-client/runtime-client';
import {
  RuntimeConnectionManager,
  setRuntimeConnectionManagerForTests,
} from '../../../../src/services/runtime-client/runtime-connection-manager';

const TEST_MANIFEST: RuntimeCapabilityManifest = {
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

/** A manifest from a runtime released before the `gh` probe existed. */
const OLDER_MANIFEST: RuntimeCapabilityManifest = (({ gh: _gh, ...rest }) => rest)(TEST_MANIFEST);

interface GhCall {
  readonly method: 'exec' | 'mutate';
  readonly args: readonly string[];
  readonly cwd: string;
}

/** Stands in for a connected runtime, recording which gh method each call took. */
class FakeGhRuntime {
  readonly calls: GhCall[] = [];
  readonly resolutions: Array<{ userId: string; environmentId: string }> = [];

  constructor(
    private readonly manifest: RuntimeCapabilityManifest = TEST_MANIFEST,
    private readonly respond: (call: GhCall) => Promise<unknown> = () =>
      Promise.resolve({ stdout: 'remote output', stderr: '', exitCode: 0 })
  ) {}

  install(): void {
    setRuntimeConnectionManagerForTests(
      new RuntimeConnectionManager({
        resolveEnvironment: (userId, environmentId) => {
          this.resolutions.push({ userId, environmentId });
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
          stdio: () => Promise.resolve({ client: this.client(), close: () => undefined }),
        },
      })
    );
  }

  private client(): RuntimeClient {
    const record = (method: 'exec' | 'mutate') => (params: { args: string[]; cwd: string }) => {
      const call = { method, args: params.args, cwd: params.cwd };
      this.calls.push(call);
      return this.respond(call);
    };
    return {
      manifest: this.manifest,
      gh: { exec: record('exec'), mutate: record('mutate') },
    } as unknown as RuntimeClient;
  }
}

afterEach(() => {
  setRuntimeConnectionManagerForTests(undefined);
});

describe('hub gh CLI facade', () => {
  it('re-exports argv and env helpers from the runtime', () => {
    expect(buildGhArgv(['pr', 'view'])).toEqual(['gh', 'pr', 'view']);
    expect(buildGhEnvironment({ PATH: '/bin', GH_HOST: 'github.example' })).toMatchObject({
      PATH: '/bin',
      GH_HOST: 'github.example',
      GH_PROMPT_DISABLED: '1',
      GH_NO_UPDATE_NOTIFIER: '1',
      NO_COLOR: '1',
      LC_ALL: 'C',
    });
  });

  it('never forwards a token variable, because gh has its own credentials', () => {
    const environment = buildGhEnvironment({
      PATH: '/bin',
      GH_TOKEN: 'secret-gh-token',
      GITHUB_TOKEN: 'secret-actions-token',
      GH_ENTERPRISE_TOKEN: 'secret-enterprise-token',
    });
    expect(environment).not.toHaveProperty('GH_TOKEN');
    expect(environment).not.toHaveProperty('GITHUB_TOKEN');
    expect(environment).not.toHaveProperty('GH_ENTERPRISE_TOKEN');
  });

  it('executes against the explicitly selected environment runtime', async () => {
    const runtime = new FakeGhRuntime();
    runtime.install();

    const result = await runGh(['pr', 'view', '--json', 'number'], {
      cwd: '/remote/repo',
      userId: 'user-1',
      environmentId: 'devbox',
    });

    expect(result.stdout).toBe('remote output');
    expect(runtime.resolutions).toEqual([{ userId: 'user-1', environmentId: 'devbox' }]);
    expect(runtime.calls).toEqual([
      { method: 'exec', args: ['pr', 'view', '--json', 'number'], cwd: '/remote/repo' },
    ]);
  });

  it('sends a mutation to gh.mutate rather than gh.exec', async () => {
    const runtime = new FakeGhRuntime();
    runtime.install();

    await runGh(['pr', 'create', '--fill'], {
      cwd: '/remote/repo',
      userId: 'user-1',
      environmentId: 'devbox',
      mutation: true,
    });

    expect(runtime.calls[0]?.method).toBe('mutate');
  });

  it('maps a remote gh_execution failure back onto GhCliError', async () => {
    const runtime = new FakeGhRuntime(TEST_MANIFEST, () =>
      Promise.reject(
        new RuntimeRemoteError('INTERNAL', 'gh failed', {
          kind: 'gh_execution',
          exitCode: 1,
          stderr: 'no git remotes found',
          stdout: '',
          args: ['repo', 'view'],
        })
      )
    );
    runtime.install();

    const error = await runGh(['repo', 'view'], { cwd: '/remote/repo' }).catch(
      (cause: unknown) => cause
    );

    expect(error).toBeInstanceOf(GhCliError);
    expect(error).toMatchObject({
      exitCode: 1,
      stderr: 'no git remotes found',
      args: ['repo', 'view'],
      aborted: false,
    });
  });

  it('rejects a capture the runtime flagged incomplete instead of parsing it', async () => {
    const runtime = new FakeGhRuntime(TEST_MANIFEST, () =>
      Promise.resolve({ stdout: '{"nameWith', stderr: '', exitCode: 0, incomplete: true })
    );
    runtime.install();

    const error = await runGh(['repo', 'view'], { cwd: '/remote/repo' }).catch(
      (cause: unknown) => cause
    );

    expect(error).toBeInstanceOf(GhCliError);
    expect((error as GhCliError).aborted).toBe(false);
    expect((error as GhCliError).message).toContain('incomplete');
  });

  it('reads availability from the manifest without spending a round trip', async () => {
    const runtime = new FakeGhRuntime();
    runtime.install();

    expect(await isGhAvailable({ userId: 'user-1', environmentId: 'devbox' })).toBe(true);
    expect(runtime.calls).toEqual([]);
  });

  it('treats a runtime too old to announce gh as not having it', async () => {
    // Absent means unavailable: that peer ships no `gh.*` handler either, so
    // the honest answer arrives before any RPC can come back METHOD_UNSUPPORTED.
    new FakeGhRuntime(OLDER_MANIFEST).install();

    expect(await isGhAvailable({ userId: 'user-1', environmentId: 'devbox' })).toBe(false);
  });

  it('treats an unreachable runtime as not having gh', async () => {
    setRuntimeConnectionManagerForTests(
      new RuntimeConnectionManager({
        resolveEnvironment: () => Promise.reject(new Error('environment is gone')),
        connectors: { stdio: () => Promise.reject(new Error('unreachable')) },
      })
    );

    expect(await isGhAvailable({ userId: 'user-1', environmentId: 'devbox' })).toBe(false);
  });
});

describe('gh command facade', () => {
  it('passes the selected environment into every command', async () => {
    const calls: Array<{ args: readonly string[]; cwd: string; environmentId?: string }> = [];
    const runner: GhCommandRunner = (args, options) => {
      calls.push({ args, cwd: options.cwd, environmentId: options.environmentId });
      return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
    };
    const cli = createGhCli({
      runner,
      available: () => Promise.resolve(true),
      probeCwd: () => Promise.resolve('/remote/home'),
    });
    const selection = { userId: 'user-1', environmentId: 'devbox' };

    await cli.isAuthenticated(selection);
    await cli.viewRepo('/remote/repo', selection);
    await cli.viewCurrentPr('/remote/repo', selection);

    expect(calls).toEqual([
      { args: ['auth', 'status'], cwd: '/remote/home', environmentId: 'devbox' },
      {
        args: ['repo', 'view', '--json', 'nameWithOwner,defaultBranchRef,url'],
        cwd: '/remote/repo',
        environmentId: 'devbox',
      },
      {
        args: ['pr', 'view', '--json', 'number,title,state,isDraft,url,headRefName,baseRefName'],
        cwd: '/remote/repo',
        environmentId: 'devbox',
      },
    ]);
  });

  it('probes authentication from the runtime home, never from the caller workdir', async () => {
    // `gh auth status` works outside a repository and answers for the whole
    // machine, so the workdir cannot change the answer — and keying by it would
    // multiply identical entries per chat.
    const probed: string[] = [];
    const cli = createGhCli({
      runner: (_args, options) => {
        probed.push(options.cwd);
        return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
      },
      probeCwd: () => Promise.resolve('/remote/home'),
    });

    await cli.isAuthenticated({ userId: 'user-1', environmentId: 'devbox' });

    expect(probed).toEqual(['/remote/home']);
  });

  it('caches authentication per environment and never across environments', async () => {
    // The bug this replaced: one cached boolean answered for every environment,
    // so a signed-in laptop made a signed-out container look authenticated.
    const probedEnvironments: string[] = [];
    const cli = createGhCli({
      runner: (_args, options) => {
        probedEnvironments.push(options.environmentId ?? 'unknown');
        return options.environmentId === 'devbox'
          ? Promise.resolve({ stdout: '', stderr: '', exitCode: 0 })
          : Promise.reject(new Error('not logged in'));
      },
      probeCwd: () => Promise.resolve('/remote/home'),
    });

    expect(await cli.isAuthenticated({ userId: 'user-1', environmentId: 'devbox' })).toBe(true);
    expect(await cli.isAuthenticated({ userId: 'user-1', environmentId: 'container' })).toBe(false);
    expect(await cli.isAuthenticated({ userId: 'user-1', environmentId: 'devbox' })).toBe(true);
    expect(probedEnvironments).toEqual(['devbox', 'container']);
  });

  it('re-probes authentication after the TTL so gh auth login needs no restart', async () => {
    let now = 1_000;
    let authenticated = false;
    let probes = 0;
    const cli = createGhCli({
      runner: () => {
        probes += 1;
        return authenticated
          ? Promise.resolve({ stdout: '', stderr: '', exitCode: 0 })
          : Promise.reject(new Error('not logged in'));
      },
      probeCwd: () => Promise.resolve('/remote/home'),
      now: () => now,
      probeCacheTtlMs: 60_000,
    });
    const selection = { userId: 'user-1', environmentId: 'devbox' };

    expect(await cli.isAuthenticated(selection)).toBe(false);
    authenticated = true;
    now += 59_999;
    expect(await cli.isAuthenticated(selection)).toBe(false);
    expect(probes).toBe(1);

    now += 1;
    expect(await cli.isAuthenticated(selection)).toBe(true);
    expect(probes).toBe(2);
  });

  it('single-flights concurrent authentication probes', async () => {
    let probes = 0;
    const cli = createGhCli({
      runner: async () => {
        probes += 1;
        await Promise.resolve();
        return { stdout: '', stderr: '', exitCode: 0 };
      },
      probeCwd: () => Promise.resolve('/remote/home'),
    });
    const selection = { userId: 'user-1', environmentId: 'devbox' };

    await Promise.all([
      cli.isAuthenticated(selection),
      cli.isAuthenticated(selection),
      cli.isAuthenticated(selection),
    ]);

    expect(probes).toBe(1);
  });
});
