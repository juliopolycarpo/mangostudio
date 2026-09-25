/**
 * Drives real HTTP servers through the Local environment's runtime: a
 * Streamable HTTP fixture on Bun.serve (asserting hub-stored auth headers are
 * delivered at connect and reach the wire) and a legacy SSE-only fixture on
 * node:http proving the 4xx fallback recipe — which Streamable HTTP failures the
 * runtime answers by retrying over legacy SSE is observed on the wire, not by
 * calling the runtime's classifier.
 */

import { describe, expect, it } from 'bun:test';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { LOCAL_ENVIRONMENT_ID } from '@mangostudio/shared/environments';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { connectMcpClient } from '../../../../src/services/mcp/runtime-session';
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
    environmentId: LOCAL_ENVIRONMENT_ID,
  };
}

interface LegacySseServer {
  readonly url: string;
  /** `METHOD path` of every request, in arrival order. */
  readonly requests: string[];
  stop(): Promise<void>;
}

/**
 * A legacy SSE-only MCP server whose base URL answers the modern initialize
 * POST with `answer` (a status, optionally with a plain-text 200 body).
 */
async function startLegacySseServer(answer: {
  status: number;
  text?: boolean;
}): Promise<LegacySseServer> {
  const requests: string[] = [];
  const server = createEchoMcpServer();
  let sse: SSEServerTransport | undefined;
  const httpServer: HttpServer = createServer((request, response) => {
    requests.push(`${request.method} ${request.url?.split('?')[0]}`);
    void (async () => {
      if (request.method === 'GET' && request.url === '/') {
        sse = new SSEServerTransport('/messages', response);
        await server.connect(sse);
        return;
      }
      if (request.method === 'POST' && request.url?.startsWith('/messages')) {
        await sse?.handlePostMessage(request, response);
        return;
      }
      if (answer.text) {
        response.writeHead(answer.status, { 'Content-Type': 'text/plain' }).end('not mcp');
        return;
      }
      response.writeHead(answer.status, { Allow: 'GET' }).end();
    })();
  });
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const { port } = httpServer.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/`,
    requests,
    stop: async () => {
      await server.close();
      httpServer.closeAllConnections();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
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

  for (const [label, answer, fallsBack] of [
    ['404', { status: 404 }, true],
    ['405', { status: 405 }, true],
    ['500', { status: 500 }, false],
    ['a 200 that is neither JSON nor an event stream', { status: 200, text: true }, false],
  ] as const) {
    it(`${fallsBack ? 'falls back' : 'does not fall back'} to SSE when initialize is answered with ${label}`, async () => {
      const legacy = await startLegacySseServer(answer);
      try {
        const attempt = connectMcpClient(httpConfig(legacy.url), {
          userId: 'http-transport-user',
        });
        if (fallsBack) {
          const handle = await attempt;
          expect((await handle.callTool('echo', { text: label })).contentText).toBe(label);
          await handle.close();
        } else {
          await expect(attempt).rejects.toBeInstanceOf(McpConnectionError);
        }
        // The Streamable HTTP initialize POST always comes first; only a
        // fallback opens the legacy GET event stream afterwards.
        expect(legacy.requests[0]).toBe('POST /');
        expect(legacy.requests.includes('GET /')).toBe(fallsBack);
      } finally {
        await legacy.stop();
      }
    });
  }
});
