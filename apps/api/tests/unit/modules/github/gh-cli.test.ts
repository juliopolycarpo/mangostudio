import { afterEach, describe, expect, it, setSystemTime } from 'bun:test';

import { RemoteError } from '@mangostudio/protocol';
import {
  type RuntimeCapabilityManifest,
  RuntimeConsentDeniedError,
} from '@mangostudio/shared/runtime-contract';
import {
  profileForAllow,
  RUNTIME_CONSENT_PRESETS,
  type RuntimeCapabilityAllow,
  type RuntimeHealthReport,
} from '@mangostudio/shared/runtime-home';

import {
  canMutateGh,
  createGhCli,
  GhCliError,
  type GhCommandRunner,
  GhMutationDeniedError,
  isGhAvailable,
  runGh,
} from '../../../../src/modules/github/infrastructure/gh-cli';
import type { RuntimeClient } from '../../../../src/services/runtime-client/runtime-client';
import {
  RuntimeConnectionManager,
  setRuntimeConnectionManagerForTests,
} from '../../../../src/services/runtime-client/runtime-connection-manager';
import type { FakeConsentSource } from '../../../support/fake-runtime-host';
import { connectTestRuntime } from '../../../support/runtime-fixture';

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

/**
 * The consent a `readonly` machine grants: `git` yes, `shell` no. `gh.exec`
 * needs only `git`, so reads work, while `gh.mutate` also needs `shell`.
 */
const READONLY_ALLOW = {
  fsRead: true,
  fsWrite: false,
  shell: false,
  git: true,
  probing: true,
  mcp: false,
  library: false,
  checkpoints: false,
  update: false,
} as const;

/** Same machine as {@link TEST_MANIFEST}, with consent that refuses `shell`. */
const READONLY_MANIFEST: RuntimeCapabilityManifest = { ...TEST_MANIFEST, allow: READONLY_ALLOW };

/** A manifest from a runtime released before the `gh` probe existed. */
const OLDER_MANIFEST: RuntimeCapabilityManifest = (({ gh: _gh, ...rest }) => rest)(TEST_MANIFEST);

/** `gh auth status --json hosts` stdout for one healthy, active account. */
const AUTHENTICATED_STDOUT = JSON.stringify({
  hosts: { 'github.com': [{ active: true, state: 'success', login: 'octocat' }] },
});

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

  it('forwards the exit codes a command uses to report rather than to fail', async () => {
    // `gh pr checks` exits 1 on a failing check and 8 on a pending one while
    // still printing its JSON. The runtime owns the exit-code check, so the
    // hub has to say which ones are reportable or every red pull request 500s.
    const received: Array<readonly number[] | undefined> = [];
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
          stdio: () =>
            Promise.resolve({
              client: {
                manifest: TEST_MANIFEST,
                gh: {
                  exec: (params: { acceptedExitCodes?: readonly number[] }) => {
                    received.push(params.acceptedExitCodes);
                    return Promise.resolve({ stdout: '[]', stderr: '', exitCode: 8 });
                  },
                  mutate: () => Promise.reject(new Error('not a mutation')),
                },
              } as unknown as RuntimeClient,
              close: () => undefined,
            }),
        },
      })
    );

    await runGh(['pr', 'checks', '42'], {
      cwd: '/remote/repo',
      userId: 'user-1',
      environmentId: 'devbox',
      acceptedExitCodes: [1, 8],
    });

    expect(received).toEqual([[1, 8]]);
  });

  it('maps a remote gh_execution failure back onto GhCliError', async () => {
    const runtime = new FakeGhRuntime(TEST_MANIFEST, () =>
      Promise.reject(
        new RemoteError('INTERNAL', 'gh failed', {
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

  it('keeps the argv it sent when the runtime refuses before launch', async () => {
    // A pre-launch refusal (a deleted cwd, a preparation timeout) reaches the hub
    // with `args: []`; the hub sent the argv and knows it.
    const runtime = new FakeGhRuntime(TEST_MANIFEST, () =>
      Promise.reject(
        new RemoteError('INTERNAL', 'Invalid cwd "/gone"; expected an existing directory.', {
          kind: 'gh_execution',
          exitCode: null,
          stderr: 'Invalid cwd "/gone"; expected an existing directory.',
          stdout: '',
          args: [],
        })
      )
    );
    runtime.install();

    const error = await runGh(['repo', 'view'], { cwd: '/gone' }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(GhCliError);
    expect((error as GhCliError).args).toEqual(['repo', 'view']);
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

  /**
   * `gh.available` is gated on `git` consent alone, because `gh.exec` is. A
   * machine granting `git` but not `shell` therefore reports `gh` as available
   * while `gh.mutate`, which also needs `shell`, is refused before any handler
   * runs. Availability cannot tell the two apart; this is the question that can.
   */
  it('reports writes as unavailable when the machine grants git but refuses shell', async () => {
    new FakeGhRuntime(READONLY_MANIFEST).install();
    const selection = { userId: 'user-1', environmentId: 'devbox' };

    expect(await isGhAvailable(selection)).toBe(true);
    expect(await canMutateGh(selection)).toBe(false);
  });

  it('reports writes as available when consent grants shell, or when the peer reports none', async () => {
    const selection = { userId: 'user-1', environmentId: 'devbox' };

    new FakeGhRuntime({ ...TEST_MANIFEST, allow: { ...READONLY_ALLOW, shell: true } }).install();
    expect(await canMutateGh(selection)).toBe(true);

    // An older peer announces no consent at all; absent is not a refusal.
    new FakeGhRuntime(TEST_MANIFEST).install();
    expect(await canMutateGh(selection)).toBe(true);
  });

  it('reports writes as unavailable when git consent is withdrawn, or gh is absent, or the runtime is unreachable', async () => {
    const selection = { userId: 'user-1', environmentId: 'devbox' };

    new FakeGhRuntime({
      ...TEST_MANIFEST,
      allow: { ...READONLY_ALLOW, shell: true, git: false },
    }).install();
    expect(await canMutateGh(selection)).toBe(false);

    new FakeGhRuntime(OLDER_MANIFEST).install();
    expect(await canMutateGh(selection)).toBe(false);

    setRuntimeConnectionManagerForTests(
      new RuntimeConnectionManager({
        resolveEnvironment: () => Promise.reject(new Error('environment is gone')),
        connectors: { stdio: () => Promise.reject(new Error('unreachable')) },
      })
    );
    expect(await canMutateGh(selection)).toBe(false);
  });

  it("answers the runtime's consent refusal of a mutation as GhMutationDeniedError", async () => {
    // The hub does not pre-judge consent from its cached manifest; the runtime
    // is the authority. What it sends is the `DENIED` refusal the real client
    // rebuilds as `RuntimeConsentDeniedError`, and that is what turns into the
    // 403-bearing error here. Reads on the same machine keep working: `gh.exec`
    // needs only `git`.
    const runtime = new FakeGhRuntime(READONLY_MANIFEST, (call) =>
      call.method === 'mutate'
        ? Promise.reject(
            new RuntimeConsentDeniedError('"gh.mutate" is refused: shell was not granted', {
              method: 'gh.mutate',
              missing: ['shell'],
              capability: 'shell',
            })
          )
        : Promise.resolve({ stdout: 'remote output', stderr: '', exitCode: 0 })
    );
    runtime.install();

    const refusal = await runGh(['pr', 'create'], { cwd: '/remote/repo', mutation: true }).catch(
      (cause: unknown) => cause
    );

    expect(refusal).toBeInstanceOf(GhMutationDeniedError);
    expect(runtime.calls.map((call) => call.method)).toEqual(['mutate']);

    await runGh(['pr', 'list'], { cwd: '/remote/repo' });
    expect(runtime.calls.map((call) => call.method)).toEqual(['mutate', 'exec']);
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

/** What a machine's owner grants, which they can change while a hub is connected. */
class MutableConsent implements FakeConsentSource {
  readonly slot = 'host' as const;

  constructor(private allow: RuntimeCapabilityAllow) {}

  grant(allow: RuntimeCapabilityAllow): void {
    this.allow = allow;
  }

  current(): RuntimeCapabilityAllow {
    return this.allow;
  }

  refresh(): Promise<RuntimeCapabilityAllow> {
    return Promise.resolve(this.allow);
  }
}

/** A `runtime.health` answer for a machine that grants `allow`, with `gh` installed. */
function healthGranting(allow: RuntimeCapabilityAllow): RuntimeHealthReport {
  return {
    schemaVersion: 1,
    slot: 'host',
    source: 'provisioned',
    runtimeVersion: 'runtime-test',
    version: null,
    binaryPath: null,
    digest: null,
    profile: profileForAllow(allow),
    allow,
    setup: { state: 'configured' },
    platform: 'linux',
    arch: 'x64',
    homeDir: '/remote/home',
    shells: ['bash'],
    git: { available: true, version: '2.51.0' },
    // `gh.available` is gated on `git` consent, as the real runtime reports it.
    gh: { available: allow.git, version: '2.97.0' },
    lastError: null,
    audit: { enabled: false },
  };
}

/**
 * Connects through the real client to a runtime whose consent the test changes
 * after the hub has connected, and whose refusals are the wire `DENIED` a real
 * runtime sends. Returns the consent knob.
 */
async function connectToRuntimeGranting(initial: RuntimeCapabilityAllow): Promise<MutableConsent> {
  const consent = new MutableConsent(initial);
  const runtime = await connectTestRuntime({
    manifest: { ...TEST_MANIFEST, allow: initial },
    consent,
    handlers: {
      'runtime.health': () => healthGranting(consent.current()),
      'gh.exec': () => ({ stdout: 'read ok', stderr: '', exitCode: 0 }),
      'gh.mutate': () => ({ stdout: 'write ok', stderr: '', exitCode: 0 }),
    },
  });
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
      connectors: { stdio: () => Promise.resolve(runtime) },
    })
  );
  return consent;
}

/** Lets the background manifest refresh a stale read starts settle. */
function settleManifestRefresh(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('gh consent that changes after the hub connected', () => {
  const selection = { userId: 'user-1', environmentId: 'devbox' };
  const mutation = { ...selection, cwd: '/remote/repo', mutation: true };

  afterEach(() => {
    setSystemTime();
  });

  it('lets a write through once the owner grants shell, and offers it after the next refresh', async () => {
    const consent = await connectToRuntimeGranting(RUNTIME_CONSENT_PRESETS.readonly);
    expect(await canMutateGh(selection)).toBe(false);

    consent.grant(RUNTIME_CONSENT_PRESETS.full);

    // The runtime decides, not the handshake copy the hub still holds.
    const written = await runGh(['pr', 'create', '--fill'], mutation);
    expect(written.stdout).toBe('write ok');

    // The offer follows within the freshness window: the stale read starts a
    // background refresh, and the answer after it reflects the new consent.
    setSystemTime(new Date(Date.now() + 20_000));
    await canMutateGh(selection);
    await settleManifestRefresh();
    expect(await canMutateGh(selection)).toBe(true);
  });

  it('answers a write the owner has since refused as GhMutationDeniedError, not a generic failure', async () => {
    const consent = await connectToRuntimeGranting(RUNTIME_CONSENT_PRESETS.full);
    expect(await canMutateGh(selection)).toBe(true);

    consent.grant(RUNTIME_CONSENT_PRESETS.readonly);

    const refusal = await runGh(['pr', 'create', '--fill'], mutation).catch(
      (cause: unknown) => cause
    );
    expect(refusal).toBeInstanceOf(GhMutationDeniedError);

    // Reads on the same machine are still allowed.
    expect((await runGh(['pr', 'list'], { ...selection, cwd: '/remote/repo' })).stdout).toBe(
      'read ok'
    );

    setSystemTime(new Date(Date.now() + 20_000));
    await canMutateGh(selection);
    await settleManifestRefresh();
    expect(await canMutateGh(selection)).toBe(false);
  });

  it('refreshes the manifest for availability too, so a withdrawn git grant stops being offered', async () => {
    const consent = await connectToRuntimeGranting(RUNTIME_CONSENT_PRESETS.full);
    expect(await isGhAvailable(selection)).toBe(true);

    consent.grant({ ...RUNTIME_CONSENT_PRESETS.none, git: false });
    setSystemTime(new Date(Date.now() + 20_000));
    await isGhAvailable(selection);
    await settleManifestRefresh();

    expect(await isGhAvailable(selection)).toBe(false);
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
    await cli.run('repo.view', {}, { cwd: '/remote/repo', selection });
    await cli.run('pr.view-current', {}, { cwd: '/remote/repo', selection });

    expect(calls).toEqual([
      { args: ['auth', 'status', '--json', 'hosts'], cwd: '/remote/home', environmentId: 'devbox' },
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

  it('takes the runtime method and the accepted exit codes from the spec', async () => {
    // Neither is a caller's option any more: the registry says which half of
    // `gh` a command belongs to and which non-zero exits it uses to report, so
    // a route cannot get either wrong by forgetting to pass one.
    const options: Array<{ mutation?: boolean; acceptedExitCodes?: readonly number[] }> = [];
    const cli = createGhCli({
      runner: (_args, runOptions) => {
        options.push({
          mutation: runOptions.mutation,
          acceptedExitCodes: runOptions.acceptedExitCodes,
        });
        return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
      },
      probeCwd: () => Promise.resolve('/remote/home'),
    });
    const target = { cwd: '/remote/repo', selection: { userId: 'u', environmentId: 'devbox' } };

    await cli.run('pr.list', { filter: 'open', limit: 20 }, target);
    await cli.run('pr.checks', { number: 42 }, target);
    await cli.run('pr.create', { title: 'T', body: '', head: 'feat/x', draft: false }, target);

    expect(options).toEqual([
      { mutation: false, acceptedExitCodes: undefined },
      { mutation: false, acceptedExitCodes: [1, 8] },
      { mutation: true, acceptedExitCodes: undefined },
    ]);
  });

  /**
   * `gh pr checkout` fetches a ref and switches the working tree, which the
   * git module already gives 60s for under `worktree add`. Left to the
   * runtime's 15s read default it was SIGKILLed mid-fetch on a large pull
   * request, and only the reads may fall back to that default.
   */
  it('gives a checkout the runtime the headroom its spec asks for', async () => {
    const timeouts: Array<number | undefined> = [];
    const cli = createGhCli({
      runner: (_args, runOptions) => {
        timeouts.push(runOptions.timeoutMs);
        return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
      },
      probeCwd: () => Promise.resolve('/remote/home'),
    });
    const target = { cwd: '/remote/repo', selection: { userId: 'u', environmentId: 'devbox' } };

    await cli.run('pr.checkout', { number: 42 }, target);
    await cli.run('pr.list', { filter: 'open', limit: 20 }, target);

    expect(timeouts).toEqual([60_000, undefined]);
  });

  it('validates slots before any argv reaches the runtime', async () => {
    let invoked = false;
    const cli = createGhCli({
      runner: () => {
        invoked = true;
        return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
      },
      probeCwd: () => Promise.resolve('/remote/home'),
    });

    await expect(
      cli.run(
        'pr.list',
        // @ts-expect-error the point of the test: an unknown filter must not run.
        { filter: '--author=attacker', limit: 20 },
        { cwd: '/remote/repo', selection: { userId: 'u', environmentId: 'devbox' } }
      )
    ).rejects.toBeInstanceOf(TypeError);
    expect(invoked).toBe(false);
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
        return Promise.resolve({
          stdout:
            options.environmentId === 'devbox'
              ? AUTHENTICATED_STDOUT
              : JSON.stringify({ hosts: {} }),
          stderr: '',
          exitCode: 0,
        });
      },
      probeCwd: () => Promise.resolve('/remote/home'),
    });

    expect(await cli.isAuthenticated({ userId: 'user-1', environmentId: 'devbox' })).toBe(true);
    expect(await cli.isAuthenticated({ userId: 'user-1', environmentId: 'container' })).toBe(false);
    expect(await cli.isAuthenticated({ userId: 'user-1', environmentId: 'devbox' })).toBe(true);
    expect(probedEnvironments).toEqual(['devbox', 'container']);
  });

  /**
   * A probe that could not run to completion — the 5s timeout on a slow SSH
   * host, a dropped connection, a cancelled request — says nothing about
   * credentials. Folding it into a cached `false` told every GitHub read on
   * that machine "not signed in, run `gh auth login`" for the next minute.
   */
  it.each([
    ['times out', new GhCliError(['auth', 'status'], 143, 'GitHub CLI command timed out.')],
    ['is cut off by a connection failure', new Error('socket hang up')],
  ])('rejects instead of reporting signed out when the probe %s', async (_label, failure) => {
    let probes = 0;
    let probeFails = true;
    const cli = createGhCli({
      runner: () => {
        probes += 1;
        return probeFails
          ? Promise.reject(failure)
          : Promise.resolve({ stdout: AUTHENTICATED_STDOUT, stderr: '', exitCode: 0 });
      },
      probeCwd: () => Promise.resolve('/remote/home'),
      now: () => 1_000,
    });
    const selection = { userId: 'user-1', environmentId: 'devbox' };

    await expect(cli.isAuthenticated(selection)).rejects.toBe(failure);

    // Same clock, well inside the TTL: a cached verdict would answer `false`
    // here without ever asking again.
    probeFails = false;
    expect(await cli.isAuthenticated(selection)).toBe(true);
    expect(probes).toBe(2);
  });

  it('re-probes authentication after the TTL so gh auth login needs no restart', async () => {
    let now = 1_000;
    let authenticated = false;
    let probes = 0;
    const cli = createGhCli({
      runner: () => {
        probes += 1;
        return Promise.resolve({
          stdout: authenticated ? AUTHENTICATED_STDOUT : JSON.stringify({ hosts: {} }),
          stderr: '',
          exitCode: 0,
        });
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

  /**
   * Bare `gh auth status` exits 1 when *any* configured account or host has
   * stale credentials, even one this repository's active account never uses.
   * The `--json` shape always exits 0, so authentication is read from the
   * active account's own health instead — a stale, inactive account must not
   * flip a healthy one to unauthenticated.
   */
  it('stays authenticated when an unrelated inactive account is stale', async () => {
    const cli = createGhCli({
      runner: () =>
        Promise.resolve({
          stdout: JSON.stringify({
            hosts: {
              'github.com': [{ active: true, state: 'success', login: 'octocat' }],
              'github.example.com': [{ active: false, state: 'error', login: 'stale-account' }],
            },
          }),
          stderr: 'X Failed to log in to github.example.com account stale-account',
          exitCode: 0,
        }),
      probeCwd: () => Promise.resolve('/remote/home'),
    });

    expect(await cli.isAuthenticated({ userId: 'user-1', environmentId: 'devbox' })).toBe(true);
  });

  it('is unauthenticated when the active account itself is unhealthy', async () => {
    const cli = createGhCli({
      runner: () =>
        Promise.resolve({
          stdout: JSON.stringify({
            hosts: { 'github.com': [{ active: true, state: 'error', login: 'octocat' }] },
          }),
          stderr: '',
          exitCode: 0,
        }),
      probeCwd: () => Promise.resolve('/remote/home'),
    });

    expect(await cli.isAuthenticated({ userId: 'user-1', environmentId: 'devbox' })).toBe(false);
  });

  it('is unauthenticated when no host has any account', async () => {
    const cli = createGhCli({
      runner: () =>
        Promise.resolve({ stdout: JSON.stringify({ hosts: {} }), stderr: '', exitCode: 0 }),
      probeCwd: () => Promise.resolve('/remote/home'),
    });

    expect(await cli.isAuthenticated({ userId: 'user-1', environmentId: 'devbox' })).toBe(false);
  });

  it('single-flights concurrent authentication probes', async () => {
    let probes = 0;
    const cli = createGhCli({
      runner: async () => {
        probes += 1;
        await Promise.resolve();
        return { stdout: AUTHENTICATED_STDOUT, stderr: '', exitCode: 0 };
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

  /**
   * A body the contract allows (60,000 characters) is longer than a whole
   * Windows command line may be (32,767 UTF-16 units), and `CreateProcess`
   * refuses the call before `gh` starts — which surfaces as a failure to spawn
   * `gh` with nothing in it about which argument was too long.
   */
  it('refuses an oversized command line on a Windows runtime before spawning', async () => {
    const runtime = new FakeGhRuntime({ ...TEST_MANIFEST, pathStyle: 'win32' });
    runtime.install();

    const attempt = runGh(['pr', 'create', `--body=${'x'.repeat(40_000)}`], {
      cwd: 'C:\\repo',
      userId: 'user-1',
      environmentId: 'winbox',
      mutation: true,
    });

    await expect(attempt).rejects.toThrow(/too long for the Windows machine/);
    expect(runtime.calls).toEqual([]);
  });

  it('sends the same command line to a posix runtime, whose limit it is nowhere near', async () => {
    const runtime = new FakeGhRuntime();
    runtime.install();

    await runGh(['pr', 'create', `--body=${'x'.repeat(40_000)}`], {
      cwd: '/remote/repo',
      userId: 'user-1',
      environmentId: 'devbox',
      mutation: true,
    });

    expect(runtime.calls).toHaveLength(1);
  });
});
