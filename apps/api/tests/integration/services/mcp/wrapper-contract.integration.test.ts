/**
 * Pins the SDK-wrapper contract as the hub sees it (initialize → listTools →
 * callTool, content mapping, close propagation) through the Local runtime's
 * `mcp.*` methods: a real SDK server, spawned as a stdio server through the
 * relay fixture, answers the runtime's own MCP client. An SDK bump — or a
 * runtime implementation — that shifts these semantics fails loudly here rather
 * than at a user's MCP server.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { LOCAL_ENVIRONMENT_ID } from '@mangostudio/shared/environments';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { connectMcpClient } from '../../../../src/services/mcp/runtime-session';
import type { McpClientHandle } from '../../../../src/services/mcp/types';
import { createEchoMcpServer } from '../../../support/fixtures/mcp/create-echo-mcp-server';
import { type McpRelayHost, startMcpRelayHost } from '../../../support/fixtures/mcp/mcp-relay-host';

const USER_ID = 'wrapper-contract-user';

let relay: McpRelayHost;
let server: Server | undefined;
const handles: McpClientHandle[] = [];

beforeEach(async () => {
  relay = await startMcpRelayHost();
});

afterEach(async () => {
  await Promise.allSettled(handles.splice(0).map((handle) => handle.close()));
  server = undefined;
  await relay.close();
  relay.assertNoOpenServers();
});

/** Connects a fresh echo server through the Local runtime; `server` is the one it reached. */
async function connectEcho(
  serverId: string,
  callbacks: { onSessionClosed?: () => void } = {}
): Promise<McpClientHandle> {
  const launch = relay.route(() => {
    server = createEchoMcpServer();
    return server;
  });
  const handle = await connectMcpClient(
    {
      id: serverId,
      slug: serverId,
      transport: 'stdio',
      command: launch.command,
      args: [...launch.args],
      env: {},
      url: null,
      timeoutMs: null,
      environmentId: LOCAL_ENVIRONMENT_ID,
    },
    { userId: USER_ID, ...callbacks }
  );
  handles.push(handle);
  return handle;
}

/** Rejects with a readable reason when `promise` does not settle within 5 s. */
function within<T>(label: string, promise: Promise<T>): Promise<T> {
  return Promise.race([
    promise,
    Bun.sleep(5_000).then(() => {
      throw new Error(`expected ${label} within 5000 ms | received nothing`);
    }),
  ]);
}

describe('mcp client wrapper contract', () => {
  it('lists tools as flattened descriptors', async () => {
    const handle = await connectEcho('wrapper-list');

    const tools = await handle.listTools();

    expect(tools.map((tool) => tool.name)).toEqual(['echo', 'env-keys', 'crash']);
    expect(tools[0]).toMatchObject({
      name: 'echo',
      description: 'Echoes the given text back.',
    });
    expect(tools[0]?.inputSchema).toMatchObject({ type: 'object' });
  });

  it('maps text content and error flags from tool calls', async () => {
    const handle = await connectEcho('wrapper-call');

    const ok = await handle.callTool('echo', { text: 'hello mcp' });
    expect(ok).toEqual({
      contentText: 'hello mcp',
      isError: false,
      rawContentKinds: ['text'],
      content: [{ type: 'text', text: 'hello mcp' }],
    });

    const failed = await handle.callTool('nonexistent', {});
    expect(failed.isError).toBe(true);
    expect(failed.contentText).toContain('nonexistent');
  });

  it('notifies onSessionClosed when the server drops the session, not on our close', async () => {
    let drops = 0;
    const firstDrop = Promise.withResolvers<void>();
    const onSessionClosed = () => {
      drops += 1;
      firstDrop.resolve();
    };
    await connectEcho('wrapper-drop', { onSessionClosed });

    await server?.close();
    await within('the dropped session to reach onSessionClosed', firstDrop.promise);
    expect(drops).toBe(1);

    const second = await connectEcho('wrapper-own-close', { onSessionClosed });
    await second.close();
    await relay.waitForNoOpenServers();
    // Runtime events arrive in order on one connection: once a later call on it
    // has answered, any `closed` event the own close could have produced has
    // already been delivered.
    const probe = await connectEcho('wrapper-probe');
    await probe.listTools();
    expect(drops).toBe(1);
  });
});
