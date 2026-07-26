import { describe, expect, it } from 'bun:test';
import { AgentCliStatusSchema } from '@mangostudio/shared/environments';
import type { LibraryLocationStatus } from '@mangostudio/shared/library';
import { Value } from '@sinclair/typebox/value';
import { createAgentCliDetectionService } from '../../../../src/modules/environments/application/agent-cli-detection';
import {
  CLAUDE_AGENT_CLI_DEFINITION,
  CODEX_AGENT_CLI_DEFINITION,
  MANGOSTUDIO_AGENT_CLI_DEFINITION,
  parseClaudeVersion,
  parseCodexVersion,
  parseCursorAgentVersion,
} from '../../../../src/modules/environments/domain/agent-cli-definitions';
import type { AuthSignalFs } from '../../../../src/modules/environments/domain/auth-signal';
import type {
  BinaryScanDeps,
  RuntimeDefinition,
} from '../../../../src/modules/environments/domain/binary-scan';

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
    const service = createAgentCliDetectionService({
      definitions: [CLAUDE_AGENT_CLI_DEFINITION],
      createScanDeps: (definition) => scanDeps(definition),
      createPathEnv: () => LINUX_ENV,
      fs: new FakeAuthSignalFs(new Map([[credentials, 'never read']]), new Set([configHome])),
      describeLocations: () => [],
      now: () => 1_700_000_000_000,
    });

    const status = await service.getAgentCliStatus('claude');

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
    const service = createAgentCliDetectionService({
      definitions: [CLAUDE_AGENT_CLI_DEFINITION],
      createScanDeps: (definition) => scanDeps(definition),
      createPathEnv: () => LINUX_ENV,
      fs: new FakeAuthSignalFs(),
      describeLocations: () => [],
    });

    const status = await service.getAgentCliStatus('claude');

    expect(findingCodes(status)).toContain('config-home-missing');
    expect(findingCodes(status)).not.toContain('cli-not-installed');
    expect(findingCodes(status)).not.toContain('not-authenticated');
  });

  it('reports an absent binary as installable only when a recipe is available', async () => {
    const service = createAgentCliDetectionService({
      definitions: [CLAUDE_AGENT_CLI_DEFINITION],
      createScanDeps: (definition) =>
        scanDeps(definition, {
          exists: () => false,
        }),
      createPathEnv: () => LINUX_ENV,
      fs: new FakeAuthSignalFs(),
      describeLocations: () => [],
      isInstallable: (targetId) => targetId === 'claude',
    });

    const status = await service.getAgentCliStatus('claude');

    expect(status?.health).toBe('missing');
    expect(status?.installable).toBe(true);
    expect(findingCodes(status)).toContain('cli-not-installed');
    expect(findingCodes(status)).not.toContain('config-home-missing');
  });

  it('preserves duplicate and PATH-shadowing analysis for agent CLIs', async () => {
    const configHome = '/home/tester/.claude';
    const service = createAgentCliDetectionService({
      definitions: [CLAUDE_AGENT_CLI_DEFINITION],
      createScanDeps: (definition) =>
        scanDeps(definition, {
          path: '/first:/second',
          version: (path) =>
            path.startsWith('/first') ? '2.1.220 (Claude Code)' : '2.0.0 (Claude Code)',
        }),
      createPathEnv: () => ({ ...LINUX_ENV, env: { PATH: '/first:/second' } }),
      fs: new FakeAuthSignalFs(
        new Map([[`${configHome}/.credentials.json`, 'never read']]),
        new Set([configHome])
      ),
      describeLocations: () => [],
    });

    const status = await service.getAgentCliStatus('claude');

    expect(status?.installations).toHaveLength(2);
    expect(findingCodes(status)).toContain('multiple-versions');
    expect(findingCodes(status)).toContain('shadowed-by-earlier-path');
  });

  it('fails soft when a found CLI no longer matches its version format', async () => {
    const service = createAgentCliDetectionService({
      definitions: [CLAUDE_AGENT_CLI_DEFINITION],
      createScanDeps: (definition) =>
        scanDeps(definition, {
          version: () => 'unexpected output',
        }),
      createPathEnv: () => LINUX_ENV,
      fs: new FakeAuthSignalFs(),
      describeLocations: () => [],
    });

    const status = await service.getAgentCliStatus('claude');

    expect(status?.health).toBe('error');
    expect(status?.effective).toBeUndefined();
    expect(findingCodes(status)).toContain('version-probe-failed');
    expect(findingCodes(status)).not.toContain('cli-not-installed');
  });

  it('keeps an execution failure distinct from an unparseable version', async () => {
    const service = createAgentCliDetectionService({
      definitions: [CLAUDE_AGENT_CLI_DEFINITION],
      createScanDeps: (definition) =>
        scanDeps(definition, {
          version: () => null,
        }),
      createPathEnv: () => LINUX_ENV,
      fs: new FakeAuthSignalFs(),
      describeLocations: () => [],
    });

    const status = await service.getAgentCliStatus('claude');

    expect(findingCodes(status)).toContain('not-executable');
    expect(findingCodes(status)).not.toContain('version-probe-failed');
    expect(findingCodes(status)).not.toContain('cli-not-installed');
  });

  it('warns only for unwritable locations propagation would actually write to', async () => {
    const configHome = '/home/tester/.codex';
    const unwritableLocation: LibraryLocationStatus = {
      id: 'codex-skills',
      kind: 'skill',
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
      path: `${configHome}/config.toml`,
      access: 'read-only',
      exists: true,
      readable: true,
      writable: false,
      targetIds: ['codex'],
    };
    const service = createAgentCliDetectionService({
      definitions: [CODEX_AGENT_CLI_DEFINITION],
      createScanDeps: (definition) => scanDeps(definition),
      createPathEnv: () => LINUX_ENV,
      fs: new FakeAuthSignalFs(
        new Map([[`${configHome}/auth.json`, 'never read']]),
        new Set([configHome])
      ),
      describeLocations: () => [unwritableLocation, uncreatedLocation, readOnlyLocation],
    });

    const status = await service.getAgentCliStatus('codex');

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
      path: settingsPath,
      access: 'read-write' as const,
      exists: true,
      readable: true,
      writable: false,
      targetIds: ['claude' as const],
    });
    const service = createAgentCliDetectionService({
      definitions: [CLAUDE_AGENT_CLI_DEFINITION],
      createScanDeps: (definition) => scanDeps(definition),
      createPathEnv: () => LINUX_ENV,
      fs: new FakeAuthSignalFs(
        new Map([[`${configHome}/.credentials.json`, 'never read']]),
        new Set([configHome])
      ),
      describeLocations: () => [
        sharedFile('claude-settings', 'setting'),
        sharedFile('claude-hooks', 'hook'),
      ],
    });

    const status = await service.getAgentCliStatus('claude');

    expect(status?.findings).toEqual([
      {
        code: 'location-unwritable',
        params: { locationId: 'claude-settings', path: settingsPath },
      },
    ]);
  });

  it('describes the running MangoStudio process from in-process identity and the guarded session', async () => {
    const configHome = '/home/tester/.mango';
    const service = createAgentCliDetectionService({
      definitions: [MANGOSTUDIO_AGENT_CLI_DEFINITION],
      createPathEnv: () => LINUX_ENV,
      fs: new FakeAuthSignalFs(new Map(), new Set([configHome])),
      describeLocations: () => [],
      getSelfVersion: () => '9.9.9',
      getSelfExecutablePath: () => '/opt/mangostudio/mangostudio',
      getSelfConfigHome: () => configHome,
      now: () => 1_700_000_000_000,
    });

    const status = await service.getAgentCliStatus('mangostudio');

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
