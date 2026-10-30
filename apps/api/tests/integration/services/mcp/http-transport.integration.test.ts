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
import type { AddressInfo, Socket } from 'node:net';

import { LOCAL_ENVIRONMENT_ID } from '@mangostudio/shared/environments';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';

import { connectMcpClient } from '../../../../src/services/mcp/runtime-session';
import {
  type McpClientHandle,
  McpConnectionError,
  type McpServerRuntimeConfig,
} from '../../../../src/services/mcp/types';
import { createEchoMcpServer } from '../../../support/fixtures/mcp/create-echo-mcp-server';
import { startSilentMcpHttpEndpoint } from '../../../support/fixtures/mcp/silent-mcp-http-endpoint';

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
  readonly requestsByConnection: string[][];
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
  const requestsByConnection: string[][] = [];
  const connectionRequests = new Map<Socket, string[]>();
  const server = createEchoMcpServer();
  let sse: SSEServerTransport | undefined;
  const httpServer: HttpServer = createServer((request, response) => {
    const label = `${request.method} ${request.url?.split('?')[0]}`;
    requests.push(label);
    let connection = connectionRequests.get(request.socket);
    if (!connection) {
      connection = [];
      connectionRequests.set(request.socket, connection);
      requestsByConnection.push(connection);
    }
    connection.push(label);
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
    requestsByConnection,
    stop: async () => {
      await server.close();
      httpServer.closeAllConnections();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}

describe('mcp http transport', () => {
  it('keeps authenticated Streamable HTTP POSTs separate from the active GET stream', async () => {
    const requests: Array<{ method: string; port: number | undefined; auth: string | null }> = [];
    let streamRequest: Request | undefined;
    let streamResponse: Response | undefined;
    let streamBodyState = 'pending';
    let streamBodySettled: Promise<void> | undefined;
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
      hostname: '127.0.0.1',
      fetch: async (request, host) => {
        requests.push({
          method: request.method,
          port: host.requestIP(request)?.port,
          auth: request.headers.get('authorization'),
        });
        if (request.method === 'GET') streamRequest = request;
        const response = await transport.handleRequest(request);
        if (request.method !== 'GET' || !response.body) return response;
        streamResponse = response;
        streamBodyState = 'open';
        const observedBody = new TransformStream<Uint8Array, Uint8Array>();
        // pipeTo settles on EOF, source error, or downstream cancellation.
        streamBodySettled = response.body.pipeTo(observedBody.writable).then(
          () => {
            streamBodyState = 'ended';
          },
          () => {
            streamBodyState = 'errored or canceled';
          }
        );
        return new Response(observedBody.readable, response);
      },
    });

    let handle: McpClientHandle | undefined;
    try {
      handle = await connectMcpClient(httpConfig(`http://127.0.0.1:${bunServer.port}/`), {
        userId: 'http-transport-user',
        resolveHeaders: () => Promise.resolve({ Authorization: 'Bearer test-token' }),
      });

      const deadline = performance.now() + 5_000;
      while (!streamResponse && performance.now() < deadline) await Bun.sleep(5);
      expect(
        streamResponse,
        'Streamable HTTP session must return its GET stream within 5s'
      ).toBeDefined();
      expect(streamResponse?.status, 'GET stream must return HTTP 200').toBe(200);
      expect(streamResponse?.headers.get('content-type')).toContain('text/event-stream');
      expect(streamBodyState, 'GET response body must remain open before tool POSTs').toBe('open');
      const activeStream = streamRequest;
      expect(activeStream?.signal.aborted, 'GET stream must stay active before tool POSTs').toBe(
        false
      );
      const beforeTools = requests.length;
      const tools = await handle.listTools();
      expect(tools.map((tool) => tool.name)).toEqual(['echo', 'env-keys', 'crash']);
      expect(streamBodyState, 'GET response body must remain open after listTools POST').toBe(
        'open'
      );

      for (const text of ['first over http', 'second over http', 'third over http']) {
        expect((await handle.callTool('echo', { text })).contentText).toBe(text);
        expect(streamBodyState, 'GET response body must remain open during tool POSTs').toBe(
          'open'
        );
        expect(activeStream?.signal.aborted, 'GET stream must stay active during tool POSTs').toBe(
          false
        );
      }
      expect(requests.every((request) => request.auth === 'Bearer test-token')).toBe(true);
      const streamRequests = requests.filter((request) => request.method === 'GET');
      expect(streamRequests).toHaveLength(1);
      const streamPort = streamRequests[0]?.port;
      expect(streamPort, 'GET stream must have a peer connection port').toBeDefined();
      const toolRequests = requests.slice(beforeTools);
      expect(toolRequests).toHaveLength(4);
      expect(toolRequests.every((request) => request.method === 'POST')).toBe(true);
      expect(toolRequests.every((request) => request.port !== undefined)).toBe(true);
      expect(toolRequests.every((request) => request.port !== streamPort)).toBe(true);
    } finally {
      try {
        await handle?.close();
      } finally {
        await server.close().finally(() => bunServer.stop(true));
        await streamBodySettled;
      }
    }
    // Connect (10s), GET wait (5s), four calls (40s), close (5s), plus startup/cleanup.
  }, 75_000);

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

  it('keeps the legacy event stream on a connection separate from message POSTs', async () => {
    const legacy = await startLegacySseServer({ status: 405 });
    let handle: McpClientHandle | undefined;
    try {
      handle = await connectMcpClient(httpConfig(legacy.url), {
        userId: 'http-transport-user',
      });
      expect((await handle.callTool('echo', { text: 'isolated stream' })).contentText).toBe(
        'isolated stream'
      );
      const streamRequests = legacy.requestsByConnection.find((requests) =>
        requests.includes('GET /')
      );
      // A streaming response occupies its HTTP/1 connection until close. It must
      // never enter the pool that serves the initialize and message POSTs.
      expect(streamRequests).toEqual(['GET /']);
      expect(legacy.requests.filter((request) => request === 'POST /messages')).toHaveLength(3);
    } finally {
      await handle?.close();
      await legacy.stop();
    }
  });

  it('reports unresponsive servers as McpConnectionError without falling back', async () => {
    const endpoint = await startSilentMcpHttpEndpoint();
    try {
      const attempt = connectMcpClient(
        { ...httpConfig(endpoint.url), timeoutMs: 250 },
        {
          userId: 'http-transport-user',
        }
      );

      await expect(attempt).rejects.toBeInstanceOf(McpConnectionError);
      expect(endpoint.requests).toEqual(['POST /']);
    } finally {
      await endpoint.stop();
    }
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
