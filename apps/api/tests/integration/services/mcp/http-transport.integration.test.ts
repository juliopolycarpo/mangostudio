/**
 * Drives the client factory against real HTTP servers: a Streamable HTTP
 * fixture on Bun.serve (asserting stored auth headers reach the wire) and a
 * legacy SSE-only fixture on node:http proving the 4xx fallback recipe.
 */

import { describe, expect, it } from 'bun:test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { connectMcpClient, shouldFallBackToSse } from '../../../../src/services/mcp/client-factory';
import {
  McpConnectionError,
  type McpServerRuntimeConfig,
} from '../../../../src/services/mcp/types';
import { createEchoMcpServer } from '../../../support/fixtures/mcp/create-echo-mcp-server';

function httpConfig(url: string): McpServerRuntimeConfig {
  return {
    id: 'http-server',
    slug: 'http-server',
    transport: 'http',
    command: null,
    args: [],
    env: {},
    url,
    timeoutMs: 5_000,
  };
}

describe('mcp http transport', () => {
  it('connects over Streamable HTTP and sends stored auth headers on every request', async () => {
    const seenAuth: Array<string | null> = [];
    // Stateful mode: one transport serves the whole session (stateless mode
    // requires a fresh transport per request, which doesn't fit one client).
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      enableJsonResponse: true,
    });
    const server = createEchoMcpServer();
    await server.connect(transport);
    const bunServer = Bun.serve({
      port: 0,
      fetch: (request) => {
        seenAuth.push(request.headers.get('authorization'));
        return transport.handleRequest(request);
      },
    });

    try {
      const handle = await connectMcpClient(httpConfig(`http://localhost:${bunServer.port}/`), {
        userId: 'http-transport-user',
        resolveHeaders: () => Promise.resolve({ Authorization: 'Bearer test-token' }),
      });

      const tools = await handle.listTools();
      expect(tools.map((tool) => tool.name)).toEqual(['echo', 'env-keys', 'crash']);

      const result = await handle.callTool('echo', { text: 'over http' });
      expect(result.contentText).toBe('over http');

      expect(seenAuth.length).toBeGreaterThan(0);
      expect(seenAuth.every((value) => value === 'Bearer test-token')).toBe(true);

      await handle.close();
    } finally {
      await server.close();
      bunServer.stop(true);
    }
  });

  it('falls back to SSE when the Streamable HTTP POST is rejected with a 4xx', async () => {
    const server = createEchoMcpServer();
    let sse: SSEServerTransport | undefined;
    const httpServer = createServer((request, response) => {
      void (async () => {
        if (request.method === 'GET') {
          sse = new SSEServerTransport('/messages', response);
          await server.connect(sse);
          return;
        }
        if (request.method === 'POST' && request.url?.startsWith('/messages')) {
          await sse?.handlePostMessage(request, response);
          return;
        }
        // Legacy SSE-only servers reject the modern initialize POST.
        response.writeHead(405, { Allow: 'GET' }).end();
      })();
    });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    const { port } = httpServer.address() as AddressInfo;

    try {
      const handle = await connectMcpClient(httpConfig(`http://localhost:${port}/`), {
        userId: 'http-transport-user',
      });

      const tools = await handle.listTools();
      expect(tools.map((tool) => tool.name)).toEqual(['echo', 'env-keys', 'crash']);

      const result = await handle.callTool('echo', { text: 'over sse' });
      expect(result.contentText).toBe('over sse');

      await handle.close();
    } finally {
      await server.close();
      httpServer.close();
    }
  });

  it('reports unreachable servers as McpConnectionError without falling back', async () => {
    // Port 9 (discard) is unassigned on loopback — connection refused fast.
    const attempt = connectMcpClient(httpConfig('http://127.0.0.1:9/'), {
      userId: 'http-transport-user',
    });

    await expect(attempt).rejects.toBeInstanceOf(McpConnectionError);
  });

  it('only 4xx Streamable HTTP failures trigger the SSE fallback', () => {
    expect(shouldFallBackToSse(new StreamableHTTPError(404, 'not found'))).toBe(true);
    expect(shouldFallBackToSse(new StreamableHTTPError(405, 'method not allowed'))).toBe(true);
    expect(shouldFallBackToSse(new StreamableHTTPError(500, 'server error'))).toBe(false);
    expect(shouldFallBackToSse(new StreamableHTTPError(undefined, 'no status'))).toBe(false);
    expect(shouldFallBackToSse(new Error('fetch failed'))).toBe(false);
  });
});
