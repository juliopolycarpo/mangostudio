/**
 * Pins the SDK behavior the wrapper relies on (initialize → listTools →
 * callTool, content mapping, close propagation) over the SDK's in-memory
 * transport pair, so an SDK bump that shifts semantics fails loudly here.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { wrapMcpClient } from '../../../../src/services/mcp/client-factory';
import { createEchoMcpServer } from '../../../support/fixtures/mcp/create-echo-mcp-server';

let server: Server | undefined;
let client: Client | undefined;

function wrapOptions(
  overrides: Partial<{
    onSessionClosed: () => void;
    onToolListChanged: () => void;
  }> = {}
) {
  return {
    userId: 'wrapper-contract-user',
    serverId: 'wrapper-server',
    serverSlug: 'wrapper-server',
    ...overrides,
  };
}

async function connectInMemory(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  server = createEchoMcpServer();
  await server.connect(serverTransport);
  client = new Client(
    { name: 'wrapper-contract-test', version: '0.0.0' },
    { capabilities: { elicitation: { form: {} } } }
  );
  await client.connect(clientTransport);
  return client;
}

afterEach(async () => {
  await client?.close();
  await server?.close();
  client = undefined;
  server = undefined;
});

describe('mcp client wrapper contract', () => {
  it('lists tools as flattened descriptors', async () => {
    const handle = wrapMcpClient(await connectInMemory(), { timeoutMs: null }, wrapOptions());

    const tools = await handle.listTools();

    expect(tools.map((tool) => tool.name)).toEqual(['echo', 'env-keys', 'crash']);
    expect(tools[0]).toMatchObject({
      name: 'echo',
      description: 'Echoes the given text back.',
    });
    expect(tools[0]?.inputSchema).toMatchObject({ type: 'object' });
  });

  it('maps text content and error flags from tool calls', async () => {
    const handle = wrapMcpClient(await connectInMemory(), { timeoutMs: null }, wrapOptions());

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
    wrapMcpClient(
      await connectInMemory(),
      { timeoutMs: null },
      wrapOptions({
        onSessionClosed: () => {
          drops += 1;
        },
      })
    );

    await server?.close();
    await Bun.sleep(0);
    expect(drops).toBe(1);

    const second = wrapMcpClient(
      await connectInMemory(),
      { timeoutMs: null },
      wrapOptions({
        onSessionClosed: () => {
          drops += 1;
        },
      })
    );
    await second.close();
    await Bun.sleep(0);
    expect(drops).toBe(1);
  });
});
