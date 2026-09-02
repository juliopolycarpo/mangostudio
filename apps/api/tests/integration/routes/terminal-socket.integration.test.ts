import { afterEach, describe, expect, it } from 'bun:test';
import {
  connectInProcessRuntime,
  createLocalRuntimeHost,
  createSlotConsentSource,
  type InProcessRuntimeConnection,
} from '@mangostudio/runtime';
import {
  decodeTerminalServerMessage,
  encodeTerminalClientMessage,
  TERMINAL_SOCKET_CLOSE_CODES,
  type TerminalServerMessage,
} from '@mangostudio/shared/terminal';
import { Elysia } from 'elysia';
import { websocket } from 'elysia/websocket';
import { REALTIME_WEBSOCKET_OPTIONS } from '../../../src/modules/realtime/http/realtime-routes';
import {
  createTerminalSessionService,
  type TerminalSessionService,
} from '../../../src/modules/terminals/application/terminal-session-service';
import { createTerminalSocketRoutes } from '../../../src/modules/terminals/http/terminal-socket-routes';
import { insertTestUser } from '../../support/factories';
import { FakeTerminalRuntimeClient } from '../../support/mocks/fake-terminal-runtime-client';

const ENVIRONMENT_ID = 'workshop';

let stopServer: (() => void) | undefined;
const sockets = new Set<WebSocket>();

afterEach(() => {
  for (const socket of sockets) socket.close();
  sockets.clear();
  stopServer?.();
  stopServer = undefined;
});

interface StartHubOptions {
  readonly service?: TerminalSessionService;
  readonly resolveUserId?: (headers: Headers) => Promise<string | null>;
  readonly allowedOrigins?: readonly string[];
}

function startHub(options: StartHubOptions = {}) {
  const service = options.service ?? createTerminalSessionService();
  const app = new Elysia().use(websocket(REALTIME_WEBSOCKET_OPTIONS)).group('/api', (group) =>
    group.use(
      createTerminalSocketRoutes({
        service,
        ...(options.resolveUserId ? { resolveUserId: options.resolveUserId } : {}),
        ...(options.allowedOrigins ? { allowedOrigins: options.allowedOrigins } : {}),
      })
    )
  );
  app.listen(0);
  const port = (app.server as { port?: number } | null)?.port;
  expect(port).toBeNumber();
  stopServer = () => {
    void app.server?.stop(true);
  };
  return { service, url: `ws://127.0.0.1:${port}/api/terminal` };
}

interface Connected {
  readonly socket: WebSocket;
  readonly messages: TerminalServerMessage[];
  readonly closed: Promise<CloseEvent>;
  nextMessage(
    predicate?: (message: TerminalServerMessage) => boolean
  ): Promise<TerminalServerMessage>;
}

function connect(url: string, headers: Record<string, string> = {}): Connected {
  const socket = new WebSocket(url, { headers });
  socket.binaryType = 'arraybuffer';
  sockets.add(socket);

  const messages: TerminalServerMessage[] = [];
  const pending: TerminalServerMessage[] = [];
  const waiters = new Set<(message: TerminalServerMessage) => void>();
  socket.addEventListener('message', (event) => {
    const message = decodeTerminalServerMessage(new Uint8Array(event.data as ArrayBuffer));
    messages.push(message);
    pending.push(message);
    for (const waiter of waiters) waiter(message);
  });
  const closed = new Promise<CloseEvent>((resolve) => {
    socket.addEventListener(
      'close',
      (event) => {
        sockets.delete(socket);
        resolve(event as CloseEvent);
      },
      { once: true }
    );
  });

  function nextMessage(
    predicate: (message: TerminalServerMessage) => boolean = () => true
  ): Promise<TerminalServerMessage> {
    const index = pending.findIndex(predicate);
    if (index !== -1) return Promise.resolve(pending.splice(index, 1)[0] as TerminalServerMessage);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(onMessage);
        reject(new Error('Timed out waiting for a terminal socket message'));
      }, 2_000);
      const onMessage = (message: TerminalServerMessage): void => {
        if (!predicate(message)) return;
        clearTimeout(timer);
        waiters.delete(onMessage);
        const pendingIndex = pending.indexOf(message);
        if (pendingIndex !== -1) pending.splice(pendingIndex, 1);
        resolve(message);
      };
      waiters.add(onMessage);
    });
  }

  return { socket, messages, closed, nextMessage };
}

async function waitForOpen(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) return;
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true });
    socket.addEventListener('error', () => reject(new Error('socket failed to open')), {
      once: true,
    });
  });
}

describe('terminal socket handshake', () => {
  it('closes an upgrade with no session as unauthorized', async () => {
    const hub = startHub();
    const client = connect(`${hub.url}/anything`);

    expect((await client.closed).code).toBe(TERMINAL_SOCKET_CLOSE_CODES.UNAUTHORIZED);
  });

  it('closes a disallowed browser Origin as forbidden', async () => {
    const hub = startHub();
    const client = connect(`${hub.url}/anything`, { Origin: 'https://evil.example' });

    expect((await client.closed).code).toBe(TERMINAL_SOCKET_CLOSE_CODES.FORBIDDEN);
  });

  it('never reveals whether an unknown session exists', async () => {
    const user = await insertTestUser();
    const hub = startHub({ resolveUserId: () => Promise.resolve(user.id) });

    const client = connect(`${hub.url}/no-such-session`);

    expect((await client.closed).code).toBe(TERMINAL_SOCKET_CLOSE_CODES.NOT_FOUND);
  });

  it('refuses a session owned by another user with the same code as a missing one', async () => {
    const owner = await insertTestUser();
    const stranger = await insertTestUser();
    const service = createTerminalSessionService({
      getConfig: () => ({
        enabled: true,
        idleTimeoutMinutes: 30,
        maxSessionsPerUser: 8,
        scrollbackKib: 256,
      }),
      getRuntimeClient: () => Promise.resolve(new FakeTerminalRuntimeClient()),
      isIdentityAttested: () => true,
    });
    const session = await service.open(owner.id, { environmentId: ENVIRONMENT_ID });
    const hub = startHub({ service, resolveUserId: () => Promise.resolve(stranger.id) });

    const client = connect(`${hub.url}/${session.id}`);

    expect((await client.closed).code).toBe(TERMINAL_SOCKET_CLOSE_CODES.NOT_FOUND);
  });
});

describe('terminal socket relay', () => {
  async function openViewer(service: TerminalSessionService, userId: string, sessionId: string) {
    const hub = startHub({ service, resolveUserId: () => Promise.resolve(userId) });
    const client = connect(`${hub.url}/${sessionId}`);
    await waitForOpen(client.socket);
    return client;
  }

  it('replays scrollback, relays live output, and closes on exit', async () => {
    const user = await insertTestUser();
    const runtime = new FakeTerminalRuntimeClient({
      attachResult: { scrollback: Buffer.from('welcome\n').toString('base64') },
    });
    const service = createTerminalSessionService({
      getConfig: () => ({
        enabled: true,
        idleTimeoutMinutes: 30,
        maxSessionsPerUser: 8,
        scrollbackKib: 256,
      }),
      getRuntimeClient: () => Promise.resolve(runtime),
      isIdentityAttested: () => true,
    });
    const session = await service.open(user.id, { environmentId: ENVIRONMENT_ID });
    const viewer = await openViewer(service, user.id, session.id);

    const scrollback = await viewer.nextMessage((message) => message.type === 'data');
    expect(scrollback).toMatchObject({ type: 'data' });
    expect(Buffer.from((scrollback as { data: Uint8Array }).data).toString()).toBe('welcome\n');

    runtime.emitOutput(session.id, { kind: 'data', data: Buffer.from('hi\n').toString('base64') });
    const live = await viewer.nextMessage(
      (message) => message.type === 'data' && Buffer.from(message.data).toString() === 'hi\n'
    );
    expect(live).toBeDefined();

    runtime.emitOutput(session.id, { kind: 'exit', exitCode: 0, signal: null });
    const exit = await viewer.nextMessage((message) => message.type === 'exit');
    expect(exit).toMatchObject({ type: 'exit', exit: { exitCode: 0, signal: null } });
    expect((await viewer.closed).code).toBe(TERMINAL_SOCKET_CLOSE_CODES.GONE);
  });

  it('forwards a client write to terminal.write, base64-encoded', async () => {
    const user = await insertTestUser();
    const runtime = new FakeTerminalRuntimeClient();
    const service = createTerminalSessionService({
      getConfig: () => ({
        enabled: true,
        idleTimeoutMinutes: 30,
        maxSessionsPerUser: 8,
        scrollbackKib: 256,
      }),
      getRuntimeClient: () => Promise.resolve(runtime),
      isIdentityAttested: () => true,
    });
    const session = await service.open(user.id, { environmentId: ENVIRONMENT_ID });
    const viewer = await openViewer(service, user.id, session.id);
    await viewer.nextMessage(() => true).catch(() => undefined); // let attach settle if it sent nothing

    viewer.socket.send(
      encodeTerminalClientMessage({ type: 'data', data: new TextEncoder().encode('printf hi\n') })
    );

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(runtime.calls.write).toHaveLength(1);
    expect(Buffer.from(runtime.calls.write[0]?.data ?? '', 'base64').toString()).toBe(
      'printf hi\n'
    );
  });

  it('closes the previous viewer with REPLACED when a second socket attaches', async () => {
    const user = await insertTestUser();
    const runtime = new FakeTerminalRuntimeClient();
    const service = createTerminalSessionService({
      getConfig: () => ({
        enabled: true,
        idleTimeoutMinutes: 30,
        maxSessionsPerUser: 8,
        scrollbackKib: 256,
      }),
      getRuntimeClient: () => Promise.resolve(runtime),
      isIdentityAttested: () => true,
    });
    const session = await service.open(user.id, { environmentId: ENVIRONMENT_ID });
    const first = await openViewer(service, user.id, session.id);
    const second = await openViewer(service, user.id, session.id);

    expect((await first.closed).code).toBe(TERMINAL_SOCKET_CLOSE_CODES.REPLACED);

    // The replaced socket's close handler runs after the successor attached.
    // It must not send `terminal.detach`: that would stop the runtime's stream
    // while the second viewer is still reading it.
    await Bun.sleep(50);
    expect(runtime.calls.detach).toHaveLength(0);
    expect(second.socket.readyState).toBe(WebSocket.OPEN);
    runtime.emitOutput(session.id, {
      kind: 'data',
      data: Buffer.from('still here').toString('base64'),
    });
    const live = await second.nextMessage((message) => message.type === 'data');
    expect(live.type === 'data' && Buffer.from(live.data).toString()).toBe('still here');
  });
});

/**
 * Probes whether this worktree's `apps/runtime` build both supports a PTY and
 * has the `terminal.*` handlers wired into the Local host. Neither the runtime
 * work landing this feature relies on nor this hub's tests can assume the
 * other half is done: this hub half was built while `terminal.open` had no
 * handler registered anywhere in `apps/runtime`, so a real Local terminal
 * would answer `METHOD_UNSUPPORTED`. The probe result gates one `it` below
 * with a stated reason rather than letting that surface as a failure.
 */
async function probeLocalTerminalSupport(): Promise<{ ok: boolean; reason: string }> {
  const host = createLocalRuntimeHost({
    runtimeVersion: 'terminal-probe',
    consent: createSlotConsentSource({ slot: 'host' }),
  });
  let connection: InProcessRuntimeConnection | undefined;
  try {
    connection = await connectInProcessRuntime(host, { hubVersion: 'hub-test' });
    if (connection.client.manifest.terminal !== true) {
      return {
        ok: false,
        reason: 'this machine reports no PTY/shell consent (manifest.terminal !== true)',
      };
    }
    const sessionId = crypto.randomUUID();
    await connection.client.request('terminal.open', { sessionId, cols: 80, rows: 24 });
    await connection.client.request('terminal.close', { sessionId });
    return { ok: true, reason: '' };
  } catch (error) {
    return {
      ok: false,
      reason: `terminal.* handlers are not wired into this worktree's apps/runtime yet (${
        error instanceof Error ? error.message : String(error)
      })`,
    };
  } finally {
    await connection?.close();
  }
}

const localTerminalSupport = await probeLocalTerminalSupport();

describe('terminal socket over a real Local runtime', () => {
  it.skipIf(!localTerminalSupport.ok)(
    `opens, attaches, and relays real PTY output for printf hi (skip reason if skipped: ${localTerminalSupport.reason})`,
    async () => {
      const user = await insertTestUser();
      // The attestation is answered by the process-wide connection manager,
      // and earlier files in the same run connect other users to the Local
      // runtime, which is exactly what un-proves single-user-host. The gate is
      // covered by the unit tests; this case proves the PTY relay.
      const service = createTerminalSessionService({ isIdentityAttested: () => true });
      const session = await service.open(user.id, {
        environmentId: 'local',
        shell: 'bash',
      });
      const hub = startHub({ service, resolveUserId: () => Promise.resolve(user.id) });
      const viewer = connect(`${hub.url}/${session.id}`);
      await waitForOpen(viewer.socket);

      viewer.socket.send(
        encodeTerminalClientMessage({
          type: 'data',
          data: new TextEncoder().encode('printf hi\n'),
        })
      );

      const withHi = await viewer.nextMessage(
        (message) => message.type === 'data' && Buffer.from(message.data).toString().includes('hi')
      );
      expect(withHi).toBeDefined();

      await service.close(user.id, session.id);
    }
  );
});
