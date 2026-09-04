import { afterEach, describe, expect, it } from 'bun:test';
import type {
  AgentCliStatus,
  InstallPreparation,
  InstallPrepareBody,
  InstallRecipePreview,
  InstallRun,
  InstallStartBody,
  InstallStartResponse,
  InstallStreamEvent,
  RuntimeStatus,
  ToolchainSelection,
  ToolchainUpdateBody,
  VersionManagerStatus,
} from '@mangostudio/shared/environments';
import Value from 'typebox/value';
import type { EnvArgs } from '../../../src/cli/args';
import { parseEnvArgs } from '../../../src/cli/args';
import {
  CliEnvironmentSnapshotSchema,
  cliInstallGuard,
  type EnvInstallDeps,
  type EnvToolchainDeps,
  runEnv,
  runEnvInstall,
  runEnvToolchain,
} from '../../../src/cli/commands/env';
import { CliError } from '../../../src/cli/errors';
import { loadConfigForTest, resetConfig } from '../../../src/lib/config';
import {
  InstallBlockedError,
  InstallUnavailableError,
} from '../../../src/modules/environments/application/install-service';
import { EnvironmentServiceError } from '../../../src/modules/environments/domain/environment-error';

const runtimeStatus: RuntimeStatus = {
  id: 'bun',
  health: 'ok',
  installations: [
    {
      path: '/home/user/.bun/bin/bun',
      rawPath: '/home/user/.bun/bin/bun',
      version: '1.2.3',
      origin: 'path',
      pathIndex: 0,
      effective: true,
    },
  ],
  effective: {
    path: '/home/user/.bun/bin/bun',
    rawPath: '/home/user/.bun/bin/bun',
    version: '1.2.3',
    origin: 'path',
    pathIndex: 0,
    effective: true,
  },
  findings: [],
  installable: true,
  probedAtMs: 1,
};

const versionManagerStatus: VersionManagerStatus = {
  id: 'nvm',
  installed: true,
  managerVersion: '0.40.1',
  versions: [
    {
      version: '22.13.0',
      path: '/nvm/v22',
      isDefault: true,
      isCurrent: true,
      ltsStatus: 'current-lts',
    },
  ],
  findings: [],
};

const agentStatus: AgentCliStatus = {
  id: 'codex',
  targetId: 'codex',
  health: 'missing',
  installations: [],
  findings: [{ code: 'cli-not-installed', params: { targetId: 'codex' } }],
  installable: true,
  probedAtMs: 1,
  configHome: '/home/user/.codex',
  configHomeExists: false,
  authenticated: false,
  authSignal: 'file-absent',
  locations: [],
};

describe('cliInstallGuard', () => {
  afterEach(() => {
    resetConfig();
  });

  it('allows a local install when installs are enabled and this is not a container', async () => {
    loadConfigForTest({
      environments: {
        ltsRefresh: false,
        installsEnabled: true,
        container: false,
        wslExecutable: '',
      },
    });

    const guard = await cliInstallGuard({ userId: 'local', clientIp: undefined });

    expect(guard).toEqual({ allowed: true, reasons: [] });
  });

  it('refuses when installs are disabled', async () => {
    loadConfigForTest({
      environments: {
        ltsRefresh: false,
        installsEnabled: false,
        container: false,
        wslExecutable: '',
      },
    });

    const guard = await cliInstallGuard({ userId: 'local', clientIp: undefined });

    expect(guard).toEqual({ allowed: false, reasons: ['disabled'] });
  });

  it('refuses when this process is running inside a container', async () => {
    loadConfigForTest({
      environments: {
        ltsRefresh: false,
        installsEnabled: true,
        container: true,
        wslExecutable: '',
      },
    });

    const guard = await cliInstallGuard({ userId: 'local', clientIp: undefined });

    expect(guard).toEqual({ allowed: false, reasons: ['container'] });
  });

  it('refuses a remote --environment, since the CLI has no session to resolve it against', async () => {
    loadConfigForTest({
      environments: {
        ltsRefresh: false,
        installsEnabled: true,
        container: false,
        wslExecutable: '',
      },
    });

    const guard = await cliInstallGuard({
      userId: 'local',
      clientIp: undefined,
      environmentId: 'dev-box',
    });

    expect(guard).toEqual({ allowed: false, reasons: ['environment-not-trusted'] });
  });

  it('reports both disabled and environment-not-trusted together, not just the first one found', async () => {
    loadConfigForTest({
      environments: {
        ltsRefresh: false,
        installsEnabled: false,
        container: false,
        wslExecutable: '',
      },
    });

    const guard = await cliInstallGuard({
      userId: 'local',
      clientIp: undefined,
      environmentId: 'dev-box',
    });

    expect(guard).toEqual({ allowed: false, reasons: ['disabled', 'environment-not-trusted'] });
  });
});

describe('parseEnvArgs', () => {
  it('accepts --json without a subcommand', () => {
    expect(parseEnvArgs(['--json'])).toEqual({ subcommand: null, json: true });
  });

  it('rejects unknown flags', () => {
    expect(() => parseEnvArgs(['--install'])).toThrow(CliError);
  });

  it('parses install with a recipe, --environment, and --version', () => {
    expect(
      parseEnvArgs(['install', 'nvm.node.install', '--environment', 'dev-box', '--version', '20'])
    ).toEqual({
      subcommand: 'install',
      recipeId: 'nvm.node.install',
      environmentId: 'dev-box',
      version: '20',
      json: false,
    });
  });

  it('parses update with just a recipe', () => {
    expect(parseEnvArgs(['update', 'bun.update', '--json'])).toEqual({
      subcommand: 'update',
      recipeId: 'bun.update',
      json: true,
    });
  });

  it('requires a recipe id for install and update', () => {
    expect(() => parseEnvArgs(['install'])).toThrow(/Missing recipe id for env install/);
    expect(() => parseEnvArgs(['update'])).toThrow(/Missing recipe id for env update/);
  });

  it('rejects extra positionals after the recipe id', () => {
    expect(() => parseEnvArgs(['install', 'bun.install.official', 'extra'])).toThrow(
      /Unexpected extra arguments/
    );
  });

  it('parses toolchain with no arguments, and with a runtime and a choice', () => {
    expect(parseEnvArgs(['toolchain'])).toEqual({ subcommand: 'toolchain', json: false });
    expect(
      parseEnvArgs(['toolchain', 'node', 'auto', '--environment', 'dev-box', '--user', 'me@x.io'])
    ).toEqual({
      subcommand: 'toolchain',
      json: false,
      runtime: 'node',
      choice: 'auto',
      environmentId: 'dev-box',
      user: 'me@x.io',
    });
  });

  it('refuses a toolchain runtime it does not know, and a runtime without a choice', () => {
    expect(() => parseEnvArgs(['toolchain', 'git', 'auto'])).toThrow(
      'Unknown toolchain runtime: git'
    );
    expect(() => parseEnvArgs(['toolchain', 'bun'])).toThrow(
      'Missing selection for env toolchain bun'
    );
    expect(() => parseEnvArgs(['toolchain', 'bun', 'auto', 'extra'])).toThrow(
      'Unexpected extra arguments for env toolchain: extra'
    );
  });

  it('requires a value for --environment and --version', () => {
    expect(() => parseEnvArgs(['install', 'bun.install.official', '--environment'])).toThrow(
      /Missing value for env --environment/
    );
    expect(() => parseEnvArgs(['install', 'nvm.node.install', '--version'])).toThrow(
      /Missing value for env --version/
    );
  });
});

describe('runEnv', () => {
  it('emits schema-valid JSON', async () => {
    const lines: string[] = [];
    await runEnv(
      { subcommand: null, json: true },
      {
        listRuntimes: async () => [runtimeStatus],
        listVersionManagers: async () => [versionManagerStatus],
        listAgents: async () => [agentStatus],
        log: (line) => lines.push(line),
      }
    );

    const payload = JSON.parse(lines.join('\n'));
    expect(Value.Check(CliEnvironmentSnapshotSchema, payload)).toBe(true);
    expect(payload.agents[0].findings[0].code).toBe('cli-not-installed');
  });

  it('prints summary lines in text mode', async () => {
    const lines: string[] = [];
    await runEnv(
      { subcommand: null, json: false },
      {
        listRuntimes: async () => [runtimeStatus],
        listVersionManagers: async () => [versionManagerStatus],
        listAgents: async () => [agentStatus],
        log: (line) => lines.push(line),
      }
    );

    const output = lines.join('\n');
    expect(output).toContain('1.2.3');
    expect(output).toContain('Codex');
    expect(output).toContain('not installed');
  });

  it('prints agent detail for agents subcommand', async () => {
    const lines: string[] = [];
    await runEnv(
      { subcommand: 'agents', json: false },
      {
        listRuntimes: async () => [],
        listVersionManagers: async () => [],
        listAgents: async () => [agentStatus],
        log: (line) => lines.push(line),
      }
    );

    expect(lines.join('\n')).toContain('Agent CLIs');
    expect(lines.join('\n')).toContain('not signed in');
  });
});

function recipePreview(overrides: Partial<InstallRecipePreview> = {}): InstallRecipePreview {
  return {
    id: 'bun.install.official',
    runtimeId: 'bun',
    action: 'install',
    inputKind: 'none',
    platforms: ['linux', 'darwin'],
    argv: ['bash', '/tmp/installer.sh'],
    copyCommand: 'curl -fsSL https://bun.com/install | bash',
    requires: [],
    writes: ['$HOME/.bun'],
    networkAccess: true,
    timeoutMs: 300_000,
    supported: true,
    missingRequirements: [],
    guard: { allowed: true, reasons: [] },
    runnable: true,
    ...overrides,
  };
}

/** Named fake standing in for the four `InstallService` methods the CLI calls. */
class FakeInstallService {
  readonly prepareCalls: InstallPrepareBody[] = [];
  readonly startCalls: InstallStartBody[] = [];
  prepareImpl: (body: InstallPrepareBody) => Promise<InstallPreparation> = () => {
    throw new Error('FakeInstallService.prepare is not configured for this test.');
  };
  startImpl: (body: InstallStartBody) => Promise<InstallStartResponse> = () => {
    throw new Error('FakeInstallService.start is not configured for this test.');
  };
  streamEvents: InstallStreamEvent[] = [];
  runs: InstallRun[] = [];

  prepare(body: InstallPrepareBody): Promise<InstallPreparation> {
    this.prepareCalls.push(body);
    return this.prepareImpl(body);
  }

  start(body: InstallStartBody): Promise<InstallStartResponse> {
    this.startCalls.push(body);
    return this.startImpl(body);
  }

  getRunStream(): Promise<AsyncIterable<InstallStreamEvent> | null> {
    const events = this.streamEvents;
    async function* stream() {
      // A real await, not decoration: it is what makes this generator
      // asynchronous rather than a sync one that happens to satisfy
      // AsyncIterable's shape without ever yielding to the event loop.
      await Promise.resolve();
      for (const event of events) yield event;
    }
    return Promise.resolve(stream());
  }

  listRuns(): Promise<InstallRun[]> {
    return Promise.resolve(this.runs);
  }
}

function succeedAfter(events: InstallStreamEvent[] = []): InstallStreamEvent[] {
  return [
    ...events,
    { type: 'exit', code: 0, status: 'succeeded', truncated: false, durationMs: 5, done: true },
  ];
}

describe('runEnvInstall', () => {
  it('prepares, starts, streams the log in order, and exits 0 on success', async () => {
    const service = new FakeInstallService();
    service.prepareImpl = () =>
      Promise.resolve({
        preparationId: null,
        expiresAt: null,
        recipe: recipePreview({ id: 'bun.update', action: 'update', argv: ['bun', 'upgrade'] }),
      });
    service.startImpl = () => Promise.resolve({ runId: 'run-1', attached: false });
    service.streamEvents = succeedAfter([
      { type: 'log', stream: 'stdout', line: 'first', done: false },
      { type: 'log', stream: 'stdout', line: 'second', done: false },
    ]);

    const lines: string[] = [];
    const code = await runEnvInstall(
      { subcommand: 'update', recipeId: 'bun.update', json: false } as EnvArgs,
      {
        service,
        resolveUserId: () => Promise.resolve('user-1'),
        log: (line) => lines.push(line),
      } as Partial<EnvInstallDeps>
    );

    expect(code).toBe(0);
    expect(lines.indexOf('first')).toBeLessThan(lines.indexOf('second'));
    expect(service.prepareCalls[0]).toMatchObject({ recipeId: 'bun.update' });
    expect(service.startCalls[0]).toMatchObject({ recipeId: 'bun.update' });
  });

  it('exits 1 when the run finishes with a non-succeeded status', async () => {
    const service = new FakeInstallService();
    service.prepareImpl = () =>
      Promise.resolve({
        preparationId: null,
        expiresAt: null,
        recipe: recipePreview({ id: 'bun.update', action: 'update' }),
      });
    service.startImpl = () => Promise.resolve({ runId: 'run-2', attached: false });
    service.streamEvents = [
      { type: 'exit', code: 1, status: 'failed', truncated: false, durationMs: 5, done: true },
    ];

    const code = await runEnvInstall(
      { subcommand: 'update', recipeId: 'bun.update', json: false },
      {
        service,
      } as Partial<EnvInstallDeps>
    );
    expect(code).toBe(1);
  });

  it('prints the copy command and exits 2 when the guard blocks the recipe, without starting it', async () => {
    const service = new FakeInstallService();
    const blocked = recipePreview({
      guard: { allowed: false, reasons: ['disabled'] },
      copyCommand: 'curl -fsSL https://bun.com/install | bash',
    });
    service.prepareImpl = () => Promise.reject(new InstallBlockedError(blocked));

    const lines: string[] = [];
    const code = await runEnvInstall(
      { subcommand: 'install', recipeId: 'bun.install.official', json: false },
      {
        service,
        resolveUserId: () => Promise.resolve('user-1'),
        log: (line) => lines.push(line),
      } as Partial<EnvInstallDeps>
    );

    expect(code).toBe(2);
    expect(lines.join('\n')).toContain('curl -fsSL https://bun.com/install | bash');
    expect(service.startCalls).toHaveLength(0);
  });

  it('prints the copy command and exits 2 for a copy-only recipe', async () => {
    const service = new FakeInstallService();
    const copyOnly = recipePreview({
      runnable: false,
      unrunnableReason: 'vendor-undocumented',
      copyCommand: 'rm -rf ~/.local/bin/codex',
    });
    service.prepareImpl = () =>
      Promise.reject(new InstallUnavailableError(copyOnly, 'no automated run'));

    const lines: string[] = [];
    const code = await runEnvInstall(
      { subcommand: 'install', recipeId: 'bun.install.official', json: false },
      {
        service,
        resolveUserId: () => Promise.resolve('user-1'),
        log: (line) => lines.push(line),
      } as Partial<EnvInstallDeps>
    );

    expect(code).toBe(2);
    expect(lines.join('\n')).toContain('rm -rf ~/.local/bin/codex');
  });

  it('prints the final run row with --json', async () => {
    const service = new FakeInstallService();
    service.prepareImpl = () =>
      Promise.resolve({
        preparationId: null,
        expiresAt: null,
        recipe: recipePreview({ id: 'bun.update', action: 'update' }),
      });
    service.startImpl = () => Promise.resolve({ runId: 'run-3', attached: false });
    service.streamEvents = succeedAfter();
    service.runs = [
      {
        id: 'run-3',
        recipeId: 'bun.update',
        argv: ['bun', 'upgrade'],
        startedAt: 1,
        finishedAt: 2,
        exitCode: 0,
        status: 'succeeded',
        truncated: false,
      },
    ];

    const lines: string[] = [];
    const code = await runEnvInstall({ subcommand: 'update', recipeId: 'bun.update', json: true }, {
      service,
      log: (line) => lines.push(line),
    } as Partial<EnvInstallDeps>);

    expect(code).toBe(0);
    expect(JSON.parse(lines.at(-1) ?? '{}')).toMatchObject({ id: 'run-3', status: 'succeeded' });
  });

  it('maps --version to a node-version input, defaulting to lts when omitted', async () => {
    const service = new FakeInstallService();
    service.prepareImpl = (body) => {
      expect(body.input).toEqual({ kind: 'node-version', version: 'lts' });
      return Promise.resolve({
        preparationId: null,
        expiresAt: null,
        recipe: recipePreview({
          id: 'nvm.node.install',
          action: 'use-version',
          inputKind: 'node-version',
        }),
      });
    };
    service.startImpl = () => Promise.resolve({ runId: 'run-4', attached: false });
    service.streamEvents = succeedAfter();

    const code = await runEnvInstall(
      { subcommand: 'install', recipeId: 'nvm.node.install', json: false },
      { service } as Partial<EnvInstallDeps>
    );
    expect(code).toBe(0);
  });

  it('refuses --version for a recipe that takes no input', async () => {
    const service = new FakeInstallService();
    await expect(
      runEnvInstall(
        { subcommand: 'install', recipeId: 'bun.install.official', version: '20', json: false },
        { service } as Partial<EnvInstallDeps>
      )
    ).rejects.toThrow(/does not accept --version/);
    expect(service.prepareCalls).toHaveLength(0);
  });

  it('refuses an unknown recipe id', async () => {
    const service = new FakeInstallService();
    await expect(
      runEnvInstall({ subcommand: 'install', recipeId: 'not-a-real-recipe', json: false }, {
        service,
      } as Partial<EnvInstallDeps>)
    ).rejects.toThrow(/Unknown recipe id/);
  });

  it('refuses env update for an install-action recipe, and env install for an update-action one', async () => {
    const service = new FakeInstallService();
    await expect(
      runEnvInstall({ subcommand: 'update', recipeId: 'bun.install.official', json: false }, {
        service,
      } as Partial<EnvInstallDeps>)
    ).rejects.toThrow(/env update does not run "install" recipes/);

    await expect(
      runEnvInstall({ subcommand: 'install', recipeId: 'claude.uninstall', json: false }, {
        service,
      } as Partial<EnvInstallDeps>)
    ).rejects.toThrow(/env install does not run "uninstall" recipes/);
  });
});

/** Stores one selection per (user, environment); `update` refuses paths not in `known`. */
class FakeToolchainService {
  readonly rows = new Map<string, ToolchainSelection>();
  readonly updates: Array<{ userId: string; environmentId: string; body: ToolchainUpdateBody }> =
    [];
  constructor(private readonly known: readonly string[] = []) {}

  resolve(userId: string, environmentId: string): Promise<ToolchainSelection> {
    return Promise.resolve(
      this.rows.get(`${userId}/${environmentId}`) ?? { node: 'auto', bun: 'auto' }
    );
  }

  async update(
    userId: string,
    environmentId: string,
    body: ToolchainUpdateBody
  ): Promise<ToolchainSelection> {
    this.updates.push({ userId, environmentId, body });
    for (const choice of [body.node, body.bun]) {
      if (choice !== undefined && choice !== 'auto' && !this.known.includes(choice)) {
        throw new EnvironmentServiceError(
          `Invalid node toolchain path: expected one of: ${this.known.join(', ')} | received: ${choice}`,
          422
        );
      }
    }
    const merged = { ...(await this.resolve(userId, environmentId)), ...body };
    this.rows.set(`${userId}/${environmentId}`, merged);
    return merged;
  }
}

describe('runEnvToolchain', () => {
  const deps = (service: FakeToolchainService, lines: string[]): Partial<EnvToolchainDeps> => ({
    service,
    resolveUserId: () => Promise.resolve('user-1'),
    log: (line) => lines.push(line),
  });

  it('prints the automatic selection for the local environment when nothing is pinned', async () => {
    const lines: string[] = [];
    await runEnvToolchain(
      { subcommand: 'toolchain', json: false },
      deps(new FakeToolchainService(), lines)
    );

    expect(lines).toEqual(['Toolchain for local', '  node  auto', '  bun   auto']);
  });

  it('writes a probed path through the service and prints the merged selection', async () => {
    const service = new FakeToolchainService(['/opt/node/bin/node']);
    const lines: string[] = [];
    await runEnvToolchain(
      {
        subcommand: 'toolchain',
        runtime: 'node',
        choice: '/opt/node/bin/node',
        environmentId: 'dev-box',
        json: true,
      },
      deps(service, lines)
    );

    expect(service.updates).toEqual([
      { userId: 'user-1', environmentId: 'dev-box', body: { node: '/opt/node/bin/node' } },
    ]);
    expect(JSON.parse(lines.join('\n'))).toEqual({
      environmentId: 'dev-box',
      toolchain: { node: '/opt/node/bin/node', bun: 'auto' },
    });
  });

  it('turns the service refusal of an unknown path into a CLI error naming both sides', async () => {
    const service = new FakeToolchainService(['/opt/node/bin/node']);
    const attempt = runEnvToolchain(
      { subcommand: 'toolchain', runtime: 'node', choice: '/tmp/evil/node', json: false },
      deps(service, [])
    );

    await expect(attempt).rejects.toBeInstanceOf(CliError);
    await expect(attempt).rejects.toThrow(
      'expected one of: /opt/node/bin/node | received: /tmp/evil/node'
    );
  });
});
