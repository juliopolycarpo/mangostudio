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
  TERMINAL_SOCKET_MAX_PENDING_MESSAGES,
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

  function relayService(runtime: FakeTerminalRuntimeClient): TerminalSessionService {
    return createTerminalSessionService({
      getConfig: () => ({
        enabled: true,
        idleTimeoutMinutes: 30,
        maxSessionsPerUser: 8,
        scrollbackKib: 256,
      }),
      getRuntimeClient: () => Promise.resolve(runtime),
      isIdentityAttested: () => true,
    });
  }

  /**
   * Every socket quiesces the stream with `terminal.detach` before its own
   * `terminal.attach`, so counting detaches says nothing. What must hold is
   * that none follows the last attach: that one would stop the runtime's
   * stream while the viewer that owns it is still reading.
   */
  function detachesAfterLastAttach(runtime: FakeTerminalRuntimeClient) {
    const lastAttach = runtime.sequence.map((call) => call.method).lastIndexOf('attach');
    return runtime.sequence.slice(lastAttach + 1).filter((call) => call.method === 'detach');
  }

  function dataText(messages: readonly TerminalServerMessage[]): string[] {
    return messages.flatMap((message) =>
      message.type === 'data' ? [Buffer.from(message.data).toString()] : []
    );
  }

  it('replays scrollback, relays live output, and closes on exit', async () => {
    const user = await insertTestUser();
    const runtime = new FakeTerminalRuntimeClient({
      attachResult: { scrollback: Buffer.from('welcome\n').toString('base64') },
    });
    const service = relayService(runtime);
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
    const service = relayService(runtime);
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

  it('relays output the runtime emitted in the same read as the attach response', async () => {
    const user = await insertTestUser();
    const runtime = new FakeTerminalRuntimeClient({
      attachResult: { scrollback: Buffer.from('welcome\n').toString('base64') },
      outputWithFirstAttachResponse: [
        { kind: 'data', data: Buffer.from('raced\n').toString('base64') },
      ],
    });
    const service = relayService(runtime);
    const session = await service.open(user.id, { environmentId: ENVIRONMENT_ID });
    const viewer = await openViewer(service, user.id, session.id);

    // The frame was dispatched before the route's `await` on the response
    // resumed, so only a subscription taken out *before* the request catches
    // it — and it still has to land behind the scrollback it continues.
    const scrollback = await viewer.nextMessage((message) => message.type === 'data');
    expect(dataText([scrollback])).toEqual(['welcome\n']);
    const raced = await viewer.nextMessage((message) => message.type === 'data');
    expect(dataText([raced])).toEqual(['raced\n']);
  });

  it('ends the turn when the session exits in the same read as the attach response', async () => {
    const user = await insertTestUser();
    const runtime = new FakeTerminalRuntimeClient({
      outputWithFirstAttachResponse: [{ kind: 'exit', exitCode: 3, signal: null }],
    });
    const service = relayService(runtime);
    const session = await service.open(user.id, { environmentId: ENVIRONMENT_ID });
    const viewer = await openViewer(service, user.id, session.id);

    // Losing this frame leaves the viewer on a dead session: the attach reply
    // said `running`, and no later frame ever says otherwise.
    const exit = await viewer.nextMessage((message) => message.type === 'exit');
    expect(exit).toMatchObject({ type: 'exit', exit: { exitCode: 3, signal: null } });
    expect((await viewer.closed).code).toBe(TERMINAL_SOCKET_CLOSE_CODES.GONE);
    expect(service.list(user.id)[0]).toMatchObject({ status: 'exited' });
  });

  it('does not replay output the runtime emitted before this socket attached', async () => {
    const user = await insertTestUser();
    let releaseDetach!: () => void;
    const detachGate = new Promise<void>((resolve) => {
      releaseDetach = resolve;
    });
    const runtime = new FakeTerminalRuntimeClient({
      gateFirstDetach: () => detachGate,
      attachResult: { scrollback: Buffer.from('older\n').toString('base64') },
      outputWithFirstAttachResponse: [
        { kind: 'data', data: Buffer.from('newer\n').toString('base64') },
      ],
    });
    const service = relayService(runtime);
    const session = await service.open(user.id, { environmentId: ENVIRONMENT_ID });
    const viewer = await openViewer(service, user.id, session.id);

    // A predecessor's stream is still running while this socket's quiescing
    // detach is in flight. These bytes reach the scrollback the attach then
    // snapshots, so relaying them as live output too would double them.
    await Bun.sleep(20);
    runtime.emitOutput(session.id, {
      kind: 'data',
      data: Buffer.from('older\n').toString('base64'),
    });
    releaseDetach();

    await viewer.nextMessage(
      (message) => message.type === 'data' && Buffer.from(message.data).toString() === 'newer\n'
    );
    await Bun.sleep(20);
    expect(dataText(viewer.messages)).toEqual(['older\n', 'newer\n']);
  });

  it('never attaches a socket a takeover replaced while its quiescing detach was in flight', async () => {
    const user = await insertTestUser();
    // Releasing on the successor's attach, rather than after a sleep, keeps
    // the replaced socket's resume inside the takeover's own turn of the loop:
    // it must abandon the attach it already had in flight, whenever its `close`
    // handler happens to run. Attaching afterwards would re-snapshot the
    // successor's scrollback and double everything in between.
    const runtime: FakeTerminalRuntimeClient = new FakeTerminalRuntimeClient({
      gateFirstDetach: () => runtime.waitForCall('attach'),
    });
    const service = relayService(runtime);
    const session = await service.open(user.id, { environmentId: ENVIRONMENT_ID });

    const first = await openViewer(service, user.id, session.id);
    const second = await openViewer(service, user.id, session.id);

    await Bun.sleep(50);
    expect((await first.closed).code).toBe(TERMINAL_SOCKET_CLOSE_CODES.REPLACED);
    expect(runtime.calls.attach).toHaveLength(1);
    expect(detachesAfterLastAttach(runtime)).toEqual([]);
    runtime.emitOutput(session.id, {
      kind: 'data',
      data: Buffer.from('still here').toString('base64'),
    });
    const live = await second.nextMessage((message) => message.type === 'data');
    expect(dataText([live])).toEqual(['still here']);
  });

  it('closes the previous viewer with REPLACED when a second socket attaches', async () => {
    const user = await insertTestUser();
    const runtime = new FakeTerminalRuntimeClient();
    const service = relayService(runtime);
    const session = await service.open(user.id, { environmentId: ENVIRONMENT_ID });
    const first = await openViewer(service, user.id, session.id);
    const second = await openViewer(service, user.id, session.id);

    expect((await first.closed).code).toBe(TERMINAL_SOCKET_CLOSE_CODES.REPLACED);

    // The replaced socket's close handler runs after the successor attached.
    // It must not send `terminal.detach`: that would stop the runtime's stream
    // while the second viewer is still reading it.
    await Bun.sleep(50);
    expect(detachesAfterLastAttach(runtime)).toEqual([]);
    expect(second.socket.readyState).toBe(WebSocket.OPEN);
    runtime.emitOutput(session.id, {
      kind: 'data',
      data: Buffer.from('still here').toString('base64'),
    });
    const live = await second.nextMessage((message) => message.type === 'data');
    expect(live.type === 'data' && Buffer.from(live.data).toString()).toBe('still here');
  });

  it('does not detach the runtime when a takeover replaces the viewer while attach() is still in flight', async () => {
    const user = await insertTestUser();
    let releaseAttach!: () => void;
    const attachGate = new Promise<void>((resolve) => {
      releaseAttach = resolve;
    });
    const runtime = new FakeTerminalRuntimeClient({ gateFirstAttach: () => attachGate });
    const service = relayService(runtime);
    const session = await service.open(user.id, { environmentId: ENVIRONMENT_ID });

    // The first socket's terminal.attach() blocks on the gate, so a takeover
    // races it: the second viewer replaces it before it ever finishes attaching.
    const first = await openViewer(service, user.id, session.id);
    const second = await openViewer(service, user.id, session.id);
    expect((await first.closed).code).toBe(TERMINAL_SOCKET_CLOSE_CODES.REPLACED);

    releaseAttach();
    await Bun.sleep(50);

    expect(detachesAfterLastAttach(runtime)).toEqual([]);
    expect(second.socket.readyState).toBe(WebSocket.OPEN);
  });

  it('drops a client message queued before a takeover instead of forwarding it after the viewer was replaced', async () => {
    const user = await insertTestUser();
    let releaseWrite!: () => void;
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const runtime = new FakeTerminalRuntimeClient({ gateFirstWrite: () => writeGate });
    const service = relayService(runtime);
    const session = await service.open(user.id, { environmentId: ENVIRONMENT_ID });
    const first = await openViewer(service, user.id, session.id);

    // The first message's terminal.write() blocks on the gate, so the second
    // message sits queued in the socket's messageChain, not yet started, when
    // the takeover below closes this socket.
    first.socket.send(
      encodeTerminalClientMessage({ type: 'data', data: new TextEncoder().encode('a') })
    );
    first.socket.send(
      encodeTerminalClientMessage({ type: 'data', data: new TextEncoder().encode('b') })
    );

    const second = await openViewer(service, user.id, session.id);
    expect((await first.closed).code).toBe(TERMINAL_SOCKET_CLOSE_CODES.REPLACED);

    releaseWrite();
    await Bun.sleep(50);

    expect(runtime.calls.write).toHaveLength(1);
    expect(second.socket.readyState).toBe(WebSocket.OPEN);
  });

  it('closes a client that queues more frames than the runtime can answer', async () => {
    const user = await insertTestUser();
    let releaseWrite!: () => void;
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const runtime = new FakeTerminalRuntimeClient({ gateFirstWrite: () => writeGate });
    const service = relayService(runtime);
    const session = await service.open(user.id, { environmentId: ENVIRONMENT_ID });
    const viewer = await openViewer(service, user.id, session.id);

    // The first write blocks on the gate, so every frame behind it sits
    // un-dispatched in the socket's message chain, retaining its bytes.
    const frame = encodeTerminalClientMessage({
      type: 'data',
      data: new TextEncoder().encode('x'),
    });
    for (let i = 0; i <= TERMINAL_SOCKET_MAX_PENDING_MESSAGES + 1; i += 1) {
      viewer.socket.send(frame);
    }

    expect((await viewer.closed).code).toBe(TERMINAL_SOCKET_CLOSE_CODES.RATE_LIMITED);
    releaseWrite();
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
