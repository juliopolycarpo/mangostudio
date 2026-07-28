import { describe, expect, it } from 'bun:test';
import type {
  AgentCliStatus,
  RuntimeStatus,
  VersionManagerStatus,
} from '@mangostudio/shared/environments';
import { Value } from '@sinclair/typebox/value';
import { parseEnvArgs } from '../../../src/cli/args';
import { CliEnvironmentSnapshotSchema, runEnv } from '../../../src/cli/commands/env';
import { CliError } from '../../../src/cli/errors';

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

describe('parseEnvArgs', () => {
  it('accepts --json without a subcommand', () => {
    expect(parseEnvArgs(['--json'])).toEqual({ subcommand: null, json: true });
  });

  it('rejects unknown flags', () => {
    expect(() => parseEnvArgs(['--install'])).toThrow(CliError);
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
