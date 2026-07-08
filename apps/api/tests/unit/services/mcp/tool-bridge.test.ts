import { afterEach, describe, expect, it } from 'bun:test';
import type { McpToolDescriptor } from '@mangostudio/shared/mcp';
import { getDb } from '../../../../src/db/database';
import {
  closeAllMcpClients,
  setMcpClientConnectorForTest,
} from '../../../../src/services/mcp/connection-manager';
import {
  executeMcpTool,
  listMcpBridgeTools,
  listMcpToolDefinitions,
  MCP_TOOL_EXECUTE_TIMEOUT_MS,
} from '../../../../src/services/mcp/tool-bridge';
import type { McpClientHandle, McpRequestOptions } from '../../../../src/services/mcp/types';
import { McpConnectionError } from '../../../../src/services/mcp/types';

// The in-memory database and the connection registry are shared per process,
// so every test uses fresh user/server ids for isolation.
let seq = 0;
function nextUserId(): string {
  seq += 1;
  return `user-mcp-bridge-${seq}`;
}

async function insertServer(
  userId: string,
  slug: string,
  overrides: Partial<{ name: string; enabled: number; timeoutMs: number | null }> = {}
): Promise<void> {
  seq += 1;
  const now = Date.now();
  await getDb()
    .insertInto('mcp_servers')
    .values({
      id: `${userId}-server-${slug}-${seq}`,
      userId,
      name: overrides.name ?? `Server ${slug}`,
      slug,
      transport: 'stdio',
      command: 'bun',
      argsJson: '[]',
      envJson: '{}',
      url: null,
      enabled: overrides.enabled ?? 1,
      timeoutMs: overrides.timeoutMs ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .execute();
}

function makeHandle(overrides: Partial<McpClientHandle> = {}): McpClientHandle {
  return {
    listTools: () => Promise.resolve([]),
    callTool: () =>
      Promise.resolve({ contentText: '', isError: false, rawContentKinds: [], content: [] }),
    close: () => Promise.resolve(),
    ...overrides,
  };
}

function echoTools(tools: McpToolDescriptor[]): McpClientHandle {
  return makeHandle({ listTools: () => Promise.resolve(tools) });
}

afterEach(async () => {
  setMcpClientConnectorForTest(null);
  await closeAllMcpClients();
});

describe('listMcpBridgeTools', () => {
  it('namespaces tools and passes schemas through with provenance', async () => {
    const userId = nextUserId();
    await insertServer(userId, 'github', { name: 'GitHub' });
    const inputSchema = { type: 'object', properties: { title: { type: 'string' } } };
    setMcpClientConnectorForTest(() =>
      Promise.resolve(
        echoTools([{ name: 'create_issue', description: 'Creates an issue.', inputSchema }])
      )
    );

    const tools = await listMcpBridgeTools(getDb(), userId);

    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      name: 'mcp__github__create_issue',
      serverName: 'GitHub',
      serverSlug: 'github',
      toolName: 'create_issue',
    });
    expect(tools[0]?.definition).toEqual({
      name: 'mcp__github__create_issue',
      description: '[GitHub] Creates an issue.',
      parameters: inputSchema,
    });
  });

  it('falls back to an empty object schema for invalid inputSchema', async () => {
    const userId = nextUserId();
    await insertServer(userId, 'srv');
    setMcpClientConnectorForTest(() =>
      Promise.resolve(
        echoTools([
          { name: 'no-schema', description: '', inputSchema: undefined },
          { name: 'bad-schema', description: '', inputSchema: ['not', 'a', 'schema'] },
        ])
      )
    );

    const definitions = await listMcpToolDefinitions(getDb(), userId);

    expect(definitions.map((definition) => definition.parameters)).toEqual([
      { type: 'object', properties: {} },
      { type: 'object', properties: {} },
    ]);
  });

  it('skips tools whose namespaced name exceeds the provider limit', async () => {
    const userId = nextUserId();
    await insertServer(userId, 'srv');
    setMcpClientConnectorForTest(() =>
      Promise.resolve(
        echoTools([
          { name: 'ok', description: '', inputSchema: { type: 'object' } },
          { name: 'x'.repeat(80), description: '', inputSchema: { type: 'object' } },
        ])
      )
    );

    const definitions = await listMcpToolDefinitions(getDb(), userId);

    expect(definitions.map((definition) => definition.name)).toEqual(['mcp__srv__ok']);
  });

  it('skips a failing server but keeps the other servers’ tools', async () => {
    const userId = nextUserId();
    await insertServer(userId, 'broken');
    await insertServer(userId, 'healthy');
    setMcpClientConnectorForTest((config) => {
      if (config.slug === 'broken') {
        return Promise.reject(new McpConnectionError('connection refused'));
      }
      return Promise.resolve(
        echoTools([{ name: 'ping', description: '', inputSchema: { type: 'object' } }])
      );
    });

    const definitions = await listMcpToolDefinitions(getDb(), userId);

    expect(definitions.map((definition) => definition.name)).toEqual(['mcp__healthy__ping']);
  });

  it('ignores disabled servers and other users’ servers', async () => {
    const userId = nextUserId();
    await insertServer(userId, 'off', { enabled: 0 });
    await insertServer(nextUserId(), 'foreign');
    setMcpClientConnectorForTest(() =>
      Promise.resolve(echoTools([{ name: 'ping', description: '', inputSchema: {} }]))
    );

    expect(await listMcpToolDefinitions(getDb(), userId)).toEqual([]);
  });
});

describe('executeMcpTool', () => {
  it('routes the call to the owning server with the per-server timeout', async () => {
    const userId = nextUserId();
    await insertServer(userId, 'github', { timeoutMs: 5_000 });
    const calls: Array<{
      name: string;
      args: Record<string, unknown>;
      options?: McpRequestOptions;
    }> = [];
    setMcpClientConnectorForTest(() =>
      Promise.resolve(
        makeHandle({
          callTool: (name, args, options) => {
            calls.push({ name, args, options });
            return Promise.resolve({
              contentText: 'issue created',
              isError: false,
              rawContentKinds: ['text'],
              content: [{ type: 'text' as const, text: 'issue created' }],
            });
          },
        })
      )
    );

    const result = await executeMcpTool(getDb(), userId, 'mcp__github__create_issue', {
      title: 'bug',
    });

    expect(result).toEqual({
      contentText: 'issue created',
      isError: false,
      rawContentKinds: ['text'],
      content: [{ type: 'text', text: 'issue created' }],
    });
    expect(calls).toEqual([
      {
        name: 'create_issue',
        args: { title: 'bug' },
        options: { timeoutMs: 5_000, signal: undefined },
      },
    ]);
  });

  it('defaults the timeout when the server row has none', async () => {
    const userId = nextUserId();
    await insertServer(userId, 'srv');
    let seen: McpRequestOptions | undefined;
    setMcpClientConnectorForTest(() =>
      Promise.resolve(
        makeHandle({
          callTool: (_name, _args, options) => {
            seen = options;
            return Promise.resolve({
              contentText: '',
              isError: false,
              rawContentKinds: [],
              content: [],
            });
          },
        })
      )
    );

    await executeMcpTool(getDb(), userId, 'mcp__srv__ping', {});

    expect(seen?.timeoutMs).toBe(MCP_TOOL_EXECUTE_TIMEOUT_MS);
  });

  it('surfaces MCP tool errors as isError results', async () => {
    const userId = nextUserId();
    await insertServer(userId, 'srv');
    setMcpClientConnectorForTest(() =>
      Promise.resolve(
        makeHandle({
          callTool: () =>
            Promise.resolve({
              contentText: 'boom',
              isError: true,
              rawContentKinds: ['text'],
              content: [{ type: 'text' as const, text: 'boom' }],
            }),
        })
      )
    );

    const result = await executeMcpTool(getDb(), userId, 'mcp__srv__ping', {});

    expect(result.isError).toBe(true);
    expect(result.contentText).toBe('boom');
  });

  it('rejects malformed names, unknown servers, and disabled servers', async () => {
    const userId = nextUserId();
    await insertServer(userId, 'off', { enabled: 0 });
    setMcpClientConnectorForTest(() => Promise.resolve(makeHandle()));

    expect(executeMcpTool(getDb(), userId, 'mcp____x', {})).rejects.toThrow('Unknown tool');
    expect(executeMcpTool(getDb(), userId, 'mcp__missing__ping', {})).rejects.toThrow(
      'not configured'
    );
    expect(executeMcpTool(getDb(), userId, 'mcp__off__ping', {})).rejects.toThrow('disabled');
  });

  it('never resolves another user’s server through the same slug', async () => {
    const owner = nextUserId();
    const intruder = nextUserId();
    await insertServer(owner, 'shared-slug');
    setMcpClientConnectorForTest(() => Promise.resolve(makeHandle()));

    expect(executeMcpTool(getDb(), intruder, 'mcp__shared-slug__ping', {})).rejects.toThrow(
      'not configured'
    );
  });
});
