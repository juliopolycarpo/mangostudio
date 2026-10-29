import { realpathSync } from 'node:fs';

import { type Chat, ChatListSchema, ChatSchema } from '@mangostudio/shared/chat';
import { EnvironmentSchema, RuntimeLifecycleViewSchema } from '@mangostudio/shared/environments';
import { ApiErrorResponseSchema } from '@mangostudio/shared/errors';
import { RealtimeServerMessageSchema } from '@mangostudio/shared/realtime';
import { RuntimeHealthReportSchema } from '@mangostudio/shared/runtime-home';
import type { Static, TSchema } from 'typebox';
import { Check, Errors } from 'typebox/value';

import { resolveReadyBudgetMs } from './wait-for-health';

export interface ApplicationSmokeOptions {
  readonly baseUrl: string;
  readonly cookie: string;
  readonly runtimePath: string;
  readonly home: string;
  readonly version: string;
  /** Stops the current hub using host shutdown semantics, then restarts the same artifact/database. */
  readonly restart: () => Promise<void>;
  readonly request?: typeof fetch;
  readonly socket?: (url: string, cookie: string) => ApplicationSocket;
  readonly budgetMs?: number;
  readonly canonicalPath?: (path: string) => string;
  readonly platform?: NodeJS.Platform;
  readonly runtimeProcesses?: {
    baseline(): Promise<void>;
    observe(): Promise<void>;
    waitForExit(): Promise<void>;
  };
}

/** Minimal event transport, injectable without opening a real connection in unit tests. */
export interface ApplicationSocket {
  send(data: string): void;
  close(): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  addEventListener(type: 'error' | 'close', listener: () => void): void;
}

/**
 * Reject a response outside its canonical shared contract, naming the invalid value and path.
 * @example const chat = assertSmokeSchema(ChatSchema, body, 'POST /api/chats/');
 */
export function assertSmokeSchema<S extends TSchema>(
  schema: S,
  value: unknown,
  label: string
): Static<S> {
  if (!Check(schema, value)) {
    throw new Error(
      `${label}: expected canonical schema | received ${JSON.stringify(value)} | ${JSON.stringify([...Errors(schema, value)])}`
    );
  }
  return value as Static<S>;
}

/**
 * Exercise authenticated application behavior through a built hub, including a real restart.
 * The caller owns both hub lifetimes; this function always closes its WebSocket.
 * @example await smokeBinaryApplication({ baseUrl, cookie, runtimePath, home, version, restart });
 */
export async function smokeBinaryApplication(options: ApplicationSmokeOptions): Promise<void> {
  const budgetMs = options.budgetMs ?? resolveReadyBudgetMs();
  const request = options.request ?? fetch;
  // The native resolver expands Windows 8.3 aliases from runner temp paths.
  const canonicalPath = options.canonicalPath ?? realpathSync.native;
  const json = async (
    path: string,
    method = 'GET',
    body?: unknown,
    status = 200
  ): Promise<unknown> => {
    const response = await request(`${options.baseUrl}${path}`, {
      method,
      headers: { Cookie: options.cookie, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(budgetMs),
    });
    if (response.status !== status) {
      throw new Error(`${method} ${path}: expected status ${status} | received ${response.status}`);
    }
    return response.json();
  };
  const invalid = assertSmokeSchema(
    ApiErrorResponseSchema,
    await json('/api/chats/', 'POST', { title: 123 }, 422),
    'invalid chat'
  );
  if (invalid.code !== 'VALIDATION' || invalid.error !== 'Invalid request body') {
    throw new Error(
      `invalid chat: expected 422 VALIDATION Invalid request body | received ${JSON.stringify(invalid)}`
    );
  }
  const socket: ApplicationSocket = options.socket
    ? options.socket(`${options.baseUrl.replace(/^http/, 'ws')}/api/ws`, options.cookie)
    : new WebSocket(`${options.baseUrl.replace(/^http/, 'ws')}/api/ws`, {
        headers: { Cookie: options.cookie },
      });
  const messages: Record<string, unknown>[] = [];
  let socketFailure: string | undefined;
  socket.addEventListener('message', (event) => {
    try {
      if (typeof event.data !== 'string') throw new Error('not text');
      const value: unknown = JSON.parse(event.data);
      if (typeof value !== 'object' || value === null || Array.isArray(value))
        throw new Error('not an object');
      messages.push(
        assertSmokeSchema(RealtimeServerMessageSchema, value, 'WebSocket frame') as Record<
          string,
          unknown
        >
      );
    } catch (error) {
      socketFailure = `malformed JSON object ${JSON.stringify(event.data)}: ${String(error)}`;
    }
  });
  socket.addEventListener('error', () => {
    socketFailure = 'transport error';
  });
  socket.addEventListener('close', () => {
    socketFailure = 'connection closed';
  });
  const next = async (type: string): Promise<Record<string, unknown>> => {
    const deadline = performance.now() + budgetMs;
    while (performance.now() < deadline) {
      if (socketFailure) throw new Error(`WebSocket: expected ${type} | received ${socketFailure}`);
      const index = messages.findIndex((message) => message.type === type);
      const message = index !== -1 ? messages.splice(index, 1)[0] : undefined;
      if (message) return message;
      await Bun.sleep(10);
    }
    throw new Error(
      `WebSocket: expected ${type} within ${budgetMs}ms | received ${JSON.stringify(messages)}`
    );
  };
  let chat: Chat;
  try {
    await next('ready');
    socket.send(JSON.stringify({ type: 'ping' }));
    await next('pong');
    socket.send(JSON.stringify({ type: 'subscribe', topics: ['activity'] }));
    const subscribed = await next('subscribed');
    if (!Array.isArray(subscribed.topics) || !subscribed.topics.includes('activity')) {
      throw new Error(
        `WebSocket: expected activity subscription | received ${JSON.stringify(subscribed)}`
      );
    }
    chat = assertSmokeSchema(
      ChatSchema,
      await json('/api/chats/', 'POST', { title: 'Binary smoke persistence' }),
      'created chat'
    );
    const activity = await next('invalidate');
    if (activity.topic !== 'activity')
      throw new Error(
        `WebSocket: expected activity invalidation | received ${JSON.stringify(activity)}`
      );
  } finally {
    socket.close();
  }
  const updatedTitle = 'Binary smoke updated';
  const updated = await json(`/api/chats/${chat.id}`, 'PUT', { title: updatedTitle });
  assertSuccess(updated, 'update chat');
  const requireStoredChat = async (): Promise<void> => {
    const chats = assertSmokeSchema(ChatListSchema, await json('/api/chats/'), 'chat list');
    if (!chats.some((item) => item.id === chat.id && item.title === updatedTitle)) {
      throw new Error(
        `chat list: expected persisted ${chat.id} with title ${updatedTitle} | received ${JSON.stringify(chats)}`
      );
    }
  };
  await requireStoredChat();
  await options.runtimeProcesses?.baseline();
  const connected = assertSmokeSchema(
    EnvironmentSchema,
    await json('/api/environments/local/connect', 'POST'),
    'Local connect'
  );
  const manifest = connected?.status?.manifest;
  const fingerprint = manifest?.implementation?.fingerprint;
  if (
    connected?.id !== 'local' ||
    connected.status?.state !== 'connected' ||
    connected.status.runtimeVersion !== options.version ||
    manifest?.platform !== process.platform ||
    manifest.arch !== process.arch ||
    !fingerprint ||
    !/^[a-f0-9]{64}$/.test(fingerprint)
  ) {
    throw new Error(
      `Local connect: expected connected local ${process.platform}/${process.arch} v${options.version} with implementation fingerprint | received ${JSON.stringify(connected)}`
    );
  }
  const runtime = assertSmokeSchema(
    RuntimeLifecycleViewSchema,
    await json('/api/environments/local/runtime'),
    'Local runtime'
  );
  const health = assertSmokeSchema(
    RuntimeHealthReportSchema,
    runtime?.health,
    'Local runtime health'
  );
  if (
    runtime.stale !== false ||
    runtime.implementation?.fingerprint !== fingerprint ||
    health.platform !== process.platform ||
    health.arch !== process.arch ||
    health.runtimeVersion !== options.version ||
    !health.binaryPath ||
    canonicalPath(health.binaryPath) !== canonicalPath(options.runtimePath) ||
    canonicalPath(health.homeDir) !== canonicalPath(options.home)
  ) {
    throw new Error(
      `Local health: expected fresh sibling runtime ${options.runtimePath}, home ${options.home}, ${process.platform}/${process.arch} v${options.version} and matching fingerprint | received ${JSON.stringify(runtime)}`
    );
  }
  await options.runtimeProcesses?.observe();
  // Windows SIGTERM terminates the hub immediately; release its Local child over the API first.
  if ((options.platform ?? process.platform) === 'win32') {
    const disconnected = assertSmokeSchema(
      EnvironmentSchema,
      await json('/api/environments/local/disconnect', 'POST'),
      'Local disconnect'
    );
    if (disconnected?.status?.state !== 'disconnected')
      throw new Error(
        `Local disconnect: expected disconnected | received ${JSON.stringify(disconnected)}`
      );
    await options.runtimeProcesses?.waitForExit();
  }
  await options.restart();
  await requireStoredChat();
  assertSuccess(await json(`/api/chats/${chat.id}`, 'DELETE'), 'delete chat');
  const remaining = assertSmokeSchema(
    ChatListSchema,
    await json('/api/chats/'),
    'chat list after delete'
  );
  if (remaining.some((item) => item.id === chat.id))
    throw new Error(
      `chat list: expected ${chat.id} absent after delete | received ${JSON.stringify(remaining)}`
    );
}

/** Require the route's explicit mutation acknowledgement. */
function assertSuccess(value: unknown, label: string): void {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('success' in value) ||
    value.success !== true
  ) {
    throw new Error(`${label}: expected success true | received ${JSON.stringify(value)}`);
  }
}
