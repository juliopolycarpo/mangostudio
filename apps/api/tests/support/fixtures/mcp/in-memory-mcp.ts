/**
 * In-memory MCP fixture for turn-level end-to-end tests: a real SDK server
 * (echo, oversized-output, error, and hang tools) linked to the client over
 * the SDK's in-memory transport, exposed as a connection-manager connector.
 * The transport wiring specifics (stdio spawn, HTTP) are covered by the
 * dedicated transport integration tests; this fixture keeps the turn tests
 * deterministic while still exercising the real SDK request/response path.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { connectMcpClient } from '../../../../src/services/mcp/client-factory';
import { wrapMcpClient } from '../../../../src/services/mcp/client-factory';
import type { McpClientHandle } from '../../../../src/services/mcp/types';

/** Length of the oversized `big` tool payload; well past the 64 KiB result cap. */
export const OVERSIZED_TOOL_OUTPUT_LENGTH = 100_000;

/** Builds the turn-fixture MCP server with one tool per failure mode. */
export function createTurnMcpServer(): Server {
  const server = new Server(
    { name: 'turn-fixture', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [
      {
        name: 'echo',
        description: 'Echoes the given text back.',
        inputSchema: {
          type: 'object' as const,
          properties: { text: { type: 'string' } },
          required: ['text'],
        },
      },
      {
        name: 'big',
        description: 'Returns an oversized payload to exercise the result cap.',
        inputSchema: { type: 'object' as const, properties: {} },
      },
      {
        name: 'boom',
        description: 'Returns a tool error result.',
        inputSchema: { type: 'object' as const, properties: {} },
      },
      {
        name: 'hang',
        description: 'Never resolves, to exercise the per-server timeout.',
        inputSchema: { type: 'object' as const, properties: {} },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name } = request.params;
    if (name === 'echo') {
      const text = request.params.arguments?.text;
      return { content: [{ type: 'text', text: typeof text === 'string' ? text : '' }] };
    }
    if (name === 'big') {
      return { content: [{ type: 'text', text: 'a'.repeat(OVERSIZED_TOOL_OUTPUT_LENGTH) }] };
    }
    if (name === 'boom') {
      return { content: [{ type: 'text', text: 'tool exploded' }], isError: true };
    }
    if (name === 'hang') {
      await new Promise(() => undefined);
    }
    return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
  });

  return server;
}

/**
 * Returns a connection-manager connector that links a fresh in-memory server
 * to each client, so a reconnect after a dropped session gets a live server.
 * // Usage: setMcpClientConnectorForTest(inMemoryMcpConnector())
 */
export function inMemoryMcpConnector(
  createServer: () => Server = createTurnMcpServer
): typeof connectMcpClient {
  return async (config, options = {}): Promise<McpClientHandle> => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createServer();
    await server.connect(serverTransport);
    const client = new Client({ name: 'turn-fixture-client', version: '0.0.0' });
    await client.connect(clientTransport);
    return wrapMcpClient(client, config, options);
  };
}
