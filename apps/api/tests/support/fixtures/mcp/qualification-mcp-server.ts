/**
 * MCP server for the real-runtime qualification lane, built on the official TypeScript SDK so the
 * Rust runtime's client is qualified against the same server implementation the ecosystem ships.
 * One factory serves stdio (run this file directly) and HTTP ({@link startQualificationHttpServer}).
 */

import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

/** Tool, resource, and prompt surface every qualification transport exposes. */
export function createQualificationMcpServer(): Server {
  const server = new Server(
    { name: 'qualification-fixture', version: '1.0.0' },
    { capabilities: { tools: { listChanged: true }, resources: {}, prompts: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: ['echo', 'env-keys', 'big', 'elicit', 'notify', 'crash'].map((name) => ({
      name,
      description: `Qualification tool ${name}.`,
      inputSchema: { type: 'object' as const, properties: {} },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name } = request.params;
    const text = (value: string) => ({ content: [{ type: 'text' as const, text: value }] });
    if (name === 'echo') return text(String(request.params.arguments?.text ?? ''));
    if (name === 'env-keys') return text(JSON.stringify(Object.keys(process.env).sort()));
    if (name === 'big') return text('q'.repeat(200_000));
    if (name === 'elicit') {
      const answer = await server.elicitInput({
        mode: 'form',
        message: 'Who is asking?',
        requestedSchema: {
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string', title: 'Name' },
            email: { type: 'string', format: 'email' },
            age: { type: 'integer', minimum: 0 },
          },
        },
      });
      return text(JSON.stringify(answer));
    }
    if (name === 'notify') {
      await server.sendToolListChanged();
      return text('notified');
    }
    if (name === 'crash') process.exit(1);
    return { ...text(`Unknown tool: ${name}`), isError: true };
  });

  server.setRequestHandler(ListResourcesRequestSchema, () => ({
    resources: [
      { uri: 'qualification://notes', name: 'notes', title: 'Notes', mimeType: 'text/plain' },
    ],
  }));
  server.setRequestHandler(ReadResourceRequestSchema, (request) => ({
    contents: [{ uri: request.params.uri, mimeType: 'text/plain', text: 'qualification notes' }],
  }));
  server.setRequestHandler(ListPromptsRequestSchema, () => ({
    prompts: [
      {
        name: 'greet',
        description: 'Greets someone.',
        arguments: [{ name: 'who', required: true }],
      },
    ],
  }));
  server.setRequestHandler(GetPromptRequestSchema, (request) => ({
    messages: [
      {
        role: 'user' as const,
        content: { type: 'text' as const, text: `Hello ${request.params.arguments?.who ?? ''}` },
      },
    ],
  }));

  return server;
}

/** One request as the HTTP fixture received it. */
export interface QualificationRequest {
  readonly method: string;
  readonly path: string;
  readonly authorization: string | undefined;
}

export interface QualificationHttpServer {
  readonly url: string;
  readonly requests: QualificationRequest[];
  stop(): Promise<void>;
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : undefined;
}

/**
 * Serves the qualification surface on loopback: stateless streamable HTTP, or an SSE-only
 * legacy server whose base URL refuses POST (so a modern client falls back).
 *
 * @example
 * const server = await startQualificationHttpServer('streamable');
 * try { ... } finally { await server.stop(); }
 */
export async function startQualificationHttpServer(
  mode: 'streamable' | 'legacy-sse'
): Promise<QualificationHttpServer> {
  const requests: QualificationRequest[] = [];
  const sessions = new Map<string, SSEServerTransport>();
  const http = createServer(async (request, response) => {
    const path = request.url ?? '/';
    requests.push({
      method: request.method ?? '',
      path,
      authorization: request.headers.authorization,
    });
    if (mode === 'streamable') {
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      const server = createQualificationMcpServer();
      response.on('close', () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      const body = request.method === 'POST' ? await readBody(request) : undefined;
      await transport.handleRequest(request, response, body);
      return;
    }
    if (request.method === 'GET' && path === '/mcp') {
      const transport = new SSEServerTransport('/messages', response);
      sessions.set(transport.sessionId, transport);
      response.on('close', () => sessions.delete(transport.sessionId));
      await createQualificationMcpServer().connect(transport);
      return;
    }
    if (request.method === 'POST' && path.startsWith('/messages')) {
      const sessionId = new URL(path, 'http://fixture').searchParams.get('sessionId') ?? '';
      const transport = sessions.get(sessionId);
      if (transport) {
        await transport.handlePostMessage(request, response);
        return;
      }
    }
    response.writeHead(404, { 'content-type': 'text/plain' }).end('Cannot POST /mcp');
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const { port } = http.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    requests,
    stop: () =>
      new Promise<void>((resolve) => {
        http.closeAllConnections();
        http.close(() => resolve());
      }),
  };
}

if (import.meta.main) {
  await createQualificationMcpServer().connect(new StdioServerTransport());
}
