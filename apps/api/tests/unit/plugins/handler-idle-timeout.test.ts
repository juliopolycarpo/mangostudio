import { describe, expect, it } from 'bun:test';

import { Elysia } from 'elysia';

import {
  HUB_HANDLER_IDLE_TIMEOUT_SECONDS,
  HUB_IDLE_TIMEOUT_SECONDS,
} from '../../../src/lib/hub-connection-limits';
import { handlerIdleTimeout } from '../../../src/plugins/handler-idle-timeout';

/** Named fake for the Bun server: records every `server.timeout(request, seconds)` call. */
class RecordingServer {
  readonly calls: Array<{ path: string; seconds: number }> = [];

  timeout(request: Request, seconds: number): void {
    this.calls.push({ path: new URL(request.url).pathname, seconds });
  }

  /** The rate limiter on the real app reads the peer address. */
  requestIP(): { address: string } {
    return { address: '127.0.0.1' };
  }
}

/** The way Bun hands the server to Elysia: `fetch(request, server)`. */
function serve(
  app: { fetch: unknown },
  server: RecordingServer | null,
  request: Request
): Promise<Response> {
  return (app.fetch as (request: Request, server: unknown) => Promise<Response>)(request, server);
}

function buildApp() {
  return new Elysia({ prefix: '/api' })
    .use(handlerIdleTimeout)
    .get('/ok', () => 'ok')
    .get('/boom', () => {
      throw new Error('boom');
    })
    .post('/echo', ({ body }) => body);
}

describe('handlerIdleTimeout', () => {
  it('extends the request for the handler and restores the default after it answers', async () => {
    const server = new RecordingServer();
    const response = await serve(buildApp(), server, new Request('http://hub.test/api/ok'));

    expect(response.status).toBe(200);
    expect(server.calls).toEqual([
      { path: '/api/ok', seconds: HUB_HANDLER_IDLE_TIMEOUT_SECONDS },
      { path: '/api/ok', seconds: HUB_IDLE_TIMEOUT_SECONDS },
    ]);
  });

  it('restores the default when the handler throws', async () => {
    const server = new RecordingServer();
    const response = await serve(buildApp(), server, new Request('http://hub.test/api/boom'));

    expect(response.status).toBe(500);
    expect(server.calls.map((call) => call.seconds)).toEqual([
      HUB_HANDLER_IDLE_TIMEOUT_SECONDS,
      HUB_IDLE_TIMEOUT_SECONDS,
    ]);
  });

  it('extends a route that declares nothing, with a body', async () => {
    const server = new RecordingServer();
    const response = await serve(
      buildApp(),
      server,
      new Request('http://hub.test/api/echo', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ a: 1 }),
      })
    );

    expect(response.status).toBe(200);
    expect(server.calls[0]).toEqual({
      path: '/api/echo',
      seconds: HUB_HANDLER_IDLE_TIMEOUT_SECONDS,
    });
  });

  it('leaves a websocket upgrade request alone', async () => {
    const server = new RecordingServer();
    await serve(
      buildApp(),
      server,
      new Request('http://hub.test/api/ok', { headers: { upgrade: 'websocket' } })
    );

    expect(server.calls).toEqual([]);
  });

  it('covers a mounted child plugin but not a route the outer app adds after it', async () => {
    const childRoutes = new Elysia().get('/child', () => 'child');
    const api = new Elysia({ prefix: '/api' }).use(handlerIdleTimeout).use(childRoutes);
    const outer = new Elysia().use(api).get('/frontend-asset', () => 'asset');
    const server = new RecordingServer();

    await serve(outer, server, new Request('http://hub.test/api/child'));
    await serve(outer, server, new Request('http://hub.test/frontend-asset'));

    expect(server.calls.map((call) => call.path)).toEqual(['/api/child', '/api/child']);
  });

  it('is mounted on the real /api app, so a route nobody annotated is covered', async () => {
    const { app } = await import('../../../src/app');
    const server = new RecordingServer();
    const response = await serve(app, server, new Request('http://hub.test/api/health'));

    expect(response.status).toBe(200);
    expect(server.calls).toEqual([
      { path: '/api/health', seconds: HUB_HANDLER_IDLE_TIMEOUT_SECONDS },
      { path: '/api/health', seconds: HUB_IDLE_TIMEOUT_SECONDS },
    ]);
  });

  it('does nothing when there is no server, as under app.handle()', async () => {
    const response = await serve(buildApp(), null, new Request('http://hub.test/api/ok'));

    expect(response.status).toBe(200);
  });
});
