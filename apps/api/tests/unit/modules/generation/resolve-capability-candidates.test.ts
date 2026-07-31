import { describe, expect, it } from 'bun:test';
import type { AgentProfile } from '@mangostudio/shared/agents';
import type { RuntimeCapabilityManifest } from '@mangostudio/shared/runtime-protocol';
import {
  effectiveToolDefinitions,
  type ResolveToolCandidatesInput,
  resolveToolCandidates,
} from '../../../../src/modules/generation/application/resolve-capability-candidates';
import type { McpBridgeServerSnapshot } from '../../../../src/services/mcp/tool-bridge';
import type {
  EffectiveToolSettings,
  RegisteredTool,
  ToolDefinition,
} from '../../../../src/services/tools/types';

const RUNTIME_MANIFEST: RuntimeCapabilityManifest = {
  platform: 'linux',
  arch: 'x64',
  pathStyle: 'posix',
  homeDir: '/home/tester',
  shells: ['bash', 'zsh', 'powershell'],
  git: { available: true, version: '2.0.0' },
  features: {
    tools: true,
    git: true,
    probing: false,
    mcp: false,
    library: false,
    checkpoints: true,
  },
};

function resolveCandidates(
  input: Omit<ResolveToolCandidatesInput, 'runtimeManifest'> & {
    runtimeManifest?: RuntimeCapabilityManifest;
  }
) {
  return resolveToolCandidates({ runtimeManifest: RUNTIME_MANIFEST, ...input });
}

function makeProfile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: 'chat',
    name: 'Chat',
    description: '',
    kind: 'builtin',
    role: 'primary',
    source: { type: 'builtin' },
    systemPrompt: '',
    toolNames: ['*'],
    toolsEnabled: true,
    subagentIds: [],
    metadata: {},
    ...overrides,
  };
}

function makeRegisteredTool(name: string, overrides: Partial<RegisteredTool> = {}): RegisteredTool {
  return {
    definition: { name, description: '', parameters: { type: 'object', properties: {} } },
    settings: {
      title: `Title ${name}`,
      description: '',
      category: 'system',
      enabledByDefault: true,
      canDisable: true,
      defaultParameters: {},
      parameterDescriptors: [],
    },
    execute: () => Promise.resolve(null),
    ...overrides,
  };
}

function makeSnapshot(
  slug: string,
  toolNames: string[],
  overrides: Partial<McpBridgeServerSnapshot> = {}
): McpBridgeServerSnapshot {
  return {
    serverId: `server-${slug}`,
    slug,
    name: `Server ${slug}`,
    tools: toolNames.map((toolName) => {
      const name = `mcp__${slug}__${toolName}`;
      return {
        name,
        serverName: `Server ${slug}`,
        serverSlug: slug,
        toolName,
        definition: { name, description: '', parameters: { type: 'object', properties: {} } },
      };
    }),
    overlongToolNames: [],
    listed: true,
    ...overrides,
  };
}

function settingsMap(
  entries: Record<string, Partial<EffectiveToolSettings>>
): Map<string, EffectiveToolSettings> {
  return new Map(
    Object.entries(entries).map(([name, value]) => [
      name,
      { enabled: true, parameters: {}, ...value },
    ])
  );
}

describe('resolveToolCandidates', () => {
  it('marks builtin candidates agent-tools-disabled when the profile disables tools', () => {
    // Real callers pass no MCP servers when tools are disabled (see
    // resolveAgentRuntime), so only the builtin gate is exercised here.
    const candidates = resolveCandidates({
      profile: makeProfile({ toolsEnabled: false }),
      toolSettings: new Map(),
      registeredTools: [makeRegisteredTool('alpha'), makeRegisteredTool('beta')],
      mcpServers: [],
    });

    expect(candidates.map((candidate) => candidate.reason)).toEqual([
      'agent-tools-disabled',
      'agent-tools-disabled',
    ]);
    expect(effectiveToolDefinitions(candidates)).toEqual([]);
  });

  it('rejects names outside the agent allowlist with agent-allowlist', () => {
    const candidates = resolveCandidates({
      profile: makeProfile({ toolNames: ['alpha', 'mcp__srv__*'] }),
      toolSettings: new Map(),
      registeredTools: [makeRegisteredTool('alpha'), makeRegisteredTool('beta')],
      mcpServers: [makeSnapshot('srv', ['ping']), makeSnapshot('other', ['pong'])],
    });

    const byName = new Map(candidates.map((candidate) => [candidate.name, candidate]));
    expect(byName.get('alpha')?.definition).toBeDefined();
    expect(byName.get('beta')?.reason).toBe('agent-allowlist');
    expect(byName.get('mcp__srv__ping')?.definition).toBeDefined();
    expect(byName.get('mcp__other__pong')?.reason).toBe('agent-allowlist');
  });

  it('treats an empty allowlist as rejecting every candidate', () => {
    const candidates = resolveCandidates({
      profile: makeProfile({ toolNames: [] }),
      toolSettings: new Map(),
      registeredTools: [makeRegisteredTool('alpha')],
      mcpServers: [makeSnapshot('srv', ['ping'])],
    });

    expect(candidates.every((candidate) => candidate.reason === 'agent-allowlist')).toBe(true);
  });

  it('rejects tools disabled in settings with tool-setting-disabled', () => {
    const candidates = resolveCandidates({
      profile: makeProfile(),
      toolSettings: settingsMap({
        alpha: { enabled: false },
        mcp__srv__ping: { enabled: false },
      }),
      registeredTools: [makeRegisteredTool('alpha'), makeRegisteredTool('beta')],
      mcpServers: [makeSnapshot('srv', ['ping', 'pong'])],
    });

    const byName = new Map(candidates.map((candidate) => [candidate.name, candidate]));
    expect(byName.get('alpha')?.reason).toBe('tool-setting-disabled');
    expect(byName.get('mcp__srv__ping')?.reason).toBe('tool-setting-disabled');
    expect(effectiveToolDefinitions(candidates).map((definition) => definition.name)).toEqual([
      'beta',
      'mcp__srv__pong',
    ]);
  });

  it('honors a disabled-by-default builtin without saved settings', () => {
    const optIn = makeRegisteredTool('bash');
    optIn.settings.enabledByDefault = false;

    const candidates = resolveCandidates({
      profile: makeProfile(),
      toolSettings: new Map(),
      registeredTools: [optIn],
      mcpServers: [],
    });

    expect(candidates[0]?.reason).toBe('tool-setting-disabled');
  });

  it('reports overlong MCP names with provenance and keeps them out of the definitions', () => {
    const overlongName = `mcp__srv__${'x'.repeat(80)}`;
    const candidates = resolveCandidates({
      profile: makeProfile(),
      toolSettings: new Map(),
      registeredTools: [],
      mcpServers: [makeSnapshot('srv', ['ping'], { overlongToolNames: [overlongName] })],
    });

    const overlong = candidates.find((candidate) => candidate.name === overlongName);
    expect(overlong?.reason).toBe('name-over-provider-limit');
    expect(overlong?.serverSlug).toBe('srv');
    expect(overlong?.title).toBe('x'.repeat(80));
    expect(effectiveToolDefinitions(candidates).map((definition) => definition.name)).toEqual([
      'mcp__srv__ping',
    ]);
  });

  it('uses buildDefinition for effective builtins and preserves definition order', () => {
    const dynamicDefinition: ToolDefinition = {
      name: 'alpha',
      description: 'dynamic',
      parameters: { type: 'object', properties: {} },
    };
    const dynamicTool = makeRegisteredTool('alpha', {
      buildDefinition: () => dynamicDefinition,
    });

    const candidates = resolveCandidates({
      profile: makeProfile(),
      toolSettings: new Map(),
      registeredTools: [dynamicTool, makeRegisteredTool('beta')],
      mcpServers: [makeSnapshot('srv', ['ping'])],
    });

    const definitions = effectiveToolDefinitions(candidates);
    expect(definitions[0]).toBe(dynamicDefinition);
    expect(definitions.map((definition) => definition.name)).toEqual([
      'alpha',
      'beta',
      'mcp__srv__ping',
    ]);
  });

  it('rejects shell tools missing from the selected environment manifest', () => {
    const candidates = resolveCandidates({
      profile: makeProfile(),
      toolSettings: settingsMap({ bash: { enabled: true }, zsh: { enabled: true } }),
      registeredTools: [makeRegisteredTool('bash'), makeRegisteredTool('zsh')],
      mcpServers: [],
      runtimeManifest: { ...RUNTIME_MANIFEST, shells: ['bash'] },
    });

    const byName = new Map(candidates.map((candidate) => [candidate.name, candidate]));
    expect(byName.get('bash')?.definition).toBeDefined();
    expect(byName.get('zsh')?.reason).toBe('environment-unsupported');
    expect(effectiveToolDefinitions(candidates).map((definition) => definition.name)).toEqual([
      'bash',
    ]);
  });

  it('carries provenance metadata on every candidate', () => {
    const candidates = resolveCandidates({
      profile: makeProfile(),
      toolSettings: new Map(),
      registeredTools: [makeRegisteredTool('alpha')],
      mcpServers: [makeSnapshot('srv', ['ping'])],
    });

    const builtin = candidates.find((candidate) => candidate.name === 'alpha');
    expect(builtin?.source).toBe('builtin');
    expect(builtin?.title).toBe('Title alpha');
    expect(builtin?.category).toBe('system');

    const mcp = candidates.find((candidate) => candidate.name === 'mcp__srv__ping');
    expect(mcp?.source).toBe('mcp');
    expect(mcp?.title).toBe('ping');
    expect(mcp?.serverSlug).toBe('srv');
    expect(mcp?.serverName).toBe('Server srv');
  });
});
