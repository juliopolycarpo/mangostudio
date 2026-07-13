import { afterEach, describe, expect, it } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { KyselyPlugin } from 'kysely';
import { getDb } from '../../../../src/db/database';
import { executeStandardToolCallsWithProgress } from '../../../../src/modules/generation/application/standard-tool-execution';
import { wrapMcpClient } from '../../../../src/services/mcp/client-factory';
import {
  closeAllMcpClients,
  setMcpClientConnectorForTest,
} from '../../../../src/services/mcp/connection-manager';
import {
  bindElicitationSink,
  type McpElicitationResult,
  releaseElicitationSink,
  resetElicitationRegistryForTest,
  respondElicitation,
} from '../../../../src/services/mcp/elicitation-registry';
import type { McpClientHandle } from '../../../../src/services/mcp/types';
import { makeFakeMcpHandle } from '../../../support/fixtures/mcp/fake-handle';

const clients: Client[] = [];
const servers: Server[] = [];

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function createToolServer(
  onCall: (server: Server, name: string, args: Record<string, unknown>) => Promise<string> | string
): Server {
  const server = new Server(
    { name: 'serialization-fixture', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [] }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => ({
    content: [
      {
        type: 'text',
        text: await onCall(
          server,
          request.params.name,
          (request.params.arguments ?? {}) as Record<string, unknown>
        ),
      },
    ],
  }));
  return server;
}

async function connectHandle(serverId: string, server: Server): Promise<McpClientHandle> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client(
    { name: 'serialization-client', version: '1.0.0' },
    { capabilities: { elicitation: { form: {} } } }
  );
  await client.connect(clientTransport);
  clients.push(client);
  servers.push(server);
  return wrapMcpClient(
    client,
    { timeoutMs: null },
    {
      userId: 'serialization-user',
      serverId,
      serverSlug: serverId,
    }
  );
}

afterEach(async () => {
  resetElicitationRegistryForTest();
  setMcpClientConnectorForTest(null);
  await closeAllMcpClients();
  await Promise.allSettled(clients.splice(0).map((client) => client.close()));
  await Promise.allSettled(servers.splice(0).map((server) => server.close()));
});

describe('MCP call serialization', () => {
  it('cancels an elicitation when the SDK request has no tool-call correlation id', async () => {
    const server = createToolServer(async (activeServer) => {
      const response = await activeServer.elicitInput({
        mode: 'form',
        message: 'Uncorrelated input',
        requestedSchema: { type: 'object', properties: {} },
      });
      return response.action;
    });
    const handle = await connectHandle('uncorrelated-server', server);

    await expect(handle.callTool('needs-input', {})).resolves.toMatchObject({
      contentText: 'cancel',
      isError: false,
    });
  });

  it('correlates elicitation while serializing one server and keeping another parallel', async () => {
    const sameServerEvents: string[] = [];
    const otherServerEvents: string[] = [];
    const otherStarted = deferred<void>();
    const primaryServer = createToolServer(async (server, name) => {
      sameServerEvents.push(`${name}:started`);
      if (name === 'needs-input') {
        const response = await server.elicitInput({
          mode: 'form',
          message: 'Choose a value',
          requestedSchema: {
            type: 'object',
            properties: { value: { type: 'string' } },
            required: ['value'],
          },
        });
        sameServerEvents.push(`${name}:${response.action}`);
      }
      return name;
    });
    const otherServer = createToolServer((_server, name) => {
      otherServerEvents.push(`${name}:started`);
      otherStarted.resolve();
      return name;
    });
    const primary = await connectHandle('primary-server', primaryServer);
    const other = await connectHandle('other-server', otherServer);

    const elicitationObserved = deferred<void>();
    let elicitationId = '';
    let elicitationCallId = '';
    let responseSignal: Promise<McpElicitationResult> | undefined;
    bindElicitationSink(
      'serialization-user',
      'primary-server',
      'call-a',
      (part, waitForResponse) => {
        elicitationId = part.elicitationId;
        elicitationCallId = part.toolCallId;
        responseSignal = waitForResponse;
        elicitationObserved.resolve();
      }
    );

    const first = primary.callTool('needs-input', {}, { toolCallId: 'call-a' });
    await elicitationObserved.promise;

    const second = primary.callTool('queued', {}, { toolCallId: 'call-b' });
    const abortController = new AbortController();
    const aborted = primary.callTool(
      'aborted',
      {},
      {
        toolCallId: 'call-c',
        signal: abortController.signal,
      }
    );
    const abortedOutcome = aborted.then(
      () => undefined,
      (error: unknown) => error
    );
    const crossServer = other.callTool('parallel', {}, { toolCallId: 'call-d' });
    abortController.abort();
    await otherStarted.promise;

    expect(elicitationCallId).toBe('call-a');
    expect(sameServerEvents).toEqual(['needs-input:started']);
    expect(otherServerEvents).toEqual(['parallel:started']);
    expect(await abortedOutcome).toBeInstanceOf(DOMException);

    expect(
      respondElicitation('serialization-user', elicitationId, {
        action: 'accept',
        content: { value: 'chosen' },
      })
    ).toBe('accepted');
    await expect(responseSignal).resolves.toEqual({
      action: 'accept',
      content: { value: 'chosen' },
    });

    await expect(first).resolves.toMatchObject({ contentText: 'needs-input', isError: false });
    await expect(second).resolves.toMatchObject({ contentText: 'queued', isError: false });
    await expect(crossServer).resolves.toMatchObject({ contentText: 'parallel', isError: false });
    expect(sameServerEvents).toEqual([
      'needs-input:started',
      'needs-input:accept',
      'queued:started',
    ]);
    releaseElicitationSink('serialization-user', 'primary-server', 'call-a');
  });

  it('keeps repeated concurrent calls FIFO with one active SDK request', async () => {
    let activeCalls = 0;
    let maxActiveCalls = 0;
    const starts: number[] = [];
    const server = createToolServer(async (_server, _name, args) => {
      const index = Number(args.index);
      starts.push(index);
      activeCalls += 1;
      maxActiveCalls = Math.max(maxActiveCalls, activeCalls);
      await Promise.resolve();
      activeCalls -= 1;
      return String(index);
    });
    const handle = await connectHandle('stress-server', server);

    const results = await Promise.all(
      Array.from({ length: 25 }, (_, index) =>
        handle.callTool('work', { index }, { toolCallId: `stress-${index}` })
      )
    );

    expect(starts).toEqual(Array.from({ length: 25 }, (_, index) => index));
    expect(maxActiveCalls).toBe(1);
    expect(results.map((result) => result.contentText)).toEqual(
      Array.from({ length: 25 }, (_, index) => String(index))
    );
  });

  it('looks up the owned server row once per generation invocation', async () => {
    const userId = `query-count-user-${crypto.randomUUID()}`;
    const serverId = `query-count-server-${crypto.randomUUID()}`;
    const now = Date.now();
    await getDb()
      .insertInto('mcp_servers')
      .values({
        id: serverId,
        userId,
        name: 'Query Count Server',
        slug: 'query-count',
        transport: 'stdio',
        command: 'bun',
        argsJson: '[]',
        envJson: '{}',
        url: null,
        enabled: 1,
        timeoutMs: null,
        createdAt: now,
        updatedAt: now,
      })
      .execute();
    setMcpClientConnectorForTest(() =>
      Promise.resolve(
        makeFakeMcpHandle({
          callTool: () =>
            Promise.resolve({
              contentText: 'ok',
              isError: false,
              rawContentKinds: ['text'],
              content: [{ type: 'text', text: 'ok' }],
            }),
        })
      )
    );

    let queryCount = 0;
    const countedDb = getDb().withPlugin({
      transformQuery({ node }) {
        queryCount += 1;
        return node;
      },
      transformResult({ result }) {
        return Promise.resolve(result);
      },
    } satisfies KyselyPlugin);

    const items = [];
    for await (const item of executeStandardToolCallsWithProgress(
      [['query-call', { name: 'mcp__query-count__run', argsStr: '{}' }]],
      {
        userId,
        chatId: 'query-count-chat',
        settingsByToolName: new Map(),
        allowedToolNames: new Set(['mcp__query-count__run']),
        db: countedDb,
      }
    )) {
      items.push(item);
    }

    expect(queryCount).toBe(1);
    expect(items).toContainEqual(
      expect.objectContaining({
        kind: 'execution',
        execution: expect.objectContaining({ result: 'ok', isError: false }),
      })
    );
  });
});
