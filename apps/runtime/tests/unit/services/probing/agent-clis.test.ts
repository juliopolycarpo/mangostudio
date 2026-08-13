import { describe, expect, it } from 'bun:test';
import { AgentCliStatusSchema } from '@mangostudio/shared/environments';
import type {
  AuthSignalFs,
  BinaryScanDeps,
  RuntimeDefinition,
} from '@mangostudio/shared/environments/detection';
import {
  CLAUDE_AGENT_CLI_DEFINITION,
  CODEX_AGENT_CLI_DEFINITION,
  CURSOR_AGENT_CLI_DEFINITION,
  MANGOSTUDIO_AGENT_CLI_DEFINITION,
  parseClaudeVersion,
  parseCodexVersion,
  parseCursorAgentVersion,
} from '@mangostudio/shared/environments/detection';
import type { LibraryLocationStatus, LibraryTargetId } from '@mangostudio/shared/library';
import Value from 'typebox/value';
import type { RuntimeProbeAgentClisParams } from '../../../../src/methods';
import {
  createProbingService,
  type ProbingService,
} from '../../../../src/services/probing/service';

const SELF = { version: '0.0.0-test' } as const;

/** One target's status, the way the hub asks for it. */
async function statusFor(
  service: ProbingService,
  targetId: LibraryTargetId,
  self: RuntimeProbeAgentClisParams['self'] = SELF,
  installable?: RuntimeProbeAgentClisParams['installable']
) {
  const { statuses } = await service.probeAgentClis({
    targetIds: [targetId],
    self,
    ...(installable && { installable }),
  });
  return statuses[0] ?? null;
}

const LINUX_ENV = {
  platform: 'linux',
  homeDir: '/home/tester',
  env: { PATH: '/bin' },
} as const;

class FakeAuthSignalFs implements AuthSignalFs {
  constructor(
    private readonly files: ReadonlyMap<string, string> = new Map(),
    private readonly directories: ReadonlySet<string> = new Set()
  ) {}

  stat(path: string) {
    if (this.files.has(path)) {
      return {
        isDirectory: () => false,
        isFile: () => true,
      };
    }
    if (this.directories.has(path)) {
      return {
        isDirectory: () => true,
        isFile: () => false,
      };
    }
    throw Object.assign(new Error('not found'), { code: 'ENOENT' });
  }

  readFile(path: string): string {
    const value = this.files.get(path);
    if (value === undefined) throw new Error(`Unexpected read: ${path}`);
    return value;
  }
}

function scanDeps(
  definition: RuntimeDefinition,
  options: {
    readonly path?: string;
    readonly exists?: (path: string) => boolean;
    readonly version?: (path: string) => string | null;
  } = {}
): BinaryScanDeps {
  return {
    ...LINUX_ENV,
    env: { PATH: options.path ?? LINUX_ENV.env.PATH },
    pathExists: options.exists ?? (() => true),
    probeVersion: (path) =>
      Promise.resolve(options.version ? options.version(path) : versionFor(definition.id)),
    realpath: (path) => Promise.resolve(path),
  };
}

function versionFor(id: RuntimeDefinition['id']): string {
  if (id === 'claude') return '2.1.220 (Claude Code)';
  if (id === 'codex') return 'codex-cli 0.145.0';
  if (id === 'cursor') return '2026.07.16-899851b';
  throw new Error(`Unexpected definition: ${id}`);
}

function findingCodes(status: { findings: readonly { code: string }[] } | null): string[] {
  return status?.findings.map((finding) => finding.code) ?? [];
}

describe('agent CLI definitions', () => {
  it('parses the locally verified version formats strictly', () => {
    expect(parseClaudeVersion('2.1.220 (Claude Code)')).toEqual({
      major: 2,
      minor: 1,
      patch: 220,
    });
    expect(parseCodexVersion('codex-cli 0.145.0')).toEqual({
      major: 0,
      minor: 145,
      patch: 0,
    });
    expect(parseCursorAgentVersion('2026.07.16-899851b')).toEqual({
      major: 2026,
      minor: 7,
      patch: 16,
    });
    expect(parseClaudeVersion('Claude Code latest')).toBeNull();
    expect(parseCodexVersion('0.145.0')).toBeNull();
    expect(parseCursorAgentVersion('2026.07')).toBeNull();
  });
});

describe('agent CLI detection', () => {
  it('joins a detected CLI with config, stat-only auth, and schema-valid health', async () => {
    const configHome = '/home/tester/.claude';
    const credentials = `${configHome}/.credentials.json`;
    const service = createProbingService({
      agentDefinitions: [CLAUDE_AGENT_CLI_DEFINITION],
      createScanDeps: (_env, definition) => scanDeps(definition),
      createPathEnv: () => LINUX_ENV,
      authFs: new FakeAuthSignalFs(new Map([[credentials, 'never read']]), new Set([configHome])),
      describeLocations: () => [],
      now: () => 1_700_000_000_000,
    });

    const status = await statusFor(service, 'claude');

    expect(status).toMatchObject({
      id: 'claude',
      targetId: 'claude',
      health: 'ok',
      configHome,
      configHomeExists: true,
      authenticated: true,
      authSignal: 'file-present',
      probedAtMs: 1_700_000_000_000,
    });
    expect(status?.effective?.version).toBe('2.1.220 (Claude Code)');
    expect(Value.Check(AgentCliStatusSchema, status)).toBe(true);
  });

  it('distinguishes a missing config home from a missing CLI', async () => {
    const service = createProbingService({
      agentDefinitions: [CLAUDE_AGENT_CLI_DEFINITION],
      createScanDeps: (_env, definition) => scanDeps(definition),
      createPathEnv: () => LINUX_ENV,
      authFs: new FakeAuthSignalFs(),
      describeLocations: () => [],
    });

    const status = await statusFor(service, 'claude');

    expect(findingCodes(status)).toContain('config-home-missing');
    expect(findingCodes(status)).not.toContain('cli-not-installed');
    expect(findingCodes(status)).not.toContain('not-authenticated');
  });

  it('reports an absent binary as installable only when a recipe is available', async () => {
    const service = createProbingService({
      agentDefinitions: [CLAUDE_AGENT_CLI_DEFINITION],
      createScanDeps: (_env, definition) =>
        scanDeps(definition, {
          exists: () => false,
        }),
      createPathEnv: () => LINUX_ENV,
      authFs: new FakeAuthSignalFs(),
      describeLocations: () => [],
    });

    const status = await statusFor(service, 'claude', SELF, { claude: true });

    expect(status?.health).toBe('missing');
    expect(status?.installable).toBe(true);
    expect(findingCodes(status)).toContain('cli-not-installed');
    expect(findingCodes(status)).not.toContain('config-home-missing');
  });

  it('warns when an agent CLI is installed only outside PATH', async () => {
    const configHome = '/home/tester/.claude';
    const cliPath = '/opt/claude/bin/claude';
    const definition = {
      ...CLAUDE_AGENT_CLI_DEFINITION,
      runtime: {
        ...CLAUDE_AGENT_CLI_DEFINITION.runtime,
        wellKnownDirs: () => ['/opt/claude/bin'],
      },
    };
    const service = createProbingService({
      agentDefinitions: [definition],
      createScanDeps: (_env, runtimeDefinition) =>
        scanDeps(runtimeDefinition, {
          path: '',
          exists: (path) => path === cliPath,
        }),
      createPathEnv: () => ({ ...LINUX_ENV, env: { PATH: '' } }),
      authFs: new FakeAuthSignalFs(
        new Map([[`${configHome}/.credentials.json`, 'never read']]),
        new Set([configHome])
      ),
      describeLocations: () => [],
    });

    const status = await statusFor(service, 'claude');

    expect(status?.health).toBe('warn');
    expect(status?.effective).toBeUndefined();
    expect(status?.findings).toContainEqual({
      code: 'installed-but-not-on-path',
      params: { runtime: 'claude', path: cliPath },
    });
  });

  it('preserves duplicate and PATH-shadowing analysis for agent CLIs', async () => {
    const configHome = '/home/tester/.claude';
    const service = createProbingService({
      agentDefinitions: [CLAUDE_AGENT_CLI_DEFINITION],
      createScanDeps: (_env, definition) =>
        scanDeps(definition, {
          path: '/first:/second',
          version: (path) =>
            path.startsWith('/first') ? '2.1.220 (Claude Code)' : '2.0.0 (Claude Code)',
        }),
      createPathEnv: () => ({ ...LINUX_ENV, env: { PATH: '/first:/second' } }),
      authFs: new FakeAuthSignalFs(
        new Map([[`${configHome}/.credentials.json`, 'never read']]),
        new Set([configHome])
      ),
      describeLocations: () => [],
    });

    const status = await statusFor(service, 'claude');

    expect(status?.installations).toHaveLength(2);
    expect(findingCodes(status)).toContain('multiple-versions');
    expect(findingCodes(status)).toContain('shadowed-by-earlier-path');
  });

  it('fails soft when a found CLI no longer matches its version format', async () => {
    const service = createProbingService({
      agentDefinitions: [CLAUDE_AGENT_CLI_DEFINITION],
      createScanDeps: (_env, definition) =>
        scanDeps(definition, {
          version: () => 'unexpected output',
        }),
      createPathEnv: () => LINUX_ENV,
      authFs: new FakeAuthSignalFs(),
      describeLocations: () => [],
    });

    const status = await statusFor(service, 'claude');

    expect(status?.health).toBe('error');
    expect(status?.effective).toBeUndefined();
    expect(findingCodes(status)).toContain('version-probe-failed');
    expect(findingCodes(status)).not.toContain('cli-not-installed');
  });

  it('keeps an execution failure distinct from an unparseable version', async () => {
    const service = createProbingService({
      agentDefinitions: [CLAUDE_AGENT_CLI_DEFINITION],
      createScanDeps: (_env, definition) =>
        scanDeps(definition, {
          version: () => null,
        }),
      createPathEnv: () => LINUX_ENV,
      authFs: new FakeAuthSignalFs(),
      describeLocations: () => [],
    });

    const status = await statusFor(service, 'claude');

    expect(findingCodes(status)).toContain('not-executable');
    expect(findingCodes(status)).not.toContain('version-probe-failed');
    expect(findingCodes(status)).not.toContain('cli-not-installed');
  });

  it('warns only for unwritable locations propagation would actually write to', async () => {
    const configHome = '/home/tester/.codex';
    const unwritableLocation: LibraryLocationStatus = {
      id: 'codex-skills',
      kind: 'skill',
      scope: 'home',
      path: `${configHome}/skills`,
      access: 'read-write',
      exists: true,
      readable: true,
      writable: false,
      targetIds: ['codex'],
    };
    const uncreatedLocation: LibraryLocationStatus = {
      id: 'codex-agents',
      kind: 'subagent',
      scope: 'home',
      path: `${configHome}/agents`,
      access: 'read-write',
      exists: false,
      readable: false,
      writable: false,
      targetIds: ['codex'],
    };
    // Never a propagation destination, so its mode is not the user's problem.
    const readOnlyLocation: LibraryLocationStatus = {
      id: 'codex-settings',
      kind: 'setting',
      scope: 'home',
      path: `${configHome}/config.toml`,
      access: 'read-only',
      exists: true,
      readable: true,
      writable: false,
      targetIds: ['codex'],
    };
    const service = createProbingService({
      agentDefinitions: [CODEX_AGENT_CLI_DEFINITION],
      createScanDeps: (_env, definition) => scanDeps(definition),
      createPathEnv: () => LINUX_ENV,
      authFs: new FakeAuthSignalFs(
        new Map([[`${configHome}/auth.json`, 'never read']]),
        new Set([configHome])
      ),
      describeLocations: () => [unwritableLocation, uncreatedLocation, readOnlyLocation],
    });

    const status = await statusFor(service, 'codex');

    expect(status?.health).toBe('warn');
    expect(status?.locations).toEqual([unwritableLocation, uncreatedLocation, readOnlyLocation]);
    expect(status?.findings).toEqual([
      {
        code: 'location-unwritable',
        params: {
          locationId: 'codex-skills',
          path: `${configHome}/skills`,
        },
      },
    ]);
  });

  it('reports one finding per path when several locations resolve to the same file', async () => {
    const configHome = '/home/tester/.claude';
    const settingsPath = `${configHome}/settings.json`;
    const sharedFile = (id: LibraryLocationStatus['id'], kind: LibraryLocationStatus['kind']) => ({
      id,
      kind,
      scope: 'home' as const,
      path: settingsPath,
      access: 'read-write' as const,
      exists: true,
      readable: true,
      writable: false,
      targetIds: ['claude' as const],
    });
    const service = createProbingService({
      agentDefinitions: [CLAUDE_AGENT_CLI_DEFINITION],
      createScanDeps: (_env, definition) => scanDeps(definition),
      createPathEnv: () => LINUX_ENV,
      authFs: new FakeAuthSignalFs(
        new Map([[`${configHome}/.credentials.json`, 'never read']]),
        new Set([configHome])
      ),
      describeLocations: () => [
        sharedFile('claude-settings', 'setting'),
        sharedFile('claude-hooks', 'hook'),
      ],
    });

    const status = await statusFor(service, 'claude');

    expect(status?.findings).toEqual([
      {
        code: 'location-unwritable',
        params: { locationId: 'claude-settings', path: settingsPath },
      },
    ]);
  });

  it('reads Cursor sign-in from a config key rather than a credential file', async () => {
    const configHome = '/home/tester/.cursor';
    const cliConfig = `${configHome}/cli-config.json`;
    const serviceFor = (contents: string) =>
      createProbingService({
        agentDefinitions: [CURSOR_AGENT_CLI_DEFINITION],
        createScanDeps: (_env, definition) => scanDeps(definition),
        createPathEnv: () => LINUX_ENV,
        authFs: new FakeAuthSignalFs(new Map([[cliConfig, contents]]), new Set([configHome])),
        describeLocations: () => [],
      });

    const signedIn = await statusFor(
      serviceFor(JSON.stringify({ authInfo: { id: 'ada' } })),
      'cursor'
    );
    const signedOut = await statusFor(serviceFor(JSON.stringify({ editor: 'vim' })), 'cursor');

    expect(signedIn).toMatchObject({
      targetId: 'cursor',
      configHome,
      configHomeExists: true,
      authenticated: true,
      authSignal: 'config-key-present',
      health: 'ok',
    });
    expect(findingCodes(signedIn)).toEqual([]);
    expect(signedOut?.authenticated).toBe(false);
    expect(findingCodes(signedOut)).toContain('not-authenticated');
  });

  it('calls a Cursor config that is not there absent, and still reports not-authenticated', async () => {
    const configHome = '/home/tester/.cursor';
    const service = createProbingService({
      agentDefinitions: [CURSOR_AGENT_CLI_DEFINITION],
      createScanDeps: (_env, definition) => scanDeps(definition),
      createPathEnv: () => LINUX_ENV,
      // The config home exists; the config inside it does not.
      authFs: new FakeAuthSignalFs(new Map(), new Set([configHome])),
      describeLocations: () => [],
    });

    const status = await statusFor(service, 'cursor');

    expect(status).toMatchObject({
      targetId: 'cursor',
      configHomeExists: true,
      authenticated: false,
      authSignal: 'config-key-absent',
    });
    // The finding depends on a definite verdict, so a signal that is absent
    // rather than unknown has to keep producing it.
    expect(findingCodes(status)).toContain('not-authenticated');
  });

  it('describes the running MangoStudio process from in-process identity and the guarded session', async () => {
    const configHome = '/home/tester/.mango';
    const service = createProbingService({
      agentDefinitions: [MANGOSTUDIO_AGENT_CLI_DEFINITION],
      createPathEnv: () => LINUX_ENV,
      authFs: new FakeAuthSignalFs(new Map(), new Set([configHome])),
      describeLocations: () => [],
      now: () => 1_700_000_000_000,
    });

    const status = await statusFor(service, 'mangostudio', {
      version: '9.9.9',
      executablePath: '/opt/mangostudio/mangostudio',
      configHome,
    });

    expect(status).toMatchObject({
      id: 'mangostudio',
      targetId: 'mangostudio',
      health: 'ok',
      installable: false,
      configHome,
      configHomeExists: true,
      authenticated: true,
      authSignal: 'session',
    });
    expect(status?.effective).toEqual({
      path: '/opt/mangostudio/mangostudio',
      rawPath: '/opt/mangostudio/mangostudio',
      version: '9.9.9',
      origin: 'configured',
      effective: true,
    });
    expect(Value.Check(AgentCliStatusSchema, status)).toBe(true);
  });
});
