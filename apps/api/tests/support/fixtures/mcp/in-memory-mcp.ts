/**
 * In-memory MCP fixture for turn-level end-to-end tests: a real SDK server
 * (text, rich content, elicitation, delay, disconnect, and failure tools) linked to the client over
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
const OVERSIZED_TOOL_OUTPUT_LENGTH = 100_000;

/** Payloads returned by the `picture` tool (rich-content mapping coverage). */
const PICTURE_TOOL_IMAGE_BASE64 = Buffer.from('fixture-png-bytes').toString('base64');
const PICTURE_TOOL_PDF_BASE64 = Buffer.from('fixture-pdf-bytes').toString('base64');
export const PICTURE_TOOL_NOTES_TEXT = 'chart notes';
export const PICTURE_TOOL_RESOURCE_TEXT = 'resource notes';

interface TurnMcpFixtureControls {
  /** Resolves when the named tool reaches its request handler. */
  waitForCall(name: string, occurrence?: number): Promise<void>;
  /** Releases every delayed call using the matching key. */
  release(key: string): void;
  /** Request-handler start order, useful for FIFO assertions. */
  readonly callStarts: readonly string[];
}

interface MutableTurnMcpFixtureControls extends TurnMcpFixtureControls {
  markCallStarted(name: string): void;
  waitForRelease(key: string): Promise<void>;
}

function createTurnMcpFixtureControls(): MutableTurnMcpFixtureControls {
  const starts: string[] = [];
  const startWaiters = new Set<() => void>();
  const releases = new Map<string, Set<() => void>>();

  return {
    get callStarts() {
      return starts;
    },
    markCallStarted(name) {
      starts.push(name);
      for (const notify of startWaiters) notify();
    },
    async waitForCall(name, occurrence = 1) {
      const count = () => starts.filter((started) => started === name).length;
      while (count() < occurrence) {
        await new Promise<void>((resolve) => {
          const notify = () => {
            if (count() < occurrence) return;
            startWaiters.delete(notify);
            resolve();
          };
          startWaiters.add(notify);
        });
      }
    },
    waitForRelease(key) {
      return new Promise<void>((resolve) => {
        const waiters = releases.get(key) ?? new Set<() => void>();
        waiters.add(resolve);
        releases.set(key, waiters);
      });
    },
    release(key) {
      const waiters = releases.get(key);
      releases.delete(key);
      for (const resolve of waiters ?? []) resolve();
    },
  };
}

export interface ControlledTurnMcpFixture {
  connector: typeof connectMcpClient;
  controls: TurnMcpFixtureControls;
  close(): Promise<void>;
  assertNoOpenServers(): void;
}

/** Builds the turn-fixture MCP server with one tool per failure mode. */
function createTurnMcpServer(
  controls: MutableTurnMcpFixtureControls = createTurnMcpFixtureControls()
): Server {
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
      {
        name: 'picture',
        description: 'Returns every supported rich block plus a text resource.',
        inputSchema: { type: 'object' as const, properties: {} },
      },
      {
        name: 'unusual-content',
        description: 'Returns unsupported and malformed blocks without failing the call.',
        inputSchema: { type: 'object' as const, properties: {} },
      },
      {
        name: 'delayed',
        description: 'Waits on an explicit fixture release barrier.',
        inputSchema: {
          type: 'object' as const,
          properties: { key: { type: 'string' } },
          required: ['key'],
        },
      },
      {
        name: 'elicit',
        description: 'Requests deterministic form input from the client.',
        inputSchema: { type: 'object' as const, properties: {} },
      },
      {
        name: 'fail-after-elicit',
        description: 'Fails while a form elicitation remains pending.',
        inputSchema: { type: 'object' as const, properties: {} },
      },
      {
        name: 'error-after-elicit',
        description: 'Returns isError while a form elicitation remains pending.',
        inputSchema: { type: 'object' as const, properties: {} },
      },
      {
        name: 'disconnect',
        description: 'Drops the MCP session during a tool request.',
        inputSchema: { type: 'object' as const, properties: {} },
      },
    ],
  }));

  /**
   * Raises a form elicitation the test never answers, then parks until the
   * test releases the call — so the tool terminates with the request still
   * pending and the server-side cancel reason is what gets asserted.
   */
  async function elicitThenWaitForRelease(message: string, releaseKey: string): Promise<void> {
    void server
      .elicitInput({
        mode: 'form',
        message,
        requestedSchema: {
          type: 'object',
          properties: {
            approved: { type: 'boolean', title: 'Approved' },
          },
        },
      })
      .catch(() => undefined);
    await controls.waitForRelease(releaseKey);
  }

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name } = request.params;
    controls.markCallStarted(name);
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
    if (name === 'picture') {
      return {
        content: [
          { type: 'text', text: PICTURE_TOOL_NOTES_TEXT },
          { type: 'image', data: PICTURE_TOOL_IMAGE_BASE64, mimeType: 'image/png' },
          { type: 'audio', data: 'Zml4dHVyZS1hdWRpbw==', mimeType: 'audio/wav' },
          {
            type: 'resource',
            resource: {
              uri: 'file:///notes.txt',
              mimeType: 'text/plain',
              text: PICTURE_TOOL_RESOURCE_TEXT,
            },
          },
          {
            type: 'resource_link',
            uri: 'file:///linked.txt',
            name: 'linked.txt',
            mimeType: 'text/plain',
          },
          {
            type: 'resource',
            resource: {
              uri: 'file:///report.pdf',
              mimeType: 'application/pdf',
              blob: PICTURE_TOOL_PDF_BASE64,
            },
          },
        ],
      };
    }
    if (name === 'unusual-content') {
      return {
        // Exercise the SDK boundary with server output outside the currently
        // understood union. The client wrapper must normalize, not trust, it.
        content: [
          { type: 'video', mimeType: 'video/mp4', data: 'ignored' },
          { type: 'text', text: 42 },
          { type: 'image', data: '', mimeType: 'image/png' },
          {
            type: 'resource',
            resource: {
              uri: 'file:///ignored.exe',
              mimeType: 'application/octet-stream',
              blob: 'aWdub3JlZA==',
            },
          },
        ],
      } as never;
    }
    if (name === 'delayed') {
      const key = request.params.arguments?.key;
      await controls.waitForRelease(typeof key === 'string' ? key : 'default');
      return { content: [{ type: 'text', text: `released:${String(key)}` }] };
    }
    if (name === 'elicit') {
      const response = await server.elicitInput({
        mode: 'form',
        message: 'Choose a deployment tier',
        requestedSchema: {
          type: 'object',
          properties: {
            tier: { type: 'string', title: 'Tier', enum: ['preview', 'production'] },
          },
          required: ['tier'],
        },
      });
      return { content: [{ type: 'text', text: JSON.stringify(response) }] };
    }
    if (name === 'fail-after-elicit') {
      await elicitThenWaitForRelease('Approve the failing operation', name);
      throw new Error('fixture tool failed after eliciting input');
    }
    if (name === 'error-after-elicit') {
      await elicitThenWaitForRelease('Approve the erroring operation', name);
      return {
        content: [{ type: 'text', text: 'tool reported failure' }],
        isError: true,
      };
    }
    if (name === 'disconnect') {
      queueMicrotask(() => void server.close());
      await new Promise(() => undefined);
    }
    return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
  });

  return server;
}

/**
 * Creates a controlled SDK fixture with explicit synchronization and teardown.
 * Tests must call `close()` and can then assert that every server was released.
 */
export function createControlledTurnMcpFixture(): ControlledTurnMcpFixture {
  const controls = createTurnMcpFixtureControls();
  const servers = new Set<Server>();
  const connector: typeof connectMcpClient = async (config, options) => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createTurnMcpServer(controls);
    servers.add(server);
    server.onclose = () => servers.delete(server);
    await server.connect(serverTransport);
    const client = new Client(
      { name: 'turn-fixture-client', version: '0.0.0' },
      { capabilities: { elicitation: { form: {} } } }
    );
    await client.connect(clientTransport);
    return wrapMcpClient(client, config, {
      userId: options.userId,
      serverId: config.id,
      serverSlug: config.slug,
      onSessionClosed: options.onSessionClosed,
      onToolListChanged: options.onToolListChanged,
    });
  };

  return {
    connector,
    controls,
    async close() {
      await Promise.allSettled([...servers].map((server) => server.close()));
    },
    assertNoOpenServers() {
      if (servers.size > 0) {
        throw new Error(`MCP fixture leaked ${servers.size} in-memory server(s).`);
      }
    },
  };
}

/**
 * Returns a connection-manager connector that links a fresh in-memory server
 * to each client, so a reconnect after a dropped session gets a live server.
 * // Usage: setMcpClientConnectorForTest(inMemoryMcpConnector())
 */
export function inMemoryMcpConnector(
  createServer: () => Server = createTurnMcpServer
): typeof connectMcpClient {
  return async (config, options): Promise<McpClientHandle> => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createServer();
    await server.connect(serverTransport);
    const client = new Client(
      { name: 'turn-fixture-client', version: '0.0.0' },
      { capabilities: { elicitation: { form: {} } } }
    );
    await client.connect(clientTransport);
    return wrapMcpClient(client, config, {
      userId: options.userId,
      serverId: config.id,
      serverSlug: config.slug,
      onSessionClosed: options.onSessionClosed,
      onToolListChanged: options.onToolListChanged,
    });
  };
}
