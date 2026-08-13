import { afterEach, describe, expect, it } from 'bun:test';
import {
  clientWebSocketSink,
  createWebSocketFramePort,
  RuntimeHost,
  type RuntimeMethodHandler,
} from '@mangostudio/runtime';
import type { RuntimePairingIssue } from '@mangostudio/shared/environments';
import { REALTIME_IDLE_TIMEOUT_SECONDS } from '@mangostudio/shared/realtime';
import {
  RUNTIME_CLOSE_CODES,
  RUNTIME_HEARTBEAT_TOPIC,
  type RuntimeCapabilityManifest,
  type RuntimeProtocolVersion,
} from '@mangostudio/shared/runtime-protocol';
import { Elysia } from 'elysia';
import { getDb } from '../../../src/db/database';
import { createRuntimePairingService } from '../../../src/modules/environments/application/runtime-pairing-service';
import { createRuntimeSocketRoutes } from '../../../src/modules/environments/http/runtime-socket-routes';
import { createEnvironmentRepository } from '../../../src/modules/environments/infrastructure/environment-repository';
import { createRuntimePairingRepository } from '../../../src/modules/environments/infrastructure/runtime-pairing-repository';
import { REALTIME_WEBSOCKET_OPTIONS } from '../../../src/modules/realtime/http/realtime-routes';
import { RuntimeConnectionManager } from '../../../src/services/runtime-client/runtime-connection-manager';
import { insertTestUser } from '../../support/factories';

const TEST_USER = {
  id: 'runtime-socket-user',
  name: 'Runtime Socket User',
  email: 'runtime-socket@mangostudio.test',
};
const ENVIRONMENT_ID = 'workshop';

const MANIFEST: RuntimeCapabilityManifest = {
  platform: 'linux',
  arch: 'x64',
  pathStyle: 'posix',
  homeDir: '/home/runner',
  shells: ['bash'],
  git: { available: true, version: '2.44.0' },
  features: {
    tools: true,
    git: true,
    probing: false,
    mcp: false,
    library: false,
    checkpoints: true,
  },
};

/** The narrowest valid `shell.run` call; the marker in the reply is the point. */
const SHELL_CALL = {
  kind: 'bash',
  command: 'true',
  timeoutMs: 1_000,
  maxOutputBytes: 1_024,
} as const;

const dialed = new Set<DialedRuntime>();
let stopServer: (() => void) | undefined;

afterEach(async () => {
  for (const runtime of dialed) runtime.close();
  dialed.clear();
  stopServer?.();
  stopServer = undefined;
  await getDb().deleteFrom('runtime_pairing_tokens').where('userId', '=', TEST_USER.id).execute();
  await getDb().deleteFrom('environments').where('userId', '=', TEST_USER.id).execute();
  await getDb().deleteFrom('user').where('id', '=', TEST_USER.id).execute();
});

interface StartHubOptions {
  readonly enabled?: boolean;
  /** Makes the `lastSeenAt` write fail, the way a transient DB error would. */
  readonly failMarkSeen?: boolean;
  /** Holds `adopt` open so a test can close the socket mid-adoption. */
  readonly gateAdopt?: Promise<void>;
  /**
   * Holds `adopt` open *before* it installs an entry, which is the window a
   * revocation can slip through: `disconnect` finds nothing to drop.
   */
  readonly gateAdoptStart?: Promise<void>;
  /** Shrinks the upgrade budget so one extra dial reaches the wall. */
  readonly upgradeLimit?: { readonly max: number; readonly windowMs: number };
}

async function startHub(options: StartHubOptions = {}) {
  await insertTestUser(TEST_USER);
  const environments = createEnvironmentRepository(getDb());
  await environments.create({
    id: ENVIRONMENT_ID,
    userId: TEST_USER.id,
    name: 'Workshop',
    transportKind: 'websocket',
    config: {},
    enabled: options.enabled ?? true,
  });

  const manager = new RuntimeConnectionManager({
    resolveEnvironment: (userId, environmentId) => environments.find(userId, environmentId),
    connectors: {},
  });
  const pairing = createRuntimePairingService({
    repository: createRuntimePairingRepository(getDb()),
    environments,
    manager,
    publish: () => undefined,
    publicUrl: () => 'https://hub.test',
  });
  const issued = await pairing.issue(TEST_USER.id, ENVIRONMENT_ID);

  const gate = options.gateAdopt;
  if (gate) {
    const adopt = manager.adopt.bind(manager);
    manager.adopt = async (userId, environmentId, open) => {
      const client = await adopt(userId, environmentId, open);
      await gate;
      return client;
    };
  }

  const startGate = options.gateAdoptStart;
  if (startGate) {
    const adopt = manager.adopt.bind(manager);
    manager.adopt = async (userId, environmentId, open) => {
      await startGate;
      return await adopt(userId, environmentId, open);
    };
  }

  const app = new Elysia({ websocket: REALTIME_WEBSOCKET_OPTIONS }).group('/api', (group) =>
    group.use(
      createRuntimeSocketRoutes({
        pairing: options.failMarkSeen
          ? { ...pairing, markSeen: () => Promise.reject(new Error('lastSeenAt write failed')) }
          : pairing,
        manager,
        hubVersion: () => 'hub-test',
        idleTimeoutSeconds: REALTIME_IDLE_TIMEOUT_SECONDS,
        ...(options.upgradeLimit ? { upgradeLimit: options.upgradeLimit } : {}),
      })
    )
  );
  app.listen(0);
  const port = (app.server as { port?: number } | null)?.port;
  expect(port).toBeNumber();
  stopServer = () => {
    void app.server?.stop(true);
  };

  return {
    manager,
    pairing,
    environments,
    issued,
    url: `ws://127.0.0.1:${port}/api/runtime`,
  };
}

interface DialedRuntime {
  readonly host: RuntimeHost;
  readonly socket: WebSocket;
  readonly closed: Promise<CloseEvent>;
  close(): void;
}

/**
 * The runtime half of the connection, built the way the `connect` subcommand
 * builds it: chunked frame port over a dialing socket, bearer credential on the
 * upgrade, and the host attached once the socket opens.
 */
async function dialRuntime(
  url: string,
  token: string,
  handlers: ReadonlyMap<string, RuntimeMethodHandler> = new Map(),
  hostOptions: { readonly protocolVersion?: RuntimeProtocolVersion } = {}
): Promise<DialedRuntime> {
  const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
  socket.binaryType = 'arraybuffer';
  const port = createWebSocketFramePort({ sink: clientWebSocketSink(socket) });
  socket.addEventListener('message', (event) => port.receive(event.data as ArrayBuffer));
  socket.addEventListener('close', () => port.handleSocketClosed());

  const closed = new Promise<CloseEvent>((resolve) => {
    socket.addEventListener('close', (event) => resolve(event as CloseEvent), { once: true });
  });
  const opened = new Promise<boolean>((resolve) => {
    socket.addEventListener('open', () => resolve(true), { once: true });
    socket.addEventListener('close', () => resolve(false), { once: true });
  });

  const host = new RuntimeHost({
    runtimeVersion: 'runtime-test',
    manifest: MANIFEST,
    handlers,
    ...hostOptions,
  });
  const runtime: DialedRuntime = {
    host,
    socket,
    closed,
    close() {
      dialed.delete(runtime);
      host.close();
      socket.close();
    },
  };
  dialed.add(runtime);

  if (await opened) {
    host.attach(port);
    host.start();
  }
  return runtime;
}

function echoHandlers(marker: string): ReadonlyMap<string, RuntimeMethodHandler> {
  return new Map<string, RuntimeMethodHandler>([
    ['shell.run', () => Promise.resolve({ marker })],
    [
      'git.exec',
      (_params, context) =>
        new Promise((_resolve, reject) => {
          context.signal.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
        }),
    ],
  ]);
}

describe('runtime dial-in socket', () => {
  it('refuses an upgrade without a usable pairing token', async () => {
    const hub = await startHub();

    const missing = await dialRuntime(hub.url, '');
    const wrong = await dialRuntime(hub.url, 'mrt_nope.nothing');

    expect((await missing.closed).code).toBe(RUNTIME_CLOSE_CODES.UNAUTHORIZED);
    expect((await wrong.closed).code).toBe(RUNTIME_CLOSE_CODES.UNAUTHORIZED);
    expect(hub.manager.getStatus(TEST_USER.id, ENVIRONMENT_ID).state).toBe('disconnected');
  });

  it('adopts a paired runtime and routes calls to it', async () => {
    const hub = await startHub();
    const runtime = await dialRuntime(hub.url, hub.issued.token, echoHandlers('first'));
    await runtime.host.waitUntilReady();

    const client = await hub.manager.getClient(TEST_USER.id, ENVIRONMENT_ID);
    expect(await client.shell.run(SHELL_CALL)).toEqual({ marker: 'first' } as never);
    expect(hub.manager.getStatus(TEST_USER.id, ENVIRONMENT_ID)).toMatchObject({
      state: 'connected',
      manifest: MANIFEST,
    });
  });

  it('refuses a disabled environment rather than adopting it', async () => {
    const hub = await startHub({ enabled: false });
    const runtime = await dialRuntime(hub.url, hub.issued.token);

    expect((await runtime.closed).code).toBe(RUNTIME_CLOSE_CODES.FORBIDDEN);
  });

  it('closes a live socket when its token is revoked', async () => {
    const hub = await startHub();
    const runtime = await dialRuntime(hub.url, hub.issued.token, echoHandlers('first'));
    await runtime.host.waitUntilReady();
    await hub.manager.getClient(TEST_USER.id, ENVIRONMENT_ID);

    await hub.pairing.revoke(TEST_USER.id, ENVIRONMENT_ID);

    expect((await runtime.closed).code).toBe(RUNTIME_CLOSE_CODES.RELEASED);
    const redial = await dialRuntime(hub.url, hub.issued.token);
    expect((await redial.closed).code).toBe(RUNTIME_CLOSE_CODES.UNAUTHORIZED);
  });

  it('lets a second dial supersede the first and fails the loser typed', async () => {
    const hub = await startHub();
    const first = await dialRuntime(hub.url, hub.issued.token, echoHandlers('first'));
    await first.host.waitUntilReady();
    const client = await hub.manager.getClient(TEST_USER.id, ENVIRONMENT_ID);
    // Settled eagerly: the incumbent is closed the moment the second dial is
    // adopted, which is before an `await` further down could observe it.
    const pending = client.git.exec({ args: ['status'], cwd: '/tmp' }).catch((error) => error);

    const second = await dialRuntime(hub.url, hub.issued.token, echoHandlers('second'));
    await second.host.waitUntilReady();

    expect((await first.closed).code).toBe(RUNTIME_CLOSE_CODES.SUPERSEDED);
    expect(await pending).toMatchObject({ code: 'RUNTIME_UNAVAILABLE' });

    const survivor = await hub.manager.getClient(TEST_USER.id, ENVIRONMENT_ID);
    expect(await survivor.shell.run(SHELL_CALL)).toEqual({ marker: 'second' } as never);
  });

  it('never latches a dial-in environment, however many attempts it refused', async () => {
    const hub = await startHub();

    // Five failed connects is the cap that latches a hub-dialed transport. It
    // must not latch this one: the hub cannot dial, so a latch would be a state
    // no button and no redial could clear.
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await expect(hub.manager.getClient(TEST_USER.id, ENVIRONMENT_ID)).rejects.toMatchObject({
        code: 'RUNTIME_UNAVAILABLE',
      });
    }
    expect(hub.manager.getStatus(TEST_USER.id, ENVIRONMENT_ID).state).toBe('disconnected');

    const runtime = await dialRuntime(hub.url, hub.issued.token, echoHandlers('late'));
    await runtime.host.waitUntilReady();

    const client = await hub.manager.getClient(TEST_USER.id, ENVIRONMENT_ID);
    expect(await client.shell.run(SHELL_CALL)).toEqual({ marker: 'late' } as never);
  });

  it('fails an in-flight call when the runtime disappears, then accepts a redial', async () => {
    const hub = await startHub();
    const runtime = await dialRuntime(hub.url, hub.issued.token, echoHandlers('first'));
    await runtime.host.waitUntilReady();
    const client = await hub.manager.getClient(TEST_USER.id, ENVIRONMENT_ID);
    const pending = client.git.exec({ args: ['status'], cwd: '/tmp' }).catch((error) => error);

    runtime.close();
    expect(await pending).toMatchObject({ code: 'RUNTIME_UNAVAILABLE' });

    const redial = await dialRuntime(hub.url, hub.issued.token, echoHandlers('second'));
    await redial.host.waitUntilReady();
    const reconnected = await hub.manager.getClient(TEST_USER.id, ENVIRONMENT_ID);
    expect(await reconnected.shell.run(SHELL_CALL)).toEqual({
      marker: 'second',
    } as never);
  });

  it('keeps an adopted connection when the lastSeenAt write fails', async () => {
    // `markSeen` is bookkeeping. Letting it share the adoption catch turned a
    // stale timestamp into a closed socket for a runtime that had already
    // handshaked and was ready to serve.
    const hub = await startHub({ failMarkSeen: true });
    const runtime = await dialRuntime(hub.url, hub.issued.token, echoHandlers('first'));
    await runtime.host.waitUntilReady();

    const client = await hub.manager.getClient(TEST_USER.id, ENVIRONMENT_ID);
    expect(await client.shell.run(SHELL_CALL)).toEqual({ marker: 'first' } as never);
    expect(hub.manager.getStatus(TEST_USER.id, ENVIRONMENT_ID).state).toBe('connected');
  });

  it('releases a socket that closed while its adoption was still in flight', async () => {
    // The close handler runs before adoption finishes, so it sees a connection
    // the manager does not own yet and leaves it alone. Whoever finishes last
    // has to notice, or the card keeps advertising a runtime that hung up.
    const released = Promise.withResolvers<void>();
    const hub = await startHub({ gateAdopt: released.promise });
    const runtime = await dialRuntime(hub.url, hub.issued.token, echoHandlers('first'));
    await runtime.host.waitUntilReady();

    runtime.close();
    await runtime.closed;
    // The close has to reach the server's handler before adoption resolves —
    // that ordering is the whole bug, and releasing the gate the moment the
    // client sees its own close event would sometimes test the other one.
    await Bun.sleep(50);
    released.resolve();
    // And the route has to finish adopting before the entry can be judged.
    await Bun.sleep(10);

    await expect(hub.manager.getClient(TEST_USER.id, ENVIRONMENT_ID)).rejects.toMatchObject({
      code: 'RUNTIME_UNAVAILABLE',
    });
    expect(hub.manager.getStatus(TEST_USER.id, ENVIRONMENT_ID).state).toBe('disconnected');
  });

  it('refuses an upgrade past the budget with a code the dialer can read', async () => {
    // Counted in the route rather than in the global HTTP hook: a 429 before
    // the upgrade reaches a dialing runtime as a socket that simply failed to
    // open, which it cannot tell from a hub that is down, so it would come back
    // on the wrong cadence.
    const hub = await startHub({ upgradeLimit: { max: 1, windowMs: 60_000 } });

    const first = await dialRuntime(hub.url, hub.issued.token, echoHandlers('first'));
    await first.host.waitUntilReady();
    const second = await dialRuntime(hub.url, hub.issued.token);

    expect((await second.closed).code).toBe(RUNTIME_CLOSE_CODES.RATE_LIMITED);
  });

  it('names an unsupported protocol rather than blaming the environment', async () => {
    // Both refusals reach the route as "unavailable" from the manager, and the
    // remediation is not the same: enabling an environment cannot fix a binary
    // that speaks a protocol this hub does not.
    const hub = await startHub();
    const stale = await dialRuntime(hub.url, hub.issued.token, new Map(), {
      protocolVersion: '0.9',
    });

    expect((await stale.closed).code).toBe(RUNTIME_CLOSE_CODES.PROTOCOL_MISMATCH);
  });

  it('refuses a credential revoked while its adoption was in flight', async () => {
    // `verify` runs before the upgrade and a handshake takes long enough for a
    // revocation to land behind it. Revoking drops what the manager holds — but
    // in this window it holds nothing yet, so the disconnect it issues finds no
    // entry and, without a re-read after adoption, the socket goes on serving a
    // credential that no longer exists.
    const released = Promise.withResolvers<void>();
    const hub = await startHub({ gateAdoptStart: released.promise });
    const runtime = await dialRuntime(hub.url, hub.issued.token, echoHandlers('first'));

    await hub.pairing.revoke(TEST_USER.id, ENVIRONMENT_ID);
    released.resolve();

    expect((await runtime.closed).code).toBe(RUNTIME_CLOSE_CODES.UNAUTHORIZED);
    expect(hub.manager.getStatus(TEST_USER.id, ENVIRONMENT_ID).state).not.toBe('connected');
  });

  it('reports the release a remote runtime is on, and that it is not the hub', async () => {
    // Remote transports connect across a release boundary on purpose. Drift
    // that is allowed and invisible is drift nobody ever fixes, so it has to
    // reach the card.
    const hub = await startHub();
    const runtime = await dialRuntime(hub.url, hub.issued.token, echoHandlers('first'));
    await runtime.host.waitUntilReady();
    await hub.manager.getClient(TEST_USER.id, ENVIRONMENT_ID);

    const status = hub.manager.getStatus(TEST_USER.id, ENVIRONMENT_ID);
    expect(status.runtimeVersion).toBe('runtime-test');
    expect(status.runtimeVersionDrift).toBe(true);
  });

  it('applies the same root payload cap the realtime socket gets', async () => {
    // One `websocket` option object on the root instance covers both families.
    // Asserted here as well as on `/api/ws` because the two routes are
    // registered by different modules and only the shared root ties them
    // together — a per-route transport config would leave this one uncapped.
    const hub = await startHub();
    const socket = new WebSocket(hub.url, {
      headers: { Authorization: `Bearer ${hub.issued.token}` },
    });
    const closed = new Promise<CloseEvent>((resolve) => {
      socket.addEventListener('close', (event) => resolve(event as CloseEvent), { once: true });
    });
    await new Promise<void>((resolve) => {
      socket.addEventListener('open', () => resolve(), { once: true });
    });

    socket.send('x'.repeat(REALTIME_WEBSOCKET_OPTIONS.maxPayloadLength + 1));

    expect((await closed).code).not.toBe(1000);
  });

  it('carries the pre-upgrade credential decision into the opened socket', async () => {
    // The credential is read from the request headers in a `derive` that runs
    // before the upgrade, and the `open` handler acts on what it found. That
    // hand-off is the part an Elysia context-model change moves, and it is
    // asserted through public frames rather than through `ws.data`: a wrong
    // credential closes with UNAUTHORIZED, a right one reaches a working
    // method call, and a query string on the URL changes neither.
    const hub = await startHub();

    const wrong = await dialRuntime(`${hub.url}?environmentId=workshop`, 'mrt_nope.nothing');
    expect((await wrong.closed).code).toBe(RUNTIME_CLOSE_CODES.UNAUTHORIZED);

    const right = await dialRuntime(
      `${hub.url}?environmentId=someone-else&environmentId=again`,
      hub.issued.token,
      echoHandlers('queried')
    );
    await right.host.waitUntilReady();

    // The environment came from the verified token, never from the URL — a
    // route that started trusting the query would bind to `someone-else`.
    const client = await hub.manager.getClient(TEST_USER.id, ENVIRONMENT_ID);
    expect(await client.shell.run(SHELL_CALL)).toEqual({ marker: 'queried' } as never);
  });

  it('records a heartbeat without writing the credential to the logs', async () => {
    const captured: string[] = [];
    const originalWarn = console.warn;
    const originalError = console.error;
    const previousGate = process.env.MANGOSTUDIO_DIAGNOSTIC_LOGS;
    process.env.MANGOSTUDIO_DIAGNOSTIC_LOGS = '1';
    console.warn = (line: unknown) => captured.push(String(line));
    console.error = (line: unknown) => captured.push(String(line));

    try {
      const hub = await startHub();
      // One refused dial and one accepted, so both the failure and the success
      // path have had a chance to log something they should not.
      const refused = await dialRuntime(hub.url, `${hub.issued.token}-wrong`);
      await refused.closed;

      const runtime = await dialRuntime(hub.url, hub.issued.token, echoHandlers('first'));
      await runtime.host.waitUntilReady();
      await hub.manager.getClient(TEST_USER.id, ENVIRONMENT_ID);
      runtime.host.emit({ topic: RUNTIME_HEARTBEAT_TOPIC, payload: { at: Date.now() } });
      await hub.manager
        .getClient(TEST_USER.id, ENVIRONMENT_ID)
        .then((client) => client.shell.run(SHELL_CALL));

      const secret = hub.issued.token.split('.')[1] ?? '';
      expect(secret).not.toBe('');
      expect(captured.join('\n')).not.toContain(secret);
    } finally {
      console.warn = originalWarn;
      console.error = originalError;
      if (previousGate === undefined) delete process.env.MANGOSTUDIO_DIAGNOSTIC_LOGS;
      else process.env.MANGOSTUDIO_DIAGNOSTIC_LOGS = previousGate;
    }
  });
});

describe('runtime pairing token issuance', () => {
  it('hands out a token whose secret half never leaves the issue response', async () => {
    const hub = await startHub();
    const issued: RuntimePairingIssue = hub.issued;

    const status = await hub.pairing.status(TEST_USER.id, ENVIRONMENT_ID);
    expect(status.endpoint).toBe('wss://hub.test/api/runtime');
    expect(JSON.stringify(status)).not.toContain(issued.token);
  });
});
