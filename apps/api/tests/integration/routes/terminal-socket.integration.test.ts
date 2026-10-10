import { afterEach, describe, expect, it } from 'bun:test';
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
import { listenOnEphemeralPort } from '../../support/listen-ephemeral';
import { FakeTerminalRuntimeClient } from '../../support/mocks/fake-terminal-runtime-client';
import { resolveRustRuntimeBinary, skipWithoutRustBinary } from '../../support/rust-runtime-binary';
import { spawnRustStdioRuntime } from '../../support/rust-stdio-runtime';

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

async function startHub(options: StartHubOptions = {}) {
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
  const port = await listenOnEphemeralPort(app);
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

function connect(
  url: string,
  headers: Record<string, string> = {},
  receiveTimeoutMs = 2_000
): Connected {
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
      }, receiveTimeoutMs);
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

/**
 * Waits for terminal data containing a marker, including text split across frames.
 * `firstMessage` excludes frames observed before a command's output window.
 * Failures retain the cause, named phase, bounded output tail and terminal events.
 *
 * @example
 * await waitForTerminalText(viewer, 'hi');
 */
function waitForTerminalText(
  viewer: Connected,
  marker: string,
  firstMessage = 0,
  phase: 'terminal-text' | 'prompt' | 'constructed-output' = 'terminal-text'
): Promise<TerminalServerMessage> {
  const decoder = new TextDecoder();
  let output = '';
  const beforeObservation = new Set(viewer.messages.slice(0, firstMessage));
  return viewer
    .nextMessage((message) => {
      if (message.type !== 'data' || beforeObservation.has(message)) return false;
      output += decoder.decode(message.data, { stream: true });
      return output.includes(marker);
    })
    .catch((cause: unknown) => {
      const terminalEvents = viewer.messages
        .slice(firstMessage)
        .filter((message) => message.type !== 'data')
        .slice(-8);
      throw new Error(
        [
          cause instanceof Error ? cause.message : String(cause),
          `phase=${phase}`,
          `expected=${JSON.stringify(marker)}`,
          `outputTail=${JSON.stringify(output.slice(-4_096))}`,
          `terminalEvents=${JSON.stringify(terminalEvents)}`,
          `observedFrames=${viewer.messages.length - firstMessage}`,
          `socketReadyState=${viewer.socket.readyState}`,
        ].join('; '),
        { cause }
      );
    });
}

/**
 * Sends a command after the complete prompt and returns its output observation boundary.
 *
 * @example
 * const probe = terminalOutputProbe('powershell');
 * const firstMessage = await writeAfterTerminalText(viewer, 'PS C:\\work> ', probe.command);
 * await waitForTerminalText(viewer, probe.marker, firstMessage);
 */
async function writeAfterTerminalText(
  viewer: Connected,
  readyMarker: string,
  command: string
): Promise<number> {
  await waitForTerminalText(viewer, readyMarker, 0, 'prompt');
  const firstMessage = viewer.messages.length;
  viewer.socket.send(
    encodeTerminalClientMessage({ type: 'data', data: new TextEncoder().encode(command) })
  );
  return firstMessage;
}

/**
 * Creates a unique output marker absent from the shell input that constructs it.
 *
 * @example
 * const { marker, command } = terminalOutputProbe('powershell');
 */
function terminalOutputProbe(shell: 'bash' | 'powershell'): { marker: string; command: string } {
  const nonce = crypto.randomUUID();
  const marker = `mangostudio-pty-relay-${nonce}`;
  const command =
    shell === 'powershell'
      ? `Write-Output ('mangostudio-pty-relay-' + '${nonce}')\r\n`
      : `printf '%s%s\\n' 'mangostudio-pty-relay-' '${nonce}'\n`;
  return { marker, command };
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
    const hub = await startHub();
    const client = connect(`${hub.url}/anything`);

    expect((await client.closed).code).toBe(TERMINAL_SOCKET_CLOSE_CODES.UNAUTHORIZED);
  });

  it('closes a disallowed browser Origin as forbidden', async () => {
    const hub = await startHub();
    const client = connect(`${hub.url}/anything`, { Origin: 'https://evil.example' });

    expect((await client.closed).code).toBe(TERMINAL_SOCKET_CLOSE_CODES.FORBIDDEN);
  });

  it('never reveals whether an unknown session exists', async () => {
    const user = await insertTestUser();
    const hub = await startHub({ resolveUserId: () => Promise.resolve(user.id) });

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
    const hub = await startHub({ service, resolveUserId: () => Promise.resolve(stranger.id) });

    const client = connect(`${hub.url}/${session.id}`);

    expect((await client.closed).code).toBe(TERMINAL_SOCKET_CLOSE_CODES.NOT_FOUND);
  });
});

describe('terminal socket relay', () => {
  async function openViewer(service: TerminalSessionService, userId: string, sessionId: string) {
    const hub = await startHub({ service, resolveUserId: () => Promise.resolve(userId) });
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

  class DelayedTerminalRuntime extends FakeTerminalRuntimeClient {
    async deliverAfter(sessionId: string, text: string, delayMs: number): Promise<void> {
      await Bun.sleep(delayMs);
      this.emitOutput(sessionId, { kind: 'data', data: Buffer.from(text).toString('base64') });
    }
  }

  it.each([
    { label: 'ASCII', marker: 'hi', chunks: [Buffer.from('h'), Buffer.from('i')] },
    {
      label: 'UTF-8',
      marker: 'hé',
      chunks: [Buffer.from('h'), Buffer.from([0xc3]), Buffer.from([0xa9])],
    },
  ])('matches output across separate $label terminal data frames', async ({ marker, chunks }) => {
    const user = await insertTestUser();
    const runtime = new FakeTerminalRuntimeClient();
    const service = relayService(runtime);
    const session = await service.open(user.id, { environmentId: ENVIRONMENT_ID });
    const attached = runtime.waitForCall('attach');
    const viewer = await openViewer(service, user.id, session.id);
    await attached;
    const matched = waitForTerminalText(viewer, marker);

    for (const chunk of chunks) {
      runtime.emitOutput(session.id, { kind: 'data', data: chunk.toString('base64') });
    }

    expect((await matched).type).toBe('data');
    expect(viewer.messages.filter((message) => message.type === 'data')).toHaveLength(
      chunks.length
    );
  });

  it('waits for the complete shell prompt before sending a command', async () => {
    const user = await insertTestUser();
    const runtime = new FakeTerminalRuntimeClient();
    const service = relayService(runtime);
    const session = await service.open(user.id, { environmentId: ENVIRONMENT_ID });
    const attached = runtime.waitForCall('attach');
    const viewer = await openViewer(service, user.id, session.id);
    await attached;
    const command = "Write-Output ('h' + 'i')\r\n";
    const written = runtime.waitForCall('write');
    const sent = writeAfterTerminalText(viewer, `PS ${session.cwd}> `, command);

    runtime.emitOutput(session.id, {
      kind: 'data',
      data: Buffer.from(`PS ${session.cwd}`).toString('base64'),
    });
    await viewer.nextMessage((message) => message.type === 'data');
    expect(
      runtime.calls.write,
      'expected no command before the complete shell prompt'
    ).toHaveLength(0);

    runtime.emitOutput(session.id, { kind: 'data', data: Buffer.from('> ').toString('base64') });
    await sent;
    await written;
    expect(runtime.calls.write).toEqual([
      { sessionId: session.id, data: Buffer.from(command).toString('base64') },
    ]);
  });

  it('does not send a command when the shell prompt never arrives', async () => {
    const user = await insertTestUser();
    const runtime = new FakeTerminalRuntimeClient();
    const service = relayService(runtime);
    const session = await service.open(user.id, { environmentId: ENVIRONMENT_ID });
    const attached = runtime.waitForCall('attach');
    const viewer = await openViewer(service, user.id, session.id);
    await attached;
    const sent = writeAfterTerminalText(
      viewer,
      `PS ${session.cwd}> `,
      "Write-Output ('h' + 'i')\r\n"
    );

    runtime.emitOutput(session.id, {
      kind: 'data',
      data: Buffer.from('startup diagnostic > ').toString('base64'),
    });

    await expect(sent).rejects.toThrow('Timed out waiting for a terminal socket message');
    expect(runtime.calls.write).toHaveLength(0);
  });

  it.each(['prompt', 'constructed-output'] as const)(
    'reports bounded %s observation context and a terminal exit on timeout',
    async (phase) => {
      const user = await insertTestUser();
      const runtime = new FakeTerminalRuntimeClient();
      const service = relayService(runtime);
      const session = await service.open(user.id, { environmentId: ENVIRONMENT_ID });
      const attached = runtime.waitForCall('attach');
      const viewer = await openViewer(service, user.id, session.id);
      await attached;
      const marker = `missing-${phase}-marker`;
      const output = `discarded-output-prefix:${'x'.repeat(8_192)}observed-${phase}-tail`;
      const observation = waitForTerminalText(viewer, marker, 0, phase).catch(
        (cause: unknown) => cause
      );

      runtime.emitOutput(session.id, {
        kind: 'data',
        data: Buffer.from(output).toString('base64'),
      });
      runtime.emitOutput(session.id, { kind: 'exit', exitCode: 42, signal: null });
      expect((await viewer.closed).code).toBe(TERMINAL_SOCKET_CLOSE_CODES.GONE);

      const failure = await observation;
      expect(failure).toBeInstanceOf(Error);
      const error = failure as Error;
      expect(error.message).toContain(`phase=${phase}`);
      expect(error.message).toContain(`expected=${JSON.stringify(marker)}`);
      expect(error.message).toContain(`outputTail=${JSON.stringify(output.slice(-4_096))}`);
      expect(error.message).not.toContain('discarded-output-prefix:');
      expect(error.message).toContain('"type":"exit"');
      expect(error.message).toContain('"exitCode":42');
      expect(error.message).toContain('observedFrames=2');
      expect(error.message).toContain(`socketReadyState=${WebSocket.CLOSED}`);
      expect(error.cause).toBeInstanceOf(Error);
      expect((error.cause as Error).message).toBe(
        'Timed out waiting for a terminal socket message'
      );
      expect(runtime.calls.write).toHaveLength(0);
    }
  );

  it.each([
    {
      label: 'stale startup output',
      cwd: '/home/tester',
      before: 'startup hi\r\n',
      ready: 'PS /home/tester> ',
      after: 'unrelated',
    },
    {
      label: 'text split across the command boundary',
      cwd: '/home/tester',
      before: 'h',
      ready: 'PS /home/tester> ',
      after: 'i',
    },
    {
      label: 'a split prompt containing the old marker',
      cwd: 'C:\\Users\\child',
      before: 'PS C:\\Users\\child',
      ready: '> ',
      after: 'unrelated',
    },
  ])(
    'excludes $label from the command output observation',
    async ({ cwd, before, ready, after }) => {
      const user = await insertTestUser();
      const runtime = new FakeTerminalRuntimeClient({ openResult: { cwd } });
      const service = relayService(runtime);
      const session = await service.open(user.id, { environmentId: ENVIRONMENT_ID });
      const attached = runtime.waitForCall('attach');
      const viewer = await openViewer(service, user.id, session.id);
      await attached;
      runtime.emitOutput(session.id, {
        kind: 'data',
        data: Buffer.from(before).toString('base64'),
      });
      viewer.socket.send(encodeTerminalClientMessage({ type: 'ping' }));
      await viewer.nextMessage((message) => message.type === 'pong');
      const written = runtime.waitForCall('write');
      const sent = writeAfterTerminalText(
        viewer,
        `PS ${session.cwd}> `,
        "Write-Output ('h' + 'i')\r\n"
      );
      runtime.emitOutput(session.id, { kind: 'data', data: Buffer.from(ready).toString('base64') });
      const firstMessage = await sent;
      await written;
      const output = waitForTerminalText(viewer, 'hi', firstMessage);
      runtime.emitOutput(session.id, { kind: 'data', data: Buffer.from(after).toString('base64') });

      await expect(output).rejects.toThrow('Timed out waiting for a terminal socket message');
      expect(runtime.calls.write).toHaveLength(1);
    }
  );

  it('matches command output already queued after its observation boundary', async () => {
    const user = await insertTestUser();
    const runtime = new FakeTerminalRuntimeClient();
    const service = relayService(runtime);
    const session = await service.open(user.id, { environmentId: ENVIRONMENT_ID });
    const attached = runtime.waitForCall('attach');
    const viewer = await openViewer(service, user.id, session.id);
    await attached;
    const written = runtime.waitForCall('write');
    const sent = writeAfterTerminalText(
      viewer,
      `PS ${session.cwd}> `,
      "Write-Output ('h' + 'i')\r\n"
    );
    runtime.emitOutput(session.id, {
      kind: 'data',
      data: Buffer.from(`PS ${session.cwd}> `).toString('base64'),
    });
    const firstMessage = await sent;
    await written;
    runtime.emitOutput(session.id, {
      kind: 'data',
      data: Buffer.from('hi\r\n').toString('base64'),
    });
    viewer.socket.send(encodeTerminalClientMessage({ type: 'ping' }));
    await viewer.nextMessage((message) => message.type === 'pong');

    expect((await waitForTerminalText(viewer, 'hi', firstMessage)).type).toBe('data');
  });

  it('does not accept a post-write prompt or command echo as the unique output marker', async () => {
    const user = await insertTestUser();
    const runtime = new FakeTerminalRuntimeClient({ openResult: { cwd: 'C:\\Users\\child' } });
    const service = relayService(runtime);
    const session = await service.open(user.id, { environmentId: ENVIRONMENT_ID });
    const attached = runtime.waitForCall('attach');
    const viewer = await openViewer(service, user.id, session.id);
    await attached;
    const { marker, command } = terminalOutputProbe('powershell');
    const written = runtime.waitForCall('write');
    const sent = writeAfterTerminalText(viewer, `PS ${session.cwd}> `, command);
    runtime.emitOutput(session.id, {
      kind: 'data',
      data: Buffer.from(`PS ${session.cwd}> `).toString('base64'),
    });
    const firstMessage = await sent;
    await written;
    const output = waitForTerminalText(viewer, marker, firstMessage);
    runtime.emitOutput(session.id, {
      kind: 'data',
      data: Buffer.from(`PS ${session.cwd}> ${command}`).toString('base64'),
    });

    await expect(output).rejects.toThrow('Timed out waiting for a terminal socket message');
    expect(runtime.calls.write).toHaveLength(1);
  });

  it.each(['bash', 'powershell'] as const)('keeps the unique marker out of %s input', (shell) => {
    const { marker, command } = terminalOutputProbe(shell);

    expect(marker).toStartWith('mangostudio-pty-relay-');
    expect(command).not.toContain(marker);
    expect(terminalOutputProbe(shell).marker).not.toBe(marker);
  });

  it('does not match terminal control frames as output text', async () => {
    const user = await insertTestUser();
    const runtime = new FakeTerminalRuntimeClient();
    const service = relayService(runtime);
    const session = await service.open(user.id, { environmentId: ENVIRONMENT_ID });
    const attached = runtime.waitForCall('attach');
    const viewer = await openViewer(service, user.id, session.id);
    await attached;
    const matched = waitForTerminalText(viewer, 'pong');

    viewer.socket.send(encodeTerminalClientMessage({ type: 'ping' }));

    await expect(matched).rejects.toThrow('Timed out waiting for a terminal socket message');
    expect(await viewer.nextMessage((message) => message.type === 'pong')).toEqual({
      type: 'pong',
    });
  });

  it('keeps the default two-second observation bounded for fake runtime frames', async () => {
    const user = await insertTestUser();
    const runtime = new DelayedTerminalRuntime();
    const service = relayService(runtime);
    const session = await service.open(user.id, { environmentId: ENVIRONMENT_ID });
    const viewer = await openViewer(service, user.id, session.id);
    const delivered = runtime.deliverAfter(session.id, 'delayed hi', 2_200);
    try {
      await expect(viewer.nextMessage((message) => message.type === 'data')).rejects.toThrow(
        'Timed out waiting for a terminal socket message'
      );
    } finally {
      await delivered;
    }
    expect(dataText([await viewer.nextMessage((message) => message.type === 'data')])).toEqual([
      'delayed hi',
    ]);
  });

  it('receives a delayed frame within the explicit real-runtime observation window', async () => {
    const user = await insertTestUser();
    const runtime = new DelayedTerminalRuntime();
    const service = relayService(runtime);
    const session = await service.open(user.id, { environmentId: ENVIRONMENT_ID });
    const hub = await startHub({ service, resolveUserId: () => Promise.resolve(user.id) });
    const viewer = connect(`${hub.url}/${session.id}`, {}, 5_000);
    await waitForOpen(viewer.socket);
    const delivered = runtime.deliverAfter(session.id, 'delayed hi', 2_200);
    try {
      const frame = await viewer.nextMessage((message) => message.type === 'data');
      expect(dataText([frame])).toEqual(['delayed hi']);
    } finally {
      await delivered;
    }
  });

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

  it('sends one consent-revoked exit when shell access is withdrawn mid-session', async () => {
    const user = await insertTestUser();
    const runtime = new FakeTerminalRuntimeClient();
    const service = relayService(runtime);
    const session = await service.open(user.id, { environmentId: ENVIRONMENT_ID });
    const attached = runtime.waitForCall('attach');
    const viewer = await openViewer(service, user.id, session.id);
    await attached;

    service.revokeScope(user.id, ENVIRONMENT_ID);
    // The PTY the hub just closed reports its own end afterwards.
    runtime.emitOutput(session.id, { kind: 'exit', exitCode: null, signal: 'SIGHUP' });

    expect((await viewer.closed).code).toBe(TERMINAL_SOCKET_CLOSE_CODES.GONE);
    expect(viewer.messages.filter((message) => message.type === 'exit')).toEqual([
      { type: 'exit', exit: { exitCode: null, signal: null, reason: 'consent-revoked' } },
    ]);
  });

  it('delivers a full exited scrollback before the socket closes', async () => {
    const user = await insertTestUser();
    const scrollback = Buffer.alloc(256 * 1024, 65);
    const runtime = new FakeTerminalRuntimeClient({
      attachResult: {
        status: 'exited',
        exitCode: 0,
        scrollback: scrollback.toString('base64'),
      },
    });
    const service = relayService(runtime);
    const session = await service.open(user.id, { environmentId: ENVIRONMENT_ID });
    const viewer = await openViewer(service, user.id, session.id);

    expect((await viewer.closed).code).toBe(TERMINAL_SOCKET_CLOSE_CODES.GONE);
    const data = viewer.messages.flatMap((message) =>
      message.type === 'data' ? [Buffer.from(message.data)] : []
    );
    expect(Buffer.concat(data)).toEqual(scrollback);
    expect(viewer.messages.at(-1)).toMatchObject({ type: 'exit', exit: { exitCode: 0 } });
  });

  it('relays a consent-revoked exit reason to the viewer', async () => {
    const user = await insertTestUser();
    const runtime = new FakeTerminalRuntimeClient();
    const service = relayService(runtime);
    const session = await service.open(user.id, { environmentId: ENVIRONMENT_ID });
    const attached = runtime.waitForCall('attach');
    const viewer = await openViewer(service, user.id, session.id);
    await attached;

    runtime.emitOutput(session.id, {
      kind: 'exit',
      exitCode: null,
      signal: 'SIGKILL',
      reason: 'consent-revoked',
    });

    expect(await viewer.nextMessage((message) => message.type === 'exit')).toEqual({
      type: 'exit',
      exit: { exitCode: null, signal: 'SIGKILL', reason: 'consent-revoked' },
    });
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

const binary = resolveRustRuntimeBinary();

describe('terminal socket over a real Rust runtime', () => {
  it.skipIf(skipWithoutRustBinary(binary, 'terminal-socket'))(
    'opens, attaches, and relays real PTY output from the platform shell',
    async () => {
      const shell = process.platform === 'win32' ? 'powershell' : 'bash';
      const user = await insertTestUser();
      const runtime = await spawnRustStdioRuntime(binary.path, { label: 'terminal-socket' });
      try {
        // Consent and ability together: a fresh host slot grants shell, and
        // this build answers terminal.* on a machine with a PTY and its platform shell.
        expect(runtime.client.manifest.terminal).toBe(true);
        // The attestation gate is covered by the unit tests; this case proves
        // the PTY relay from a real runtime through the hub's socket route.
        const service = createTerminalSessionService({
          getRuntimeClient: () => Promise.resolve(runtime.client),
          isIdentityAttested: () => true,
        });
        const session = await service.open(user.id, {
          environmentId: 'rust-terminal',
          shell,
        });
        const hub = await startHub({ service, resolveUserId: () => Promise.resolve(user.id) });
        // Native PTY startup can exceed the fake runtime's two-second budget.
        // This observation remains bounded inside the case's 30-second budget.
        const viewer = connect(`${hub.url}/${session.id}`, {}, 5_000);
        await waitForOpen(viewer.socket);

        // A unique constructed marker excludes echoed input and ordinary prompt text.
        const { marker, command } = terminalOutputProbe(shell);
        let firstMessage = viewer.messages.length;
        if (shell === 'powershell') {
          // Observe the default PowerShell prompt for the returned cwd before sending input.
          // Profiles stay as configured; custom prompt text is outside this fixture's scope.
          firstMessage = await writeAfterTerminalText(viewer, `PS ${session.cwd}> `, command);
        } else {
          viewer.socket.send(
            encodeTerminalClientMessage({ type: 'data', data: new TextEncoder().encode(command) })
          );
        }

        const output = await waitForTerminalText(
          viewer,
          marker,
          firstMessage,
          'constructed-output'
        );
        expect(output).toBeDefined();

        await service.close(user.id, session.id);
      } finally {
        await runtime.close();
      }
    },
    30_000
  );
});
