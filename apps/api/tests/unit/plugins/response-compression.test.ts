/**
 * When the hub gzips a JSON answer, and when it must not.
 *
 * Each rule has a request that would be compressed if the rule were missing, so
 * a test fails for the rule it names and not for an incidental setup error.
 * `FakeRemoteClient` stands in for a browser on another machine: it picks the
 * socket peer the plugin sees through the plugin's own `peerAddress` seam, since
 * `app.handle()` has no socket. One test at the end goes through a real socket.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { networkInterfaces } from 'node:os';

import { Elysia } from 'elysia';

import {
  COMPRESSION_MIN_BYTES,
  NEVER_COMPRESSED_PREFIXES,
  responseCompression,
} from '../../../src/plugins/response-compression';

const REMOTE_PEER = '192.168.1.50';
const LOOPBACK_PEER = '127.0.0.1';
const PEER_HEADER = 'x-fake-peer';

/** A JSON payload comfortably over the threshold that compresses well. */
const LARGE_PAYLOAD = {
  rows: Array.from({ length: 400 }, (_, index) => ({ id: index, title: `chat number ${index}` })),
};
const SMALL_PAYLOAD = { ok: true, note: 'tiny' };
const LARGE_JSON_BYTES = JSON.stringify(LARGE_PAYLOAD).length;

function buildApp() {
  return new Elysia({ prefix: '/api' })
    .use(
      responseCompression({
        peerAddress: (request) => request.headers.get(PEER_HEADER) ?? undefined,
      })
    )
    .onRequest(({ set }) => {
      // A CORS-style header the plugin must keep and extend, never replace.
      set.headers.vary = 'Origin';
    })
    .get('/large', () => LARGE_PAYLOAD)
    .get('/small', () => SMALL_PAYLOAD)
    .get('/list', () => LARGE_PAYLOAD.rows)
    .get('/stream', () => {
      const body = `data: ${'x'.repeat(COMPRESSION_MIN_BYTES * 2)}\n\n`;
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    })
    .get('/encoded', ({ set }) => {
      set.headers['content-encoding'] = 'br';
      return LARGE_PAYLOAD;
    })
    .get('/no-transform', ({ set }) => {
      set.headers['cache-control'] = 'no-transform';
      return LARGE_PAYLOAD;
    })
    .get('/failing', ({ set }) => {
      set.status = 500;
      return { error: 'boom', detail: 'x'.repeat(COMPRESSION_MIN_BYTES * 2) };
    })
    .get('/etagged', ({ set }) => {
      set.headers.etag = '"abc123"';
      return LARGE_PAYLOAD;
    })
    .get('/auth/session', () => LARGE_PAYLOAD)
    .get('/api-keys', () => LARGE_PAYLOAD)
    .get('/environments/pairing', () => LARGE_PAYLOAD)
    .get('/settings/connectors', () => LARGE_PAYLOAD)
    .get('/settings/secrets/gemini', () => LARGE_PAYLOAD)
    .head('/large', () => LARGE_PAYLOAD)
    .post('/large', () => LARGE_PAYLOAD);
}

type App = ReturnType<typeof buildApp>;

/** A browser on another machine: names its address and its `Accept-Encoding`. */
class FakeRemoteClient {
  constructor(
    private readonly app: App,
    private readonly peer: string | null = REMOTE_PEER
  ) {}

  request(path: string, init: { method?: string; acceptEncoding?: string | null } = {}) {
    const headers = new Headers();
    if (this.peer !== null) headers.set(PEER_HEADER, this.peer);
    const acceptEncoding =
      init.acceptEncoding === undefined ? 'gzip, deflate' : init.acceptEncoding;
    if (acceptEncoding !== null) headers.set('accept-encoding', acceptEncoding);
    return this.app.handle(
      new Request(`http://hub.test/api${path}`, { method: init.method, headers })
    );
  }
}

const apps: App[] = [];
function remoteClient(peer: string | null = REMOTE_PEER): FakeRemoteClient {
  const app = buildApp();
  apps.push(app);
  return new FakeRemoteClient(app, peer);
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.stop()));
});

describe('response compression', () => {
  it('gzips a large JSON body for a remote peer that accepts gzip, and the bytes round-trip', async () => {
    const response = await remoteClient().request('/large');
    const wire = new Uint8Array(await response.arrayBuffer());

    expect(response.headers.get('content-encoding')).toBe('gzip');
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.headers.get('content-length')).toBe(String(wire.byteLength));
    expect(wire.byteLength).toBeLessThan(LARGE_JSON_BYTES / 2);
    expect(JSON.parse(new TextDecoder().decode(Bun.gunzipSync(wire)))).toEqual(LARGE_PAYLOAD);
  });

  it('compresses a top-level array the same way', async () => {
    const response = await remoteClient().request('/list');
    expect(response.headers.get('content-encoding')).toBe('gzip');
    const body = JSON.parse(new TextDecoder().decode(Bun.gunzipSync(await response.arrayBuffer())));
    expect(body).toEqual(LARGE_PAYLOAD.rows);
  });

  it('adds Accept-Encoding to the Vary the request already carries', async () => {
    const response = await remoteClient().request('/large');
    expect(response.headers.get('vary')).toBe('Origin, Accept-Encoding');
  });

  it('leaves a body below the threshold alone but still varies on Accept-Encoding', async () => {
    const response = await remoteClient().request('/small');
    expect(response.headers.get('content-encoding')).toBeNull();
    expect(await response.json()).toEqual(SMALL_PAYLOAD);
    expect(response.headers.get('vary')).toBe('Origin, Accept-Encoding');
  });

  it.each([LOOPBACK_PEER, '::1', '::ffff:127.0.0.1'])(
    'never compresses for the loopback peer %s',
    async (peer) => {
      const response = await remoteClient(peer).request('/large');
      expect(response.headers.get('content-encoding')).toBeNull();
      expect(response.headers.get('vary')).toBe('Origin');
      expect(await response.json()).toEqual(LARGE_PAYLOAD);
    }
  );

  it('treats an unknown peer as local', async () => {
    const response = await remoteClient(null).request('/large');
    expect(response.headers.get('content-encoding')).toBeNull();
  });

  it('does not touch an SSE stream, however large the frame', async () => {
    const response = await remoteClient().request('/stream');
    expect(response.headers.get('content-encoding')).toBeNull();
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect(await response.text()).toStartWith('data: xxx');
  });

  it.each([
    ['no Accept-Encoding header', null],
    ['identity only', 'identity'],
    ['a coding the hub does not produce', 'br, zstd'],
    ['gzip refused with q=0', 'gzip;q=0'],
  ])('sends identity for %s', async (_label, acceptEncoding) => {
    const response = await remoteClient().request('/large', { acceptEncoding });
    expect(response.headers.get('content-encoding')).toBeNull();
    expect(await response.json()).toEqual(LARGE_PAYLOAD);
    expect(response.headers.get('vary')).toBe('Origin, Accept-Encoding');
  });

  it('accepts gzip offered among other codings and as x-gzip', async () => {
    for (const acceptEncoding of ['deflate, gzip;q=0.8, br', 'x-gzip', '*']) {
      const response = await remoteClient().request('/large', { acceptEncoding });
      expect(response.headers.get('content-encoding')).toBe('gzip');
    }
  });

  it('keeps a response that already names a Content-Encoding', async () => {
    const response = await remoteClient().request('/encoded');
    expect(response.headers.get('content-encoding')).toBe('br');
  });

  it('honours Cache-Control: no-transform', async () => {
    const response = await remoteClient().request('/no-transform');
    expect(response.headers.get('content-encoding')).toBeNull();
  });

  it('answers HEAD without compressing', async () => {
    const response = await remoteClient().request('/large', { method: 'HEAD' });
    expect(response.headers.get('content-encoding')).toBeNull();
    expect(response.headers.get('vary')).toBe('Origin');
  });

  it('does not compress a non-GET method', async () => {
    const response = await remoteClient().request('/large', { method: 'POST' });
    expect(response.headers.get('content-encoding')).toBeNull();
  });

  it('does not compress an error response', async () => {
    const response = await remoteClient().request('/failing');
    expect(response.status).toBe(500);
    expect(response.headers.get('content-encoding')).toBeNull();
    expect(((await response.json()) as { error: string }).error).toBe('boom');
  });

  it('weakens a strong ETag the route sent, since the bytes differ from identity', async () => {
    const response = await remoteClient().request('/etagged');
    expect(response.headers.get('content-encoding')).toBe('gzip');
    expect(response.headers.get('etag')).toBe('W/"abc123"');
  });

  it('keeps a strong ETag when the body goes out as identity', async () => {
    const response = await remoteClient().request('/etagged', { acceptEncoding: null });
    expect(response.headers.get('etag')).toBe('"abc123"');
  });

  it.each([
    '/auth/session',
    '/api-keys',
    '/environments/pairing',
    '/settings/connectors',
    '/settings/secrets/gemini',
  ])('opts credential-bearing path %s out of compression', async (path) => {
    const response = await remoteClient().request(path);
    expect(response.headers.get('content-encoding')).toBeNull();
    expect(await response.json()).toEqual(LARGE_PAYLOAD);
  });

  it('lists exactly the credential prefixes the routes above exercise', () => {
    expect([...NEVER_COMPRESSED_PREFIXES].sort()).toEqual([
      '/api/api-keys',
      '/api/auth',
      '/api/environments',
      '/api/settings/connectors',
      '/api/settings/secrets',
    ]);
  });
});

describe('response compression through a real socket', () => {
  const lanAddress = Object.values(networkInterfaces())
    .flat()
    .find((entry) => entry?.family === 'IPv4' && !entry.internal)?.address;

  it('uses the socket peer: identity over loopback, gzip from the host LAN address', async () => {
    // No `peerAddress` override: this is the default wiring to `server.requestIP`.
    const app = new Elysia({ prefix: '/api' })
      .use(responseCompression())
      .get('/large', () => LARGE_PAYLOAD)
      .listen({ port: 0, hostname: '0.0.0.0' });
    apps.push(app as unknown as App);
    const port = app.server?.port;

    const viaLoopback = await fetch(`http://127.0.0.1:${port}/api/large`, {
      headers: { 'accept-encoding': 'gzip' },
      decompress: false,
    } as RequestInit);
    expect(viaLoopback.headers.get('content-encoding')).toBeNull();

    if (lanAddress === undefined) return; // A host with no external interface cannot show the remote half.
    const viaLan = await fetch(`http://${lanAddress}:${port}/api/large`, {
      headers: { 'accept-encoding': 'gzip' },
      decompress: false,
    } as RequestInit);
    expect(viaLan.headers.get('content-encoding')).toBe('gzip');
  });
});
