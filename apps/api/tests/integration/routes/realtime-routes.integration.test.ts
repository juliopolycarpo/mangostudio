import { afterEach, describe, expect, it } from 'bun:test';
import { API_KEY_HEADER } from '@mangostudio/shared/api-keys';
import { ERROR_CODES } from '@mangostudio/shared/errors';
import {
  gitTopic,
  REALTIME_CLOSE_CODES,
  type RealtimeServerMessage,
  SETTINGS_TOPIC,
} from '@mangostudio/shared/realtime';
import type { Elysia } from 'elysia';
import { getApiKeyApi } from '../../../src/auth';
import { getDb } from '../../../src/db/database';
import { createChat } from '../../../src/modules/chats/infrastructure/chat-repository';
import {
  createRealtimeRoutes,
  REALTIME_WEBSOCKET_OPTIONS,
} from '../../../src/modules/realtime/http/realtime-routes';
import { authRoutes } from '../../../src/routes/auth';
import { createRealtimeBus, type RealtimeBus } from '../../../src/services/realtime/realtime-bus';
import { createApiTestApp } from '../../support/harness/create-api-test-app';

interface TestUser {
  id: string;
  cookie: string;
}

interface SocketClose {
  code: number;
  reason: string;
}

const sockets = new Set<WebSocket>();
let stopServer: (() => void) | undefined;

function startServer(dependencies: Parameters<typeof createRealtimeRoutes>[0] = {}) {
  const bus = dependencies.bus ?? createRealtimeBus();
  const routes = createRealtimeRoutes({ ...dependencies, bus });
  const apiRoutes = (app: Elysia) =>
    app.group('/api', (group) =>
      group
        .use(authRoutes)
        .use(routes)
        .get('/realtime-scope-probe', () => ({ ok: true }))
    );
  const app = createApiTestApp(apiRoutes);
  app.listen(0);
  const port = (app.server as { port?: number } | null)?.port;

  expect(port).toBeNumber();
  stopServer = () => {
    // Bun can leave the stop promise pending after a server-initiated close.
    // Trigger abrupt shutdown; the following test starts on a fresh port.
    void app.server?.stop(true);
  };

  return {
    bus,
    httpUrl: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}/api/ws`,
  };
}

async function signUp(httpUrl: string): Promise<TestUser> {
  const response = await fetch(`${httpUrl}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: `realtime-${crypto.randomUUID()}@mangostudio.test`,
      password: 'correct-horse-battery-staple',
      name: 'Realtime Tester',
    }),
  });
  const body = (await response.json()) as { user?: { id: string } };
  const cookie = response.headers
    .getSetCookie()
    .map((value) => value.split(';', 1)[0])
    .join('; ');

  expect(response.status).toBe(200);
  expect(body.user?.id).toBeString();
  expect(cookie).not.toBe('');
  return { id: body.user?.id ?? '', cookie };
}

function connect(url: string, headers: Record<string, string> = {}) {
  const socket = new WebSocket(url, { headers });
  sockets.add(socket);

  const messages: RealtimeServerMessage[] = [];
  const pendingMessages: RealtimeServerMessage[] = [];
  const waiters = new Set<(message: RealtimeServerMessage) => void>();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data)) as RealtimeServerMessage;
    messages.push(message);
    pendingMessages.push(message);
    for (const waiter of waiters) waiter(message);
  });

  const opened = new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true });
    socket.addEventListener('error', () => reject(new Error('WebSocket failed to open')), {
      once: true,
    });
  });
  const closed = new Promise<SocketClose>((resolve) => {
    socket.addEventListener(
      'close',
      (event) => {
        sockets.delete(socket);
        resolve({ code: event.code, reason: event.reason });
      },
      { once: true }
    );
  });

  function nextMessage(
    predicate: (message: RealtimeServerMessage) => boolean = () => true
  ): Promise<RealtimeServerMessage> {
    const existingIndex = pendingMessages.findIndex(predicate);
    if (existingIndex !== -1) {
      return Promise.resolve(pendingMessages.splice(existingIndex, 1)[0] as RealtimeServerMessage);
    }

    return new Promise<RealtimeServerMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(onMessage);
        reject(new Error('Timed out waiting for WebSocket message'));
      }, 2_000);
      const onMessage = (message: RealtimeServerMessage) => {
        if (!predicate(message)) return;
        clearTimeout(timer);
        waiters.delete(onMessage);
        const pendingIndex = pendingMessages.indexOf(message);
        if (pendingIndex !== -1) pendingMessages.splice(pendingIndex, 1);
        resolve(message);
      };
      waiters.add(onMessage);
    });
  }

  return { socket, messages, opened, closed, nextMessage };
}

function send(socket: WebSocket, message: unknown): void {
  socket.send(typeof message === 'string' ? message : JSON.stringify(message));
}

afterEach(() => {
  for (const socket of sockets) {
    socket.close();
  }
  sockets.clear();
  stopServer?.();
  stopServer = undefined;
});

describe('realtime WebSocket authentication', () => {
  it('does not resolve realtime sessions for neighboring HTTP routes', async () => {
    let sessionResolutions = 0;
    const { httpUrl } = startServer({
      resolveUserId: () => {
        sessionResolutions += 1;
        return Promise.resolve(null);
      },
    });

    const response = await fetch(`${httpUrl}/api/realtime-scope-probe`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(sessionResolutions).toBe(0);
  });

  it('sends an authentication error and closes missing sessions with 4401', async () => {
    const { wsUrl } = await startServer();
    const client = connect(wsUrl);

    await client.opened;
    expect(await client.nextMessage()).toEqual({
      type: 'error',
      error: 'Unauthorized',
      code: ERROR_CODES.UNAUTHORIZED,
    });
    expect(await client.closed).toEqual({
      code: REALTIME_CLOSE_CODES.UNAUTHORIZED,
      reason: 'Unauthorized',
    });
    expect(client.messages.some((message) => message.type === 'ready')).toBe(false);
  });

  it('accepts a cookie session and sends ready', async () => {
    const { httpUrl, wsUrl } = await startServer();
    const user = await signUp(httpUrl);
    const client = connect(wsUrl, { Cookie: user.cookie });

    await client.opened;
    expect(await client.nextMessage()).toEqual({ type: 'ready' });
  });

  it('rejects API keys without ever sending ready', async () => {
    const { httpUrl, wsUrl } = startServer();
    const user = await signUp(httpUrl);
    const apiKey = await getApiKeyApi().createApiKey({
      body: {
        userId: user.id,
        name: 'Realtime rejection',
        metadata: { scope: 'full' },
      },
    });
    const client = connect(wsUrl, { [API_KEY_HEADER]: apiKey.key });

    await client.opened;
    expect(await client.nextMessage()).toEqual({
      type: 'error',
      error: 'Unauthorized',
      code: ERROR_CODES.UNAUTHORIZED,
    });
    expect((await client.closed).code).toBe(REALTIME_CLOSE_CODES.UNAUTHORIZED);
    expect(client.messages.some((message) => message.type === 'ready')).toBe(false);
  });
});

describe('realtime WebSocket origins and liveness', () => {
  it('uses bounded root WebSocket transport settings', () => {
    expect(REALTIME_WEBSOCKET_OPTIONS).toEqual({
      idleTimeout: 60,
      maxPayloadLength: 16 * 1024,
      backpressureLimit: 64 * 1024,
      closeOnBackpressureLimit: true,
    });
  });

  it('accepts configured, public-auth, and absent origins but rejects other browser origins', async () => {
    const { httpUrl, wsUrl } = startServer();
    const user = await signUp(httpUrl);
    const acceptedOrigins = ['http://localhost:5173', 'http://localhost:3001'];

    for (const origin of acceptedOrigins) {
      const client = connect(wsUrl, { Cookie: user.cookie, Origin: origin });
      await client.opened;
      expect(await client.nextMessage()).toEqual({ type: 'ready' });
    }

    const diagnosticClient = connect(wsUrl, { Cookie: user.cookie });
    await diagnosticClient.opened;
    expect(await diagnosticClient.nextMessage()).toEqual({ type: 'ready' });

    const rejectedClient = connect(wsUrl, {
      Cookie: user.cookie,
      Origin: 'https://attacker.example',
    });
    await rejectedClient.opened;
    expect(await rejectedClient.nextMessage()).toEqual({
      type: 'error',
      error: 'Origin is not allowed',
      code: ERROR_CODES.PERMISSION_DENIED,
    });
    expect((await rejectedClient.closed).code).toBe(REALTIME_CLOSE_CODES.FORBIDDEN);
  });

  it('responds to application-level ping messages', async () => {
    const { httpUrl, wsUrl } = startServer();
    const user = await signUp(httpUrl);
    const client = connect(wsUrl, { Cookie: user.cookie });

    await client.opened;
    await client.nextMessage();
    send(client.socket, { type: 'ping' });

    expect(await client.nextMessage()).toEqual({ type: 'pong' });
  });
});

describe('realtime WebSocket subscriptions', () => {
  it('delivers settings invalidations only to subscribed sockets for the same user', async () => {
    const { bus, httpUrl, wsUrl } = startServer();
    const firstUser = await signUp(httpUrl);
    const secondUser = await signUp(httpUrl);
    const firstClient = connect(wsUrl, { Cookie: firstUser.cookie });
    const secondClient = connect(wsUrl, { Cookie: secondUser.cookie });

    await Promise.all([firstClient.opened, secondClient.opened]);
    await Promise.all([firstClient.nextMessage(), secondClient.nextMessage()]);
    send(firstClient.socket, { type: 'subscribe', topics: [SETTINGS_TOPIC] });
    send(secondClient.socket, { type: 'subscribe', topics: [SETTINGS_TOPIC] });
    await Bun.sleep(10);

    bus.publish(firstUser.id, {
      type: 'invalidate',
      topic: SETTINGS_TOPIC,
      scopes: ['app'],
    });
    expect(await firstClient.nextMessage()).toEqual({
      type: 'invalidate',
      topic: SETTINGS_TOPIC,
      scopes: ['app'],
    });
    await Bun.sleep(50);
    expect(secondClient.messages.some((message) => message.type === 'invalidate')).toBe(false);

    bus.publish(secondUser.id, {
      type: 'invalidate',
      topic: SETTINGS_TOPIC,
      scopes: ['provider'],
    });
    expect(await secondClient.nextMessage()).toEqual({
      type: 'invalidate',
      topic: SETTINGS_TOPIC,
      scopes: ['provider'],
    });
  });

  it('authorizes owned git topics without revealing foreign chats', async () => {
    const { bus, httpUrl, wsUrl } = startServer();
    const user = await signUp(httpUrl);
    const otherUser = await signUp(httpUrl);
    const ownedChat = await createChat({ title: 'Owned', userId: user.id }, getDb());
    const foreignChat = await createChat({ title: 'Foreign', userId: otherUser.id }, getDb());
    const ownedTopic = gitTopic(ownedChat.id);
    const foreignTopic = gitTopic(foreignChat.id);
    const client = connect(wsUrl, { Cookie: user.cookie });

    await client.opened;
    await client.nextMessage();
    send(client.socket, {
      type: 'subscribe',
      topics: [ownedTopic, foreignTopic],
    });

    expect(await client.nextMessage()).toEqual({
      type: 'error',
      error: 'Realtime topic is unavailable',
      code: ERROR_CODES.NOT_FOUND,
    });
    bus.publish(user.id, {
      type: 'invalidate',
      topic: ownedTopic,
      scopes: ['state'],
    });
    expect(await client.nextMessage()).toEqual({
      type: 'invalidate',
      topic: ownedTopic,
      scopes: ['state'],
    });

    const beforeForeignPublish = client.messages.length;
    bus.publish(user.id, {
      type: 'invalidate',
      topic: foreignTopic,
      scopes: ['state'],
    });
    await Bun.sleep(50);
    expect(client.messages).toHaveLength(beforeForeignPublish);
  });

  it('makes unsubscribe idempotent and removes the bus listener on close', async () => {
    const underlyingBus = createRealtimeBus();
    let activeListeners = 0;
    const trackingBus: RealtimeBus = {
      publish: underlyingBus.publish,
      subscribe(userId, listener) {
        activeListeners += 1;
        const unsubscribe = underlyingBus.subscribe(userId, listener);
        let active = true;
        return () => {
          if (!active) return;
          active = false;
          activeListeners -= 1;
          unsubscribe();
        };
      },
    };
    const { bus, httpUrl, wsUrl } = startServer({ bus: trackingBus });
    const user = await signUp(httpUrl);
    const client = connect(wsUrl, { Cookie: user.cookie });

    await client.opened;
    await client.nextMessage();
    expect(activeListeners).toBe(1);
    send(client.socket, { type: 'subscribe', topics: [SETTINGS_TOPIC] });
    send(client.socket, { type: 'unsubscribe', topics: [SETTINGS_TOPIC] });
    send(client.socket, { type: 'unsubscribe', topics: [SETTINGS_TOPIC] });
    await Bun.sleep(10);

    const beforePublish = client.messages.length;
    bus.publish(user.id, { type: 'invalidate', topic: SETTINGS_TOPIC });
    await Bun.sleep(50);
    expect(client.messages).toHaveLength(beforePublish);

    client.socket.close();
    await client.closed;
    await Bun.sleep(10);
    expect(activeListeners).toBe(0);
    expect(() => bus.publish(user.id, { type: 'invalidate', topic: SETTINGS_TOPIC })).not.toThrow();
  });
});

describe('realtime WebSocket protocol errors', () => {
  it('reports unknown topics without closing the socket', async () => {
    const { httpUrl, wsUrl } = startServer();
    const user = await signUp(httpUrl);
    const client = connect(wsUrl, { Cookie: user.cookie });

    await client.opened;
    await client.nextMessage();
    send(client.socket, { type: 'subscribe', topics: ['unknown'] });
    expect(await client.nextMessage()).toEqual({
      type: 'error',
      error: 'Unsupported realtime topic',
      code: ERROR_CODES.UNSUPPORTED,
    });

    send(client.socket, { type: 'ping' });
    expect(await client.nextMessage()).toEqual({ type: 'pong' });
  });

  it('returns validation once and closes the second malformed message with 4400', async () => {
    const { httpUrl, wsUrl } = startServer();
    const user = await signUp(httpUrl);
    const client = connect(wsUrl, { Cookie: user.cookie });

    await client.opened;
    await client.nextMessage();
    send(client.socket, { type: 'subscribe', topics: [] });
    expect(await client.nextMessage()).toEqual({
      type: 'error',
      error: 'Invalid realtime message',
      code: ERROR_CODES.VALIDATION,
    });

    send(client.socket, '{malformed-json');
    expect(await client.nextMessage()).toEqual({
      type: 'error',
      error: 'Invalid realtime message',
      code: ERROR_CODES.VALIDATION,
    });
    expect((await client.closed).code).toBe(REALTIME_CLOSE_CODES.INVALID_MESSAGE);
  });

  it('closes unexpected handler failures with 1011', async () => {
    const { httpUrl, wsUrl } = startServer({
      ownsChat: () => Promise.reject(new Error('database unavailable')),
    });
    const user = await signUp(httpUrl);
    const client = connect(wsUrl, { Cookie: user.cookie });

    await client.opened;
    await client.nextMessage();
    send(client.socket, { type: 'subscribe', topics: [gitTopic('chat-1')] });
    expect(await client.nextMessage()).toEqual({
      type: 'error',
      error: 'Unexpected realtime server error',
      code: ERROR_CODES.INTERNAL,
    });
    expect((await client.closed).code).toBe(REALTIME_CLOSE_CODES.INTERNAL_ERROR);
  });
});

describe('realtime WebSocket limits', () => {
  it('caps user connections at eight and recovers the released slot', async () => {
    const { httpUrl, wsUrl } = startServer();
    const user = await signUp(httpUrl);
    const accepted = Array.from({ length: 8 }, () => connect(wsUrl, { Cookie: user.cookie }));

    for (const client of accepted) {
      await client.opened;
      expect(await client.nextMessage()).toEqual({ type: 'ready' });
    }

    const rejected = connect(wsUrl, { Cookie: user.cookie });
    await rejected.opened;
    expect(await rejected.nextMessage()).toEqual({
      type: 'error',
      error: 'Realtime connection limit exceeded',
      code: ERROR_CODES.RATE_LIMITED,
    });
    expect((await rejected.closed).code).toBe(REALTIME_CLOSE_CODES.RATE_LIMITED);

    accepted[0]?.socket.close();
    await accepted[0]?.closed;
    const replacement = connect(wsUrl, { Cookie: user.cookie });
    await replacement.opened;
    expect(await replacement.nextMessage()).toEqual({ type: 'ready' });
  });

  it('rejects subscription operations atomically above 64 active topics', async () => {
    const { bus, httpUrl, wsUrl } = startServer({
      ownsChat: () => Promise.resolve(true),
    });
    const user = await signUp(httpUrl);
    const client = connect(wsUrl, { Cookie: user.cookie });
    const topics = Array.from({ length: 64 }, (_, index) => gitTopic(`chat-${index}`));

    await client.opened;
    await client.nextMessage();
    send(client.socket, { type: 'subscribe', topics: topics.slice(0, 32) });
    send(client.socket, { type: 'subscribe', topics: topics.slice(32) });
    await Bun.sleep(20);

    const overflowTopics = [gitTopic('overflow-a'), gitTopic('overflow-b')];
    send(client.socket, { type: 'subscribe', topics: overflowTopics });
    expect(await client.nextMessage()).toEqual({
      type: 'error',
      error: 'Realtime subscription limit exceeded',
      code: ERROR_CODES.RATE_LIMITED,
    });

    const beforeOverflowPublish = client.messages.length;
    bus.publish(user.id, {
      type: 'invalidate',
      topic: overflowTopics[0] as string,
      scopes: ['state'],
    });
    await Bun.sleep(50);
    expect(client.messages).toHaveLength(beforeOverflowPublish);

    bus.publish(user.id, {
      type: 'invalidate',
      topic: topics[63] as string,
      scopes: ['state'],
    });
    expect(await client.nextMessage()).toEqual({
      type: 'invalidate',
      topic: topics[63],
      scopes: ['state'],
    });
  });

  it('serializes overlapping subscribe frames so jointly overflowing batches stay under 64', async () => {
    let ownershipGate: Promise<void> = Promise.resolve();
    let releaseOwnership: (() => void) | undefined;
    let gateOwnership = false;
    let ownershipStarted = 0;

    const { bus, httpUrl, wsUrl } = startServer({
      ownsChat: async () => {
        ownershipStarted += 1;
        if (gateOwnership) await ownershipGate;
        return true;
      },
    });
    const user = await signUp(httpUrl);
    const client = connect(wsUrl, { Cookie: user.cookie });
    const seeded = Array.from({ length: 16 }, (_, index) => gitTopic(`seed-${index}`));
    const firstBatch = Array.from({ length: 32 }, (_, index) => gitTopic(`first-${index}`));
    const secondBatch = Array.from({ length: 32 }, (_, index) => gitTopic(`second-${index}`));

    await client.opened;
    await client.nextMessage();
    send(client.socket, { type: 'subscribe', topics: seeded });
    await Bun.sleep(50);

    ownershipGate = new Promise<void>((resolve) => {
      releaseOwnership = resolve;
    });
    gateOwnership = true;
    ownershipStarted = 0;

    send(client.socket, { type: 'subscribe', topics: firstBatch });
    send(client.socket, { type: 'subscribe', topics: secondBatch });

    // Without per-socket serialization both frames would start ownership work
    // against the seeded topic set and both commit past 64 active topics.
    const deadline = Date.now() + 2_000;
    while (ownershipStarted < 1 && Date.now() < deadline) {
      await Bun.sleep(5);
    }
    expect(ownershipStarted).toBeGreaterThanOrEqual(1);
    expect(ownershipStarted).toBeLessThanOrEqual(32);
    releaseOwnership?.();

    expect(await client.nextMessage()).toEqual({
      type: 'error',
      error: 'Realtime subscription limit exceeded',
      code: ERROR_CODES.RATE_LIMITED,
    });

    const beforeSecondPublish = client.messages.length;
    bus.publish(user.id, {
      type: 'invalidate',
      topic: secondBatch[0] as string,
      scopes: ['state'],
    });
    await Bun.sleep(50);
    expect(client.messages).toHaveLength(beforeSecondPublish);

    bus.publish(user.id, {
      type: 'invalidate',
      topic: firstBatch[0] as string,
      scopes: ['state'],
    });
    expect(await client.nextMessage()).toEqual({
      type: 'invalidate',
      topic: firstBatch[0],
      scopes: ['state'],
    });
  });

  it('closes the twenty-first message in one second and releases the connection slot', async () => {
    const fixedTime = 10_000;
    const { httpUrl, wsUrl } = startServer({ now: () => fixedTime });
    const user = await signUp(httpUrl);
    const client = connect(wsUrl, { Cookie: user.cookie });

    await client.opened;
    await client.nextMessage();
    for (let index = 0; index < 20; index += 1) {
      send(client.socket, { type: 'ping' });
    }
    for (let index = 0; index < 20; index += 1) {
      expect(await client.nextMessage()).toEqual({ type: 'pong' });
    }

    send(client.socket, { type: 'ping' });
    expect(await client.nextMessage()).toEqual({
      type: 'error',
      error: 'Realtime message rate exceeded',
      code: ERROR_CODES.RATE_LIMITED,
    });
    expect((await client.closed).code).toBe(REALTIME_CLOSE_CODES.RATE_LIMITED);

    const replacement = connect(wsUrl, { Cookie: user.cookie });
    await replacement.opened;
    expect(await replacement.nextMessage()).toEqual({ type: 'ready' });
  });
});
