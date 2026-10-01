/**
 * Embedded frontend, precompressed representations: `Accept-Encoding`
 * negotiation, the headers each representation carries, and the paths that must
 * stay untouched.
 *
 * Every request goes through a raw `node:http` client against a real listener.
 * Bun's `fetch` advertises `gzip, deflate, br, zstd` on its own and decodes the
 * body before the test sees it, so a `fetch`-based assertion would pass whether
 * or not the server picked the representation the test meant to ask for.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliCompressSync, brotliDecompressSync, gunzipSync, gzipSync } from 'node:zlib';
import { cors } from '@elysia/cors';
import { Elysia, NotFound } from 'elysia';
import type { App } from '../../../src/app';
import { contentEtag } from '../../../src/lib/http-cache';
import { createUploadedFileRoutes } from '../../../src/routes/uploaded-files';
import {
  type EmbeddedFrontendEncodings,
  registerEmbeddedFrontend,
  resetEmbeddedFrontend,
} from '../../../src/server/embedded-frontend';
import { clearFrontendFallback, frontendNotFound } from '../../../src/server/frontend-fallback';
import { registerFrontend } from '../../../src/server/frontend-static';

const INDEX_HTML = `<!doctype html><html><body>${'<p>embedded shell</p>'.repeat(40)}</body></html>`;
const MAIN_JS = 'console.log("embedded main chunk");\n'.repeat(60);
const GZIP_ONLY_JS = 'console.log("embedded gzip-only chunk");\n'.repeat(60);
const PLAIN_JS = 'console.log("embedded chunk with no variants");\n'.repeat(60);
const CONFIG_JS = `window.__MANGO_CONFIG__ = { apiUrl: "" };\n${'// padding\n'.repeat(40)}`;
const FONT_BYTES = 'not-really-a-font';

const MAIN_URL = '/assets/main-AbCd1234.js';
const GZIP_ONLY_URL = '/assets/gzipOnly-AbCd1234.js';
const PLAIN_URL = '/assets/plain-AbCd1234.js';

interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

interface EncodingServer {
  send: (path: string, headers?: Record<string, string>, method?: string) => Promise<RawResponse>;
  stop: () => Promise<void>;
  uploadsDir: string;
}

let fixtureDir: string;
let server: EncodingServer | null = null;

/** Writes `content` and returns its path. */
function writeFixture(name: string, content: string | Uint8Array): string {
  const path = join(fixtureDir, name);
  writeFileSync(path, content);
  return path;
}

function raw(
  port: number,
  path: string,
  headers: Record<string, string>,
  method: string
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () =>
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks),
        })
      );
    });
    req.on('error', reject);
    req.end();
  });
}

/** Writes the identity file plus its gzip and/or Brotli copy; returns the files and encodings entry. */
function fixtureWithVariants(
  name: string,
  content: string,
  codings: readonly ('br' | 'gzip')[]
): { identity: string; encodings: Record<string, string> } {
  const encodings: Record<string, string> = {};
  if (codings.includes('gzip')) encodings.gzip = writeFixture(`${name}.gz`, gzipSync(content));
  if (codings.includes('br'))
    encodings.br = writeFixture(`${name}.br`, brotliCompressSync(content));
  return { identity: writeFixture(name, content), encodings };
}

async function startServer(): Promise<EncodingServer> {
  const index = fixtureWithVariants('index.html', INDEX_HTML, ['br', 'gzip']);
  const main = fixtureWithVariants('main.js', MAIN_JS, ['br', 'gzip']);
  const gzipOnly = fixtureWithVariants('gzipOnly.js', GZIP_ONLY_JS, ['gzip']);
  const config = fixtureWithVariants('config.js', CONFIG_JS, ['gzip']);
  const encodings: Record<string, Record<string, string>> = {
    '/index.html': index.encodings,
    [MAIN_URL]: main.encodings,
    [GZIP_ONLY_URL]: gzipOnly.encodings,
    '/config.js': config.encodings,
  };
  registerEmbeddedFrontend(
    {
      '/index.html': index.identity,
      [MAIN_URL]: main.identity,
      [GZIP_ONLY_URL]: gzipOnly.identity,
      [PLAIN_URL]: writeFixture('plain.js', PLAIN_JS),
      '/config.js': config.identity,
      '/fonts/inter.woff2': writeFixture('inter.woff2', FONT_BYTES),
    },
    encodings as EmbeddedFrontendEncodings
  );

  const uploadsDir = mkdtempSync(join(tmpdir(), 'encoding-uploads-'));
  writeFileSync(join(uploadsDir, 'note.txt'), 'x'.repeat(2000));
  // Seated like `app.ts`: CORS echoes the origin with `Vary: Origin` before the
  // frontend answers, and the fallback receives Elysia's accumulated headers.
  const app = new Elysia()
    .use(cors({ origin: () => true }))
    .error(NotFound, ({ request: req, set }) => frontendNotFound(req, set));
  app.get('/api/probe', () => ({ ok: true, padding: 'x'.repeat(2000) }));
  app.use(createUploadedFileRoutes(uploadsDir));
  registerFrontend(app as unknown as App, '/nonexistent-frontend-dir');
  await app.modules;
  app.listen({ hostname: '127.0.0.1', port: 0, reusePort: false });
  const port = app.server?.port as number;

  return {
    uploadsDir,
    send: (path, headers = {}, method = 'GET') => raw(port, path, headers, method),
    stop: async () => {
      await app.stop();
      rmSync(uploadsDir, { recursive: true, force: true });
    },
  };
}

beforeEach(async () => {
  fixtureDir = mkdtempSync(join(tmpdir(), 'encoding-frontend-'));
  server = await startServer();
});

afterEach(async () => {
  await server?.stop();
  server = null;
  resetEmbeddedFrontend();
  clearFrontendFallback();
  rmSync(fixtureDir, { recursive: true, force: true });
});

function send(path: string, headers?: Record<string, string>, method?: string) {
  return (server as EncodingServer).send(path, headers, method);
}

/** The `Vary` directives a response lists. CORS contributes `Origin`; the point is `Accept-Encoding`. */
function varyDirectives(response: RawResponse): string[] {
  const vary = response.headers.vary;
  const value = Array.isArray(vary) ? vary.join(',') : (vary ?? '');
  return value
    .split(',')
    .map((directive) => directive.trim())
    .filter(Boolean);
}

/** The body as text, decoded the way the `Content-Encoding` header says. */
function decode(response: RawResponse): string {
  const encoding = response.headers['content-encoding'];
  if (encoding === 'br') return brotliDecompressSync(response.body).toString();
  if (encoding === 'gzip') return gunzipSync(response.body).toString();
  return response.body.toString();
}

describe('embedded asset negotiation', () => {
  test.each([
    ['gzip', 'gzip'],
    ['br', 'br'],
    ['gzip, br', 'br'],
    ['br;q=0.5, gzip;q=0.9', 'gzip'],
    ['gzip;q=0, br', 'br'],
    ['*', 'br'],
    ['*;q=0.5, br;q=0', 'gzip'],
    ['GZIP', 'gzip'],
    ['x-gzip', 'gzip'],
  ])('answers Accept-Encoding %p with %p', async (header, coding) => {
    const response = await send(MAIN_URL, { 'Accept-Encoding': header });

    expect(response.status).toBe(200);
    expect(response.headers['content-encoding']).toBe(coding);
    expect(decode(response)).toBe(MAIN_JS);
  });

  test.each([
    ['no header', undefined],
    ['an empty header', ''],
    ['identity', 'identity'],
    ['only an unsupported coding', 'zstd, deflate'],
    ['every supported coding refused', 'gzip;q=0, br;q=0'],
    ['identity ranked above gzip', 'identity, gzip;q=0.5'],
    ['a garbled header', ';;q=, gzip;q=banana'],
  ])('answers identity for %s', async (_label, header) => {
    const response = await send(
      MAIN_URL,
      header === undefined ? {} : { 'Accept-Encoding': header }
    );

    expect(response.status).toBe(200);
    expect(response.headers['content-encoding']).toBeUndefined();
    expect(response.body.toString()).toBe(MAIN_JS);
  });

  test('answers 406 when the client refuses identity and every coding on offer', async () => {
    for (const header of ['identity;q=0', '*;q=0', 'identity;q=0, deflate']) {
      const response = await send(MAIN_URL, { 'Accept-Encoding': header });

      expect(response.status).toBe(406);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(varyDirectives(response)).toContain('Accept-Encoding');
      expect(response.headers['content-encoding']).toBeUndefined();
    }
  });

  test('still serves a coding the client names while refusing identity', async () => {
    const response = await send(MAIN_URL, { 'Accept-Encoding': 'identity;q=0, gzip' });

    expect(response.status).toBe(200);
    expect(response.headers['content-encoding']).toBe('gzip');
  });

  test('falls back to identity when the preferred variant was never built', async () => {
    const response = await send(GZIP_ONLY_URL, { 'Accept-Encoding': 'br' });

    expect(response.status).toBe(200);
    expect(response.headers['content-encoding']).toBeUndefined();
    expect(varyDirectives(response)).toContain('Accept-Encoding');
    expect(response.body.toString()).toBe(GZIP_ONLY_JS);

    const gzip = await send(GZIP_ONLY_URL, { 'Accept-Encoding': 'br, gzip' });
    expect(gzip.headers['content-encoding']).toBe('gzip');
  });

  test('negotiates the shell and the runtime config like any other asset', async () => {
    const shell = await send('/', { 'Accept-Encoding': 'br' });
    expect(shell.headers['content-encoding']).toBe('br');
    expect(shell.headers['cache-control']).toBe('no-cache');
    expect(shell.headers['content-type']).toBe('text/html');
    expect(decode(shell)).toBe(INDEX_HTML);

    const spa = await send('/settings', { 'Accept-Encoding': 'gzip' });
    expect(spa.headers['content-encoding']).toBe('gzip');
    expect(decode(spa)).toBe(INDEX_HTML);

    const config = await send('/config.js', { 'Accept-Encoding': 'gzip' });
    expect(config.headers['content-encoding']).toBe('gzip');
    expect(config.headers['cache-control']).toBe('no-cache');
    expect(decode(config)).toBe(CONFIG_JS);
  });
});

describe('embedded asset representation headers', () => {
  test('every representation keeps the original type and its own length', async () => {
    const identity = await send(MAIN_URL, { 'Accept-Encoding': 'identity' });
    const gzip = await send(MAIN_URL, { 'Accept-Encoding': 'gzip' });
    const brotli = await send(MAIN_URL, { 'Accept-Encoding': 'br' });

    for (const response of [identity, gzip, brotli]) {
      expect(response.status).toBe(200);
      expect(varyDirectives(response)).toContain('Accept-Encoding');
      expect(response.headers['content-type']).toStartWith('text/javascript');
      expect(response.headers['cache-control']).toBe('public, max-age=31536000, immutable');
      expect(response.headers['content-length']).toBe(String(response.body.length));
      expect(decode(response)).toBe(MAIN_JS);
    }
    expect(gzip.body.length).toBeLessThan(identity.body.length);
    expect(brotli.body.length).toBeLessThan(identity.body.length);
    expect(gzip.headers['content-type']).toBe(identity.headers['content-type']);
    expect(brotli.headers['content-type']).toBe(identity.headers['content-type']);
  });

  test('gives each representation a distinct strong ETag over its own bytes', async () => {
    const identity = await send(MAIN_URL, { 'Accept-Encoding': 'identity' });
    const gzip = await send(MAIN_URL, { 'Accept-Encoding': 'gzip' });
    const brotli = await send(MAIN_URL, { 'Accept-Encoding': 'br' });

    expect(identity.headers.etag).toBe(contentEtag(Buffer.from(MAIN_JS)));
    expect(gzip.headers.etag).toBe(contentEtag(gzip.body));
    expect(brotli.headers.etag).toBe(contentEtag(brotli.body));
    const tags = new Set([identity.headers.etag, gzip.headers.etag, brotli.headers.etag]);
    expect(tags.size).toBe(3);
    for (const tag of tags) expect(tag).toMatch(/^"[0-9a-f]+"$/);
  });

  test('revalidates each representation against its own ETag only', async () => {
    const gzip = await send(MAIN_URL, { 'Accept-Encoding': 'gzip' });
    const brotli = await send(MAIN_URL, { 'Accept-Encoding': 'br' });

    const same = await send(MAIN_URL, {
      'Accept-Encoding': 'gzip',
      'If-None-Match': gzip.headers.etag as string,
    });
    expect(same.status).toBe(304);
    expect(same.body.length).toBe(0);
    expect(same.headers.etag).toBe(gzip.headers.etag as string);
    expect(varyDirectives(same)).toContain('Accept-Encoding');

    const weakened = await send(MAIN_URL, {
      'Accept-Encoding': 'gzip',
      'If-None-Match': `W/${gzip.headers.etag}`,
    });
    expect(weakened.status).toBe(304);

    // The Brotli validator names different bytes, so it must never revalidate a gzip copy.
    const crossed = await send(MAIN_URL, {
      'Accept-Encoding': 'gzip',
      'If-None-Match': brotli.headers.etag as string,
    });
    expect(crossed.status).toBe(200);
    expect(crossed.headers['content-encoding']).toBe('gzip');
  });

  test('keeps hashed assets without variants free of a validator', async () => {
    const response = await send(PLAIN_URL, { 'Accept-Encoding': 'gzip, br' });

    expect(response.status).toBe(200);
    expect(response.headers.etag).toBeUndefined();
    expect(varyDirectives(response)).not.toContain('Accept-Encoding');
    expect(response.headers['content-encoding']).toBeUndefined();
    expect(response.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(response.body.toString()).toBe(PLAIN_JS);
  });

  test('keeps the CORS Vary directive beside Accept-Encoding on every path', async () => {
    // `/settings` reaches the shell through the not-found fallback, `/` and the
    // asset through literal routes: each takes a different way to Elysia's headers.
    for (const path of ['/', '/settings', MAIN_URL]) {
      const response = await send(path, {
        'Accept-Encoding': 'gzip',
        Origin: 'http://localhost:3001',
      });

      expect(response.headers['content-encoding']).toBe('gzip');
      expect(response.headers.vary).toBe('Origin, Accept-Encoding');
    }
  });

  test('leaves fonts exactly as they were', async () => {
    const response = await send('/fonts/inter.woff2', { 'Accept-Encoding': 'gzip, br' });

    expect(response.status).toBe(200);
    expect(response.headers['content-encoding']).toBeUndefined();
    expect(varyDirectives(response)).not.toContain('Accept-Encoding');
    expect(response.body.toString()).toBe(FONT_BYTES);
  });

  test('answers HEAD with the metadata of the representation GET would send', async () => {
    for (const coding of ['identity', 'gzip', 'br']) {
      const headers = { 'Accept-Encoding': coding };
      const get = await send(MAIN_URL, headers);
      const head = await send(MAIN_URL, headers, 'HEAD');

      expect(head.status).toBe(200);
      expect(head.body.length).toBe(0);
      expect(head.headers['content-length']).toBe(get.headers['content-length'] as string);
      expect(head.headers['content-encoding']).toBe(get.headers['content-encoding']);
      expect(head.headers['content-type']).toBe(get.headers['content-type'] as string);
      expect(head.headers.etag).toBe(get.headers.etag as string);
      expect(varyDirectives(head)).toContain('Accept-Encoding');
    }
  });

  test('answers a conditional HEAD with 304', async () => {
    const gzip = await send(MAIN_URL, { 'Accept-Encoding': 'gzip' });
    const head = await send(
      MAIN_URL,
      { 'Accept-Encoding': 'gzip', 'If-None-Match': gzip.headers.etag as string },
      'HEAD'
    );

    expect(head.status).toBe(304);
    expect(head.body.length).toBe(0);
  });

  // File-backed fixtures, as in source runs. Bun does not slice the virtual files
  // of a compiled binary: there the full representation answers 200, which is
  // equally valid and identical for identity and encoded copies alike.
  test('answers Range over the selected representation, bound to its ETag', async () => {
    const gzip = await send(MAIN_URL, { 'Accept-Encoding': 'gzip' });
    const partial = await send(MAIN_URL, { 'Accept-Encoding': 'gzip', Range: 'bytes=0-9' });

    expect(partial.status).toBe(206);
    expect(partial.headers['content-encoding']).toBe('gzip');
    expect(partial.headers['content-range']).toBe(`bytes 0-9/${gzip.body.length}`);
    expect(partial.headers.etag).toBe(gzip.headers.etag as string);
    expect(partial.body.equals(gzip.body.subarray(0, 10))).toBe(true);
  });
});

describe('paths the encoding work must not touch', () => {
  test('never answers HEAD for API, upload or missing paths from the frontend', async () => {
    for (const path of ['/api/probe', '/uploads/note.txt', '/uploads/missing.txt', '/api/nope']) {
      const head = await send(path, { 'Accept-Encoding': 'gzip, br' }, 'HEAD');

      expect(head.status).toBe(404);
      expect(head.headers['content-encoding']).toBeUndefined();
      expect(varyDirectives(head)).not.toContain('Accept-Encoding');
    }
  });

  test('leaves API and upload responses without Vary or a content coding', async () => {
    for (const path of ['/api/probe', '/uploads/note.txt']) {
      const response = await send(path, { 'Accept-Encoding': 'gzip, br' });

      expect(response.status).toBe(200);
      expect(response.headers['content-encoding']).toBeUndefined();
      expect(varyDirectives(response)).not.toContain('Accept-Encoding');
    }
  });

  test('does not expose a variant file as a route of its own', async () => {
    for (const path of [`${MAIN_URL}.gz`, `${MAIN_URL}.br`, '/index.html.gz']) {
      const response = await send(path, { 'Accept-Encoding': 'identity' });

      expect(response.status).toBe(404);
    }
  });
});
