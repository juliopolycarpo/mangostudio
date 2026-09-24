/**
 * Real Rust `mangostudio-runtime` MCP qualification: the Hub's own runtime client and MCP session
 * code drive the compiled binary, which hosts servers built on the official TypeScript MCP SDK.
 *
 * | TypeScript host behaviour (apps/runtime/src/services/mcp) | Covered here |
 * | --- | --- |
 * | nine `mcp.*` methods, capability truth in the manifest | "hosts every MCP method over stdio" |
 * | stdio env allowlist + secret env delivery (`stdio-env.ts`) | same test, `env-keys` tool |
 * | 64 KiB result cap and marker (`content-mapping.ts`) | same test, `big` tool |
 * | elicitation relay with the hub-minted tool call id | same test, `elicit` tool |
 * | `tool-list-changed` and `closed` session events | same test, `notify` and `crash` tools |
 * | consent revocation closes sessions (runtime-side) | "revoking mcp consent closes sessions" |
 * | streamable HTTP with header secrets, legacy SSE fallback | "direct URL" block |
 * | hub-side secret transport guard (`secret-transport-guard.ts`) | "refuses plaintext" test |
 */

import { afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { fileURLToPath } from 'node:url';
import type { EventFrame } from '@mangostudio/protocol';
import { rejectionOf } from '@mangostudio/protocol/testing';
import { MCP_RESULT_TRUNCATION_MARKER } from '@mangostudio/shared/mcp/content-mapping';
import { getDb } from '../../../src/db/database';
import { resolveRuntimeLaunchCommand } from '../../../src/lib/runtime-paths';
import { createEnvironmentService } from '../../../src/modules/environments/application/environment-service';
import { createEnvironmentRepository } from '../../../src/modules/environments/infrastructure/environment-repository';
import { connectMcpClient } from '../../../src/services/mcp/runtime-session';
import { McpSecretTransportError } from '../../../src/services/mcp/secret-transport-guard';
import { connectHttpRuntime } from '../../../src/services/runtime-client/connect-http-runtime';
import { RuntimeClient } from '../../../src/services/runtime-client/runtime-client';
import {
  RuntimeConnectionManager,
  setRuntimeConnectionManagerForTests,
} from '../../../src/services/runtime-client/runtime-connection-manager';
import { setRuntimeTokenStoreForTests } from '../../../src/services/runtime-client/runtime-token-secrets';
import { spawnRuntimeChild } from '../../../src/services/runtime-client/spawn-runtime-child';
import { insertTestUser } from '../../support/factories';
import { startQualificationHttpServer } from '../../support/fixtures/mcp/qualification-mcp-server';
import { InMemorySecretStore } from '../../support/mocks/mock-secret-store';
import {
  cleanupMangoHome,
  resolveRustRuntimeBinary,
  rustRuntimeVersion,
  scratchMangoHome,
} from '../../support/rust-runtime-binary';

const binary = resolveRustRuntimeBinary();
const FIXTURE = fileURLToPath(
  new URL('../../support/fixtures/mcp/qualification-mcp-server.ts', import.meta.url)
);

function stdioConfig(id: string) {
  return {
    id,
    slug: id,
    transport: 'stdio' as const,
    command: process.execPath,
    args: [FIXTURE],
    env: { MCP_QUALIFICATION_ROW: 'row' },
    url: null,
    timeoutMs: 15_000,
  };
}

/** Collects runtime events so a test can wait for one without racing its arrival. */
function recordEvents(client: RuntimeClient) {
  const events: EventFrame[] = [];
  const stop = client.onEvent((event) => events.push(event));
  const waitFor = async (topic: string, match: (payload: Record<string, unknown>) => boolean) => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const found = events.find(
        (event) => event.topic === topic && match(event.payload as Record<string, unknown>)
      );
      if (found) return found.payload as Record<string, unknown>;
      await Bun.sleep(10);
    }
    throw new Error(
      `expected a ${topic} event | received ${JSON.stringify(events.map((e) => e.topic))}`
    );
  };
  return { events, stop, waitFor };
}

describe('Real Rust runtime MCP qualification', () => {
  let runtimeVersion: string;

  beforeAll(async () => {
    if (!binary.available) return;
    runtimeVersion = await rustRuntimeVersion(binary.path);
  });

  describe('stdio', () => {
    let mangoHome: string | undefined;
    let previousMangoHome: string | undefined;

    afterEach(async () => {
      if (previousMangoHome === undefined) delete process.env.MANGO_HOME;
      else process.env.MANGO_HOME = previousMangoHome;
      if (mangoHome) await cleanupMangoHome(mangoHome);
      mangoHome = undefined;
    });

    async function spawnRuntime(name: string) {
      mangoHome = await scratchMangoHome(name);
      previousMangoHome = process.env.MANGO_HOME;
      process.env.MANGO_HOME = mangoHome;
      const connection = await spawnRuntimeChild({
        environmentId: name,
        launch: resolveRuntimeLaunchCommand(undefined, { MANGOSTUDIO_RUNTIME_BINARY: binary.path }),
        workspaceBinding: null,
        hubVersion: runtimeVersion,
        onClosed: () => undefined,
      });
      return { connection, client: new RuntimeClient(connection.hub, () => undefined, name) };
    }

    it.skipIf(!binary.available)(
      'hosts every MCP method over stdio against a TypeScript SDK server',
      async () => {
        const { connection, client } = await spawnRuntime('rust-mcp-stdio');
        const recorder = recordEvents(client);
        try {
          expect(client.manifest.features.mcp).toBe(true);
          const connected = await client.mcp.connect({
            config: stdioConfig('qual-stdio'),
            secrets: { env: { MCP_QUALIFICATION_SECRET: 'secret-value' } },
          });
          expect(connected).toEqual({
            capabilities: { tools: true, resources: true, prompts: true },
          });

          const { tools } = await client.mcp.listTools({ serverId: 'qual-stdio' });
          expect(tools.map((tool) => tool.name)).toEqual([
            'echo',
            'env-keys',
            'big',
            'elicit',
            'notify',
            'crash',
          ]);

          const echo = await client.mcp.callTool({
            serverId: 'qual-stdio',
            toolName: 'echo',
            args: { text: 'through the rust runtime' },
          });
          expect(echo).toEqual({
            contentText: 'through the rust runtime',
            isError: false,
            rawContentKinds: ['text'],
            content: [{ type: 'text', text: 'through the rust runtime' }],
          });

          const envKeys = JSON.parse(
            (await client.mcp.callTool({ serverId: 'qual-stdio', toolName: 'env-keys', args: {} }))
              .contentText
          ) as string[];
          expect(envKeys).toContain('MCP_QUALIFICATION_ROW');
          expect(envKeys).toContain('MCP_QUALIFICATION_SECRET');
          // The runtime's own configuration never leaks into a server's environment.
          expect(envKeys).not.toContain('MANGO_HOME');

          const big = await client.mcp.callTool({
            serverId: 'qual-stdio',
            toolName: 'big',
            args: {},
          });
          expect(big.contentText.endsWith(MCP_RESULT_TRUNCATION_MARKER)).toBe(true);
          expect(Buffer.byteLength(big.contentText, 'utf8')).toBeLessThan(70 * 1024);

          expect(await client.mcp.listResources({ serverId: 'qual-stdio' })).toEqual({
            resources: [{ uri: 'qualification://notes', name: 'Notes', mimeType: 'text/plain' }],
          });
          expect(
            await client.mcp.readResource({ serverId: 'qual-stdio', uri: 'qualification://notes' })
          ).toEqual({
            contents: [
              { uri: 'qualification://notes', mimeType: 'text/plain', text: 'qualification notes' },
            ],
          });
          expect(await client.mcp.listPrompts({ serverId: 'qual-stdio' })).toEqual({
            prompts: [
              {
                name: 'greet',
                description: 'Greets someone.',
                arguments: [{ name: 'who', required: true }],
              },
            ],
          });
          expect(
            await client.mcp.getPrompt({
              serverId: 'qual-stdio',
              promptName: 'greet',
              args: { who: 'Ada' },
            })
          ).toEqual({ messages: [{ role: 'user', text: 'Hello Ada' }] });

          const asking = client.mcp.callTool({
            serverId: 'qual-stdio',
            toolName: 'elicit',
            args: {},
            toolCallId: 'qual-call-1',
          });
          const question = await recorder.waitFor('mcp.elicitation', () => true);
          expect(question).toMatchObject({
            serverId: 'qual-stdio',
            serverSlug: 'qual-stdio',
            toolCallId: 'qual-call-1',
            message: 'Who is asking?',
          });
          // The server's field order, not the SDK's sorted map order.
          expect((question.fields as { name: string }[]).map((field) => field.name)).toEqual([
            'name',
            'email',
            'age',
          ]);
          expect(
            await client.mcp.respondToElicitation({
              requestId: question.requestId as string,
              action: 'accept',
              content: { name: 'Ada' },
            })
          ).toEqual({ ok: true });
          expect(JSON.parse((await asking).contentText)).toEqual({
            action: 'accept',
            content: { name: 'Ada' },
          });
          // A late answer to a question already settled is a no-op, not a failure.
          expect(
            await client.mcp.respondToElicitation({
              requestId: question.requestId as string,
              action: 'decline',
            })
          ).toEqual({ ok: true });

          await client.mcp.callTool({ serverId: 'qual-stdio', toolName: 'notify', args: {} });
          await recorder.waitFor(
            'mcp.session',
            (payload) => payload.serverId === 'qual-stdio' && payload.change === 'tool-list-changed'
          );

          const crashed = await rejectionOf(
            client.mcp.callTool({ serverId: 'qual-stdio', toolName: 'crash', args: {} })
          );
          expect((crashed as { details?: Record<string, unknown> }).details).toMatchObject({
            kind: 'mcp_call',
            mcpFailure: 'server_closed',
          });
          await recorder.waitFor(
            'mcp.session',
            (payload) => payload.serverId === 'qual-stdio' && payload.change === 'closed'
          );
          const missing = await rejectionOf(client.mcp.listTools({ serverId: 'qual-stdio' }));
          expect((missing as { details?: Record<string, unknown> }).details).toMatchObject({
            kind: 'mcp_session_missing',
            serverId: 'qual-stdio',
          });
          expect(await client.mcp.disconnect({ serverId: 'qual-stdio' })).toEqual({ ok: true });
        } finally {
          recorder.stop();
          await connection.close();
        }
      },
      60_000
    );

    it.skipIf(!binary.available)(
      'revoking mcp consent closes live sessions and the refreshed manifest withdraws mcp',
      async () => {
        const { connection, client } = await spawnRuntime('rust-mcp-revoke');
        const recorder = recordEvents(client);
        try {
          await client.mcp.connect({ config: stdioConfig('qual-revoke') });
          const setup = Bun.spawn({
            cmd: [binary.path, 'setup', '--slot', 'host', '--profile', 'none'],
            env: { ...process.env, MANGO_HOME: mangoHome },
            stdout: 'pipe',
            stderr: 'pipe',
          });
          expect(await setup.exited).toBe(0);
          await recorder.waitFor(
            'mcp.session',
            (payload) => payload.serverId === 'qual-revoke' && payload.change === 'closed'
          );
          expect((await client.health()).allow.mcp).toBe(false);
        } finally {
          recorder.stop();
          await connection.close();
        }
      },
      60_000
    );
  });

  describe('direct URL', () => {
    const TEST_USER = {
      id: 'rust-mcp-qualification-user',
      name: 'Rust MCP Qualification User',
      email: 'rust-mcp-qualification@mangostudio.test',
    };
    const ENVIRONMENT = 'rust-mcp-serve-box';

    let mangoHome: string | undefined;
    let child: ReturnType<typeof Bun.spawn> | undefined;
    const stops: (() => Promise<void>)[] = [];

    afterEach(async () => {
      for (const stop of stops.splice(0)) await stop();
      if (child) {
        child.kill();
        await child.exited;
        child = undefined;
      }
      setRuntimeConnectionManagerForTests(undefined);
      setRuntimeTokenStoreForTests(undefined);
      if (mangoHome) await cleanupMangoHome(mangoHome);
      mangoHome = undefined;
      await getDb().deleteFrom('environments').where('userId', '=', TEST_USER.id).execute();
      await getDb().deleteFrom('user').where('id', '=', TEST_USER.id).execute();
    });

    /** A real `serve` runtime on loopback, registered as a Direct URL environment. */
    async function serveRuntime(): Promise<void> {
      await insertTestUser(TEST_USER);
      const store = new InMemorySecretStore();
      setRuntimeTokenStoreForTests(store);
      const token = 'rust-mcp-qualification-token';
      mangoHome = await scratchMangoHome('mcp-serve');
      const port = reserveEphemeralPort();
      child = Bun.spawn({
        cmd: [binary.path, 'serve', '--listen', `127.0.0.1:${port}`, '--token', 'env'],
        env: { ...process.env, MANGO_HOME: mangoHome, MANGOSTUDIO_RUNTIME_SERVE_TOKEN: token },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const repository = createEnvironmentRepository(getDb());
      const manager = new RuntimeConnectionManager({
        resolveEnvironment: async (userId, environmentId) => repository.find(userId, environmentId),
        connectors: { http: connectHttpRuntime },
      });
      setRuntimeConnectionManagerForTests(manager);
      const service = createEnvironmentService(repository, manager, () => undefined, store);
      await service.create(TEST_USER.id, {
        id: ENVIRONMENT,
        name: 'Rust MCP serve box',
        transportKind: 'http',
        config: { baseUrl: `http://127.0.0.1:${port}` },
        token,
      });
      await connectUntilListening(() => service.connect(TEST_USER.id, ENVIRONMENT));
    }

    function httpConfig(id: string, url: string) {
      return {
        id,
        slug: id,
        transport: 'http' as const,
        command: null,
        args: [],
        env: {},
        url,
        timeoutMs: 15_000,
        environmentId: ENVIRONMENT,
      };
    }

    for (const mode of ['streamable', 'legacy-sse'] as const) {
      it.skipIf(!binary.available)(
        `delivers header secrets to a loopback ${mode} MCP server through the Hub session`,
        async () => {
          await serveRuntime();
          const server = await startQualificationHttpServer(mode);
          stops.push(server.stop);
          const handle = await connectMcpClient(httpConfig(`qual-${mode}`, server.url), {
            userId: TEST_USER.id,
            resolveHeaders: async () => ({ Authorization: 'Bearer qualification-secret' }),
          });
          try {
            expect(handle.getCapabilities()).toEqual({
              tools: true,
              resources: true,
              prompts: true,
            });
            expect((await handle.listTools()).map((tool) => tool.name)).toContain('echo');
            const echo = await handle.callTool('echo', { text: mode });
            expect(echo.contentText).toBe(mode);
            expect(server.requests.length).toBeGreaterThan(0);
            for (const request of server.requests) {
              expect(request.authorization).toBe('Bearer qualification-secret');
            }
            if (mode === 'legacy-sse') {
              // The initialize POST was refused with a 4xx, so the session runs over SSE.
              expect(server.requests.some((r) => r.method === 'GET' && r.path === '/mcp')).toBe(
                true
              );
              expect(server.requests.some((r) => r.path.startsWith('/messages'))).toBe(true);
            }
          } finally {
            await handle.close();
          }
        },
        60_000
      );
    }

    it.skipIf(!binary.available)(
      'refuses plaintext secret delivery to a public runtime before any MCP connect',
      async () => {
        await serveRuntime();
        const server = await startQualificationHttpServer('streamable');
        stops.push(server.stop);
        const refused = await rejectionOf(
          connectMcpClient(httpConfig('qual-public', server.url), {
            userId: TEST_USER.id,
            resolveHeaders: async () => ({ Authorization: 'Bearer never-sent' }),
            resolveTransport: async () => ({
              transportKind: 'http',
              config: { baseUrl: 'http://203.0.113.7:4000' },
            }),
          })
        );
        expect(refused).toBeInstanceOf(McpSecretTransportError);
        expect(server.requests).toEqual([]);
      },
      60_000
    );
  });
});

/** An unused TCP port on loopback, released back to the OS before returning. */
function reserveEphemeralPort(): number {
  const server = Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      open() {
        /* unused */
      },
      data() {
        /* unused */
      },
      close() {
        /* unused */
      },
    },
  });
  const { port } = server;
  server.stop(true);
  return port;
}

/** Retries the Hub's own connect until the freshly spawned `serve` accepts it. */
async function connectUntilListening<T>(attempt: () => Promise<T>, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await attempt();
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await Bun.sleep(50);
    }
  }
}
