/**
 * Session-registry behaviour that only exists runtime-side: which server a
 * request addresses, what happens to a question nobody answers, and what the
 * host tears down when it goes away.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { RuntimeEventInput, RuntimeMcpServerConfig } from '../../../../src/index';
import {
  createMcpService,
  McpServiceError,
  setMcpTransportFactoryForTest,
} from '../../../../src/services/mcp/service';

const CONFIG: RuntimeMcpServerConfig = {
  id: 'server-1',
  slug: 'fixture',
  transport: 'stdio',
  command: 'fixture',
  args: [],
  env: {},
  url: null,
  timeoutMs: null,
};

const openServers: Server[] = [];

function createFixtureServer(onCall?: (server: Server) => Promise<void>): Server {
  const server = new Server({ name: 'fixture', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [{ name: 'ask', description: 'Asks a question.', inputSchema: { type: 'object' } }],
  }));
  server.setRequestHandler(CallToolRequestSchema, async () => {
    await onCall?.(server);
    return { content: [{ type: 'text', text: 'done' }] };
  });
  openServers.push(server);
  return server;
}

function installFixture(create: () => Server): void {
  setMcpTransportFactoryForTest(async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await create().connect(serverTransport);
    return clientTransport;
  });
}

function createService(events: RuntimeEventInput[]) {
  return createMcpService({
    runtimeVersion: 'service-test',
    emit: (event) => events.push(event),
  });
}

afterEach(async () => {
  setMcpTransportFactoryForTest(null);
  await Promise.allSettled(openServers.splice(0).map((server) => server.close()));
});

describe('runtime MCP service', () => {
  it('refuses a request for a server it never connected', async () => {
    const service = createService([]);

    const attempt = service.listTools({ serverId: 'never-connected' });

    await expect(attempt).rejects.toBeInstanceOf(McpServiceError);
    await expect(attempt).rejects.toMatchObject({ kind: 'mcp_session_missing' });
  });

  it('publishes an elicitation event carrying the hub-minted tool call id', async () => {
    const events: RuntimeEventInput[] = [];
    const service = createService(events);
    installFixture(() =>
      createFixtureServer(async (server) => {
        await server.elicitInput({
          mode: 'form',
          message: 'Pick one',
          requestedSchema: { type: 'object', properties: { tier: { type: 'string' } } },
        });
      })
    );
    await service.connect({ config: CONFIG });

    const call = service.callTool(
      { serverId: CONFIG.id, toolName: 'ask', args: {}, toolCallId: 'call-a' },
      { signal: new AbortController().signal }
    );
    const elicitation = await waitForEvent(events, 'mcp.elicitation');

    expect(elicitation).toMatchObject({
      serverId: CONFIG.id,
      serverSlug: CONFIG.slug,
      toolCallId: 'call-a',
      message: 'Pick one',
    });

    await service.respondToElicitation({
      requestId: (elicitation as { requestId: string }).requestId,
      action: 'decline',
    });
    await expect(call).resolves.toMatchObject({ contentText: 'done' });
    await service.close();
  });

  it('strands nothing when the host tears the service down mid-question', async () => {
    const events: RuntimeEventInput[] = [];
    const service = createService(events);
    let elicited: Promise<unknown> | undefined;
    installFixture(() =>
      createFixtureServer((server) => {
        elicited = server.elicitInput({
          mode: 'form',
          message: 'Never answered',
          requestedSchema: { type: 'object', properties: {} },
        });
        // Park so the call is still in flight while the service closes.
        return new Promise<void>(() => undefined);
      })
    );
    await service.connect({ config: CONFIG });

    const call = service.callTool(
      { serverId: CONFIG.id, toolName: 'ask', args: {}, toolCallId: 'call-b' },
      { signal: new AbortController().signal }
    );
    await waitForEvent(events, 'mcp.elicitation');

    await service.close();

    // Both sides settle rather than waiting on an answer that can no longer
    // arrive; whether that reads as a cancel or a closed connection depends on
    // which side observes the teardown first, and neither may hang.
    expect(await settles(call)).toBe(true);
    expect(await settles(elicited)).toBe(true);
    // The session is gone with it, so the next request says so.
    await expect(service.listTools({ serverId: CONFIG.id })).rejects.toMatchObject({
      kind: 'mcp_session_missing',
    });
  });

  it('treats a late answer to a forgotten question as a no-op, not a failure', async () => {
    const service = createService([]);

    await expect(
      service.respondToElicitation({ requestId: 'gone', action: 'accept', content: {} })
    ).resolves.toEqual({ ok: true });
  });

  it('serializes concurrent connects so only one session remains', async () => {
    const events: RuntimeEventInput[] = [];
    const service = createService(events);
    let connects = 0;
    installFixture(() => {
      connects += 1;
      return createFixtureServer();
    });

    const [first, second] = await Promise.all([
      service.connect({ config: CONFIG }),
      service.connect({ config: CONFIG }),
    ]);

    expect(first.capabilities.tools).toBe(true);
    expect(second.capabilities.tools).toBe(true);
    expect(connects).toBe(2);
    await expect(service.listTools({ serverId: CONFIG.id })).resolves.toMatchObject({
      tools: [{ name: 'ask' }],
    });
    // Two sequential connects both closed their predecessor; only the last
    // session is live — no leaked registry entry.
    expect(events.filter((event) => event.topic === 'mcp.session')).toEqual([]);
    await service.close();
  });

  it('ignores a closed notification from a session that was already replaced', async () => {
    const events: RuntimeEventInput[] = [];
    const service = createService(events);
    const closedServers: Server[] = [];
    installFixture(() => {
      const server = createFixtureServer();
      closedServers.push(server);
      return server;
    });

    await service.connect({ config: CONFIG });
    const firstServer = closedServers[0];
    await service.connect({ config: CONFIG });

    // Tear down the superseded SDK server; its onclose must not drop the
    // replacement still registered under the same server id.
    await firstServer?.close();
    await Bun.sleep(20);

    expect(events.filter((event) => event.topic === 'mcp.session')).toEqual([]);
    await expect(service.listTools({ serverId: CONFIG.id })).resolves.toMatchObject({
      tools: [{ name: 'ask' }],
    });
    await service.close();
  });

  it('abandons connect when the cancel signal aborts before registration', async () => {
    const service = createService([]);
    const controller = new AbortController();
    installFixture(() => {
      controller.abort();
      return createFixtureServer();
    });

    await expect(
      service.connect({ config: CONFIG }, { signal: controller.signal })
    ).rejects.toMatchObject({ name: 'AbortError' });
    await expect(service.listTools({ serverId: CONFIG.id })).rejects.toMatchObject({
      kind: 'mcp_session_missing',
    });
    await service.close();
  });

  it('answers a queued call from the session that is live when it runs', async () => {
    const service = createService([]);
    let releaseFirst: (() => void) | undefined;
    const firstCallStarted = Promise.withResolvers<void>();
    installFixture(() =>
      createFixtureServer(async () => {
        firstCallStarted.resolve();
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      })
    );

    await service.connect({ config: CONFIG });
    const held = service.callTool(
      { serverId: CONFIG.id, toolName: 'ask', args: {} },
      idleContext()
    );
    await firstCallStarted.promise;
    // Queued behind the call above, so it resolves its session after the
    // disconnect below has already closed the one it was enqueued under.
    const queued = service.callTool(
      { serverId: CONFIG.id, toolName: 'ask', args: {} },
      idleContext()
    );

    await service.disconnect({ serverId: CONFIG.id });
    releaseFirst?.();
    // The in-flight head goes down with the session it was already running on.
    await expect(held).rejects.toMatchObject({ kind: 'mcp_call' });

    // The queued one never started, so it is answered by the registry rather
    // than by a closed handle — which would have surfaced as a transport error.
    await expect(queued).rejects.toMatchObject({ kind: 'mcp_session_missing' });
    await service.close();
  });

  it('lets an aborted caller go while the call ahead of it is still running', async () => {
    const service = createService([]);
    let releaseFirst: (() => void) | undefined;
    const firstCallStarted = Promise.withResolvers<void>();
    let calls = 0;
    installFixture(() =>
      createFixtureServer(async () => {
        calls += 1;
        if (calls > 1) return;
        firstCallStarted.resolve();
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      })
    );

    await service.connect({ config: CONFIG });
    const held = service.callTool(
      { serverId: CONFIG.id, toolName: 'ask', args: {} },
      idleContext()
    );
    await firstCallStarted.promise;

    const controller = new AbortController();
    const queued = service.callTool(
      { serverId: CONFIG.id, toolName: 'ask', args: {} },
      { signal: controller.signal }
    );
    controller.abort();

    // The abort is answered while the head is still blocked — waiting for the
    // head would make every cancellation cost as long as the call ahead of it.
    await expect(queued).rejects.toMatchObject({ name: 'AbortError' });
    expect(await settles(held)).toBe(false);

    releaseFirst?.();
    await held;
    // The abandoned call never reached the server, and the chain still moved.
    expect(calls).toBe(1);
    await expect(
      service.callTool({ serverId: CONFIG.id, toolName: 'ask', args: {} }, idleContext())
    ).resolves.toMatchObject({ content: [{ type: 'text', text: 'done' }] });
    await service.close();
  });
});

/** A handler context whose caller never cancels. */
function idleContext(): { signal: AbortSignal } {
  return { signal: new AbortController().signal };
}

/** Whether a promise reaches any terminal state inside a generous budget. */
async function settles(promise: Promise<unknown> | undefined): Promise<boolean> {
  if (!promise) throw new Error('Nothing was awaiting an answer.');
  const pending = Symbol('pending');
  const outcome = await Promise.race([
    promise.then(
      () => 'settled',
      () => 'settled'
    ),
    Bun.sleep(2_000).then(() => pending),
  ]);
  return outcome === 'settled';
}

async function waitForEvent(events: RuntimeEventInput[], topic: string): Promise<unknown> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const found = events.find((event) => event.topic === topic);
    if (found) return found.payload;
    await Bun.sleep(5);
  }
  throw new Error(`No "${topic}" event was published.`);
}
