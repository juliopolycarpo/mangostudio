import { afterEach, describe, expect, it } from 'bun:test';
import type { AgentProfile } from '@mangostudio/shared/agents';
import { LOCAL_ENVIRONMENT_ID } from '@mangostudio/shared/environments';
import type { RuntimeCapabilityManifest } from '@mangostudio/shared/runtime-protocol';
import { getDb } from '../../../../src/db/database';
import { resolveAgentRuntime } from '../../../../src/modules/generation/application/resolve-agent-runtime';
import { upsertToolSettings } from '../../../../src/modules/tool-settings/infrastructure/tool-settings-repository';
import {
  closeAllMcpClients,
  setMcpClientConnectorForTest,
} from '../../../../src/services/mcp/connection-manager';
import type { McpClientHandle } from '../../../../src/services/mcp/types';
import { makeFakeMcpHandle } from '../../../support/fixtures/mcp/fake-handle';

let seq = 0;
const RUNTIME_MANIFEST: RuntimeCapabilityManifest = {
  platform: 'linux',
  arch: 'x64',
  pathStyle: 'posix',
  homeDir: '/home/tester',
  shells: ['bash'],
  git: { available: true },
  features: {
    tools: true,
    git: true,
    probing: false,
    mcp: true,
    library: false,
    checkpoints: true,
  },
};

function nextUserId(): string {
  seq += 1;
  return `user-runtime-mcp-${seq}`;
}

async function insertServer(userId: string, slug: string, enabled = 1): Promise<string> {
  seq += 1;
  const id = `${userId}-server-${slug}-${seq}`;
  const now = Date.now();
  await getDb()
    .insertInto('mcp_servers')
    .values({
      id,
      userId,
      name: `Server ${slug}`,
      slug,
      transport: 'stdio',
      environmentId: LOCAL_ENVIRONMENT_ID,
      command: 'bun',
      argsJson: '[]',
      envJson: '{}',
      url: null,
      enabled,
      timeoutMs: null,
      createdAt: now,
      updatedAt: now,
    })
    .execute();
  return id;
}

function fakeServerWithTools(...toolNames: string[]): McpClientHandle {
  return makeFakeMcpHandle({
    listTools: () =>
      Promise.resolve(
        toolNames.map((name) => ({ name, description: '', inputSchema: { type: 'object' } }))
      ),
  });
}

function makeProfile(toolNames: string[]): AgentProfile {
  return {
    id: 'chat',
    name: 'Chat',
    description: '',
    kind: 'builtin',
    role: 'primary',
    source: { type: 'builtin' },
    systemPrompt: '',
    toolNames,
    toolsEnabled: true,
    subagentIds: [],
    metadata: {},
  };
}

function resolveWithProfile(userId: string, profile: AgentProfile) {
  return resolveAgentRuntime({
    db: getDb(),
    userId,
    provider: 'openai',
    profile,
    runtimeManifest: RUNTIME_MANIFEST,
    environmentId: LOCAL_ENVIRONMENT_ID,
  });
}

afterEach(async () => {
  setMcpClientConnectorForTest(null);
  await closeAllMcpClients();
});

describe('resolveAgentRuntime with MCP tools', () => {
  it('appends namespaced MCP definitions for a wildcard allowlist', async () => {
    const userId = nextUserId();
    await insertServer(userId, 'github');
    setMcpClientConnectorForTest(() => Promise.resolve(fakeServerWithTools('create_issue')));

    const runtime = await resolveWithProfile(userId, makeProfile(['*']));

    const names = runtime.toolDefinitions.map((definition) => definition.name);
    expect(names).toContain('mcp__github__create_issue');
    expect(runtime.allowedToolNames.has('mcp__github__create_issue')).toBe(true);
  });

  it('honors the per-server wildcard and exact-name allowlists', async () => {
    const userId = nextUserId();
    await insertServer(userId, 'github');
    await insertServer(userId, 'gitlab');
    setMcpClientConnectorForTest(() => Promise.resolve(fakeServerWithTools('ping', 'pong')));

    const wildcardRuntime = await resolveWithProfile(userId, makeProfile(['mcp__github__*']));
    expect(wildcardRuntime.toolDefinitions.map((definition) => definition.name).sort()).toEqual([
      'mcp__github__ping',
      'mcp__github__pong',
    ]);

    const exactRuntime = await resolveWithProfile(userId, makeProfile(['mcp__gitlab__ping']));
    expect(exactRuntime.toolDefinitions.map((definition) => definition.name)).toEqual([
      'mcp__gitlab__ping',
    ]);
  });

  it('hides a tool disabled in user_tool_settings from the definitions', async () => {
    const userId = nextUserId();
    await insertServer(userId, 'srv');
    setMcpClientConnectorForTest(() => Promise.resolve(fakeServerWithTools('ping', 'pong')));
    await upsertToolSettings(getDb(), userId, 'mcp__srv__ping', {
      enabled: false,
      parameters: {},
    });

    const runtime = await resolveWithProfile(userId, makeProfile(['*']));

    const names = runtime.toolDefinitions.map((definition) => definition.name);
    expect(names).not.toContain('mcp__srv__ping');
    expect(names).toContain('mcp__srv__pong');
  });

  it('exposes no MCP tools when the profile disables tools', async () => {
    const userId = nextUserId();
    await insertServer(userId, 'srv');
    setMcpClientConnectorForTest(() => Promise.resolve(fakeServerWithTools('ping')));

    const runtime = await resolveWithProfile(userId, {
      ...makeProfile(['*']),
      toolsEnabled: false,
    });

    expect(runtime.toolDefinitions).toEqual([]);
  });

  it('snapshots servers as denied without connecting when the manifest disables mcp', async () => {
    const userId = nextUserId();
    await insertServer(userId, 'srv');
    let connectCalls = 0;
    setMcpClientConnectorForTest(() => {
      connectCalls += 1;
      return Promise.resolve(fakeServerWithTools('ping'));
    });

    const runtime = await resolveAgentRuntime({
      db: getDb(),
      userId,
      provider: 'openai',
      profile: makeProfile(['*']),
      runtimeManifest: {
        ...RUNTIME_MANIFEST,
        features: { ...RUNTIME_MANIFEST.features, mcp: false },
      },
      environmentId: LOCAL_ENVIRONMENT_ID,
      environmentName: 'Local',
    });

    // The peer answers mcp.connect with RUNTIME_DENIED; spending the listing
    // budget to rediscover that is the bug this pins.
    expect(connectCalls).toBe(0);
    expect(runtime.mcpServerSnapshots).toMatchObject([
      { slug: 'srv', listed: false, runtimeDenied: true, tools: [] },
    ]);
    expect(runtime.toolDefinitions.map((definition) => definition.name)).not.toContain(
      'mcp__srv__ping'
    );
  });

  it('busts the runtime hash when a server is enabled or disabled', async () => {
    const userId = nextUserId();
    const serverId = await insertServer(userId, 'srv');
    setMcpClientConnectorForTest(() => Promise.resolve(fakeServerWithTools('ping')));
    const profile = makeProfile(['*']);

    const withServer = await resolveWithProfile(userId, profile);
    await getDb()
      .updateTable('mcp_servers')
      .set({ enabled: 0 })
      .where('id', '=', serverId)
      .execute();
    const withoutServer = await resolveWithProfile(userId, profile);

    expect(withServer.runtimeHash).not.toBe(withoutServer.runtimeHash);
    expect(withoutServer.toolDefinitions.map((definition) => definition.name)).not.toContain(
      'mcp__srv__ping'
    );
  });
});
