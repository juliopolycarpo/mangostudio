/**
 * Shared MCP test server: three tools exercising the wrapper contract
 * (text echo, env visibility for spawn-hygiene assertions, and a hard crash
 * for session-loss tests). Used in-process over the in-memory and HTTP
 * transports, and by the spawned stdio fixture script.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

export function createEchoMcpServer(): Server {
  const server = new Server(
    { name: 'echo-fixture', version: '1.0.0' },
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
        name: 'env-keys',
        description: 'Lists the environment variable names visible to this process.',
        inputSchema: { type: 'object' as const, properties: {} },
      },
      {
        name: 'crash',
        description: 'Exits the server process immediately.',
        inputSchema: { type: 'object' as const, properties: {} },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, (request) => {
    const { name } = request.params;
    if (name === 'echo') {
      const text = request.params.arguments?.text;
      return { content: [{ type: 'text', text: typeof text === 'string' ? text : '' }] };
    }
    if (name === 'env-keys') {
      return { content: [{ type: 'text', text: JSON.stringify(Object.keys(process.env)) }] };
    }
    if (name === 'crash') {
      process.exit(1);
    }
    return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
  });

  return server;
}
