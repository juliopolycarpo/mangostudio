import { type Chat, ChatSchema } from '@mangostudio/shared/chat';
import { RUNTIME_CONSENT_PRESETS } from '@mangostudio/shared/runtime-home';
import { Create } from 'typebox/value';

import type {
  ApplicationSmokeOptions,
  ApplicationSocket,
} from '../../lib/binary-application-smoke';

export type ApplicationFault =
  | 'none'
  | 'bad-title'
  | 'bad-list'
  | 'wrong-error'
  | 'lost-database'
  | 'wrong-runtime'
  | 'missing-pong'
  | 'wrong-activity'
  | 'bad-json'
  | 'closed'
  | 'bad-subscription'
  | 'bad-update'
  | 'bad-delete'
  | 'retained-chat';

/** Named transport fake: emits protocol frames in response to the actual triggering send/create. */
export class FakeApplicationSocket implements ApplicationSocket {
  private message?: (event: { data: unknown }) => void;
  private closed?: () => void;
  isClosed = false;
  constructor(private readonly fault: ApplicationFault) {}
  addEventListener(
    type: 'message' | 'error' | 'close',
    listener: ((event: { data: unknown }) => void) | (() => void)
  ): void {
    if (type === 'close') this.closed = listener as () => void;
    if (type !== 'message') return;
    this.message = listener as (event: { data: unknown }) => void;
    queueMicrotask(() => {
      if (this.fault === 'closed') this.closed?.();
      else if (this.fault === 'bad-json') this.message?.({ data: 'not json' });
      else this.emit({ type: 'ready' });
    });
  }
  send(data: string): void {
    const frame = JSON.parse(data) as { type: string; topics?: string[] };
    if (frame.type === 'ping' && this.fault !== 'missing-pong') this.emit({ type: 'pong' });
    if (frame.type === 'subscribe')
      this.emit({
        type: 'subscribed',
        topics: this.fault === 'bad-subscription' ? ['settings'] : frame.topics,
      });
  }
  emit(frame: unknown): void {
    this.message?.({ data: JSON.stringify(frame) });
  }
  close(): void {
    this.isClosed = true;
  }
}

/** Fake API retains its database across restart; faults alter only the behavior named by the test. */
export class FakeBinaryApplication {
  readonly socket: FakeApplicationSocket;
  readonly requests: string[] = [];
  readonly events: string[] = [];
  chat: Chat | undefined;
  restarted = false;
  constructor(readonly fault: ApplicationFault = 'none') {
    this.socket = new FakeApplicationSocket(fault);
  }
  readonly request = ((input: string | URL | Request, init?: RequestInit): Promise<Response> =>
    Promise.resolve(this.respond(input, init))) as typeof fetch;
  private respond(input: string | URL | Request, init?: RequestInit): Response {
    const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
    const method = init?.method ?? 'GET';
    this.requests.push(`${method} ${path}`);
    if (new Headers(init?.headers).get('Cookie') !== 'session=fake')
      throw new Error('expected authenticated request');
    if (!init?.signal) throw new Error('expected request deadline');
    if (init?.body !== undefined && typeof init.body !== 'string')
      throw new Error('expected JSON string body');
    const body = init?.body ? (JSON.parse(init.body) as { title: unknown }) : undefined;
    if (method === 'POST' && path === '/api/chats/' && body?.title === 123)
      return Response.json(
        {
          error: 'Invalid request body',
          code: this.fault === 'wrong-error' ? 'UNKNOWN' : 'VALIDATION',
        },
        { status: 422 }
      );
    if (method === 'POST' && path === '/api/chats/') {
      this.chat = { ...Create(ChatSchema), id: 'fixture-chat', title: 'Binary smoke persistence' };
      this.socket.emit({
        type: 'invalidate',
        topic: this.fault === 'wrong-activity' ? 'settings' : 'activity',
      });
      return Response.json(this.fault === 'bad-title' ? { ...this.chat, title: 123 } : this.chat);
    }
    if (method === 'PUT' && path === '/api/chats/fixture-chat') {
      if (this.chat) this.chat.title = String(body?.title);
      return Response.json({ success: this.fault !== 'bad-update' });
    }
    if (method === 'DELETE' && path === '/api/chats/fixture-chat') {
      if (this.fault !== 'retained-chat') this.chat = undefined;
      return Response.json({ success: this.fault !== 'bad-delete' });
    }
    if (method === 'GET' && path === '/api/chats/')
      return Response.json(this.fault === 'bad-list' ? {} : this.chat ? [this.chat] : []);
    const fingerprint = 'a'.repeat(64);
    if (method === 'POST' && path === '/api/environments/local/connect')
      return Response.json({
        id: 'local',
        status: {
          state: 'connected',
          runtimeVersion: '1.2.3',
          manifest: {
            platform: process.platform,
            arch: process.arch,
            implementation: { fingerprint },
          },
        },
      });
    if (method === 'GET' && path === '/api/environments/local/runtime')
      return Response.json({
        stale: false,
        implementation: { fingerprint },
        health: {
          schemaVersion: 1,
          slot: 'host',
          source: 'bundled',
          version: null,
          digest: null,
          profile: 'full',
          allow: RUNTIME_CONSENT_PRESETS.full,
          setup: { state: 'configured' },
          shells: [],
          git: { available: false },
          lastError: null,
          platform: process.platform,
          arch: process.arch,
          runtimeVersion: '1.2.3',
          binaryPath: this.fault === 'wrong-runtime' ? '/checkout/runtime' : '/artifact/runtime',
          homeDir: '/isolated/home',
        },
      });
    if (method === 'POST' && path === '/api/environments/local/disconnect') {
      this.events.push('disconnect');
      return Response.json({ status: { state: 'disconnected' } });
    }
    throw new Error(`unexpected fake API request: ${method} ${path}`);
  }
  readonly restart = (): Promise<void> => {
    if (!this.socket.isClosed) throw new Error('expected WebSocket closed before restart');
    this.events.push('restart');
    this.restarted = true;
    if (this.fault === 'lost-database') this.chat = undefined;
    return Promise.resolve();
  };
  /** Supply all external I/O without launching a server. @example await smokeBinaryApplication(fake.options()); */
  options(): ApplicationSmokeOptions {
    return {
      baseUrl: 'http://127.0.0.1:12345',
      cookie: 'session=fake',
      home: '/isolated/home',
      runtimePath: '/artifact/runtime',
      version: '1.2.3',
      budgetMs: 30,
      request: this.request,
      socket: () => this.socket,
      restart: this.restart,
      canonicalPath: (path) => path,
      platform: 'linux',
      runtimeProcesses: {
        observe: () => {
          this.events.push('observe');
          return Promise.resolve();
        },
        waitForExit: () => {
          this.events.push('runtime-exited');
          return Promise.resolve();
        },
      },
    };
  }
}
