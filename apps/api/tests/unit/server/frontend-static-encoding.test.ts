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

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
import { removeFixtureDirSync } from '../../support/remove-fixture-dir';

const INDEX_HTML = `<!doctype html><html><body>${'<p>embedded shell</p>'.repeat(40)}</body></html>`;
const MAIN_JS = 'console.log("embedded main chunk");\n'.repeat(60);
const GZIP_ONLY_JS = 'console.log("embedded gzip-only chunk");\n'.repeat(60);
const PLAIN_JS = 'console.log("embedded chunk with no variants");\n'.repeat(60);
const CONFIG_JS = `window.__MANGO_CONFIG__ = { apiUrl: "" };\n${'// padding\n'.repeat(40)}`;
const FONT_BYTES = 'not-really-a-font';

const NO_IDENTITY_JS = 'console.log("embedded chunk without identity bytes");\n'.repeat(60);
const BR_ONLY_CSS = '.embedded-br-only { color: rebeccapurple; }\n'.repeat(60);
const SECOND_NO_IDENTITY_CSS = '.second-dropped { color: teal; }\n'.repeat(80);
const WRONG_LENGTH_JS = 'console.log("recorded length is wrong");\n'.repeat(60);

const MAIN_URL = '/assets/main-AbCd1234.js';
/** br + gzip copies and no identity file: identity is inflated from the gzip copy. */
const NO_IDENTITY_URL = '/assets/noIdentity-AbCd1234.js';
/** A br copy and no identity file: a manifest the build never writes, refused at registration. */
const BR_ONLY_URL = '/assets/brOnly-AbCd1234.css';
/** A second asset without identity bytes, so a sweep has more than one body to hold. */
const SECOND_NO_IDENTITY_URL = '/assets/secondDropped-AbCd1234.css';
/** Recorded at build time as shorter than its gzip copy inflates to: the copy and the record disagree. */
const WRONG_LENGTH_URL = '/assets/wrongLength-AbCd1234.js';
const GZIP_ONLY_URL = '/assets/gzipOnly-AbCd1234.js';
const PLAIN_URL = '/assets/plain-AbCd1234.js';

/** What the build records about an asset whose identity bytes it left out. */
function measure(content: string): { bytes: number; etag: string } {
  return { bytes: Buffer.byteLength(content), etag: contentEtag(Buffer.from(content)) };
}

/** The build's measurements of every `null` manifest entry the server is meant to serve. */
const DROPPED_IDENTITY = {
  [NO_IDENTITY_URL]: measure(NO_IDENTITY_JS),
  [SECOND_NO_IDENTITY_URL]: measure(SECOND_NO_IDENTITY_CSS),
  [WRONG_LENGTH_URL]: {
    ...measure(WRONG_LENGTH_JS),
    bytes: Buffer.byteLength(WRONG_LENGTH_JS) - 1,
  },
};

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
/** The stored gzip and Brotli copies of the asset embedded without identity bytes. */
let noIdentityCopies: { gzipPath: string; gzip: Buffer; br: Buffer };

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
  const noIdentity = fixtureWithVariants('noIdentity.js', NO_IDENTITY_JS, ['br', 'gzip']);
  noIdentityCopies = {
    gzipPath: noIdentity.encodings.gzip as string,
    gzip: readFileSync(noIdentity.encodings.gzip as string),
    br: readFileSync(noIdentity.encodings.br as string),
  };
  const brOnly = fixtureWithVariants('brOnly.css', BR_ONLY_CSS, ['br']);
  const secondNoIdentity = fixtureWithVariants('secondDropped.css', SECOND_NO_IDENTITY_CSS, [
    'br',
    'gzip',
  ]);
  const wrongLength = fixtureWithVariants('wrongLength.js', WRONG_LENGTH_JS, ['br', 'gzip']);
  const encodings: Record<string, Record<string, string>> = {
    '/index.html': index.encodings,
    [MAIN_URL]: main.encodings,
    [GZIP_ONLY_URL]: gzipOnly.encodings,
    '/config.js': config.encodings,
    [NO_IDENTITY_URL]: noIdentity.encodings,
    [BR_ONLY_URL]: brOnly.encodings,
    [SECOND_NO_IDENTITY_URL]: secondNoIdentity.encodings,
    [WRONG_LENGTH_URL]: wrongLength.encodings,
  };
  registerEmbeddedFrontend(
    {
      '/index.html': index.identity,
      [MAIN_URL]: main.identity,
      [GZIP_ONLY_URL]: gzipOnly.identity,
      [PLAIN_URL]: writeFixture('plain.js', PLAIN_JS),
      '/config.js': config.identity,
      '/fonts/inter.woff2': writeFixture('inter.woff2', FONT_BYTES),
      [NO_IDENTITY_URL]: null,
      [BR_ONLY_URL]: null,
      [SECOND_NO_IDENTITY_URL]: null,
      [WRONG_LENGTH_URL]: null,
    },
    encodings as EmbeddedFrontendEncodings,
    DROPPED_IDENTITY
  );

  const uploadsDir = mkdtempSync(join(tmpdir(), 'encoding-uploads-'));
  writeFileSync(join(uploadsDir, 'note.txt'), 'x'.repeat(2000));
  // Seated like `app.ts`: CORS echoes the origin with `Vary: Origin` before the
  // frontend answers, and the fallback receives Elysia's accumulated headers.
  const app = new Elysia()
    .use(cors({ origin: () => true }))
    .onError(NotFound, ({ request: req, set }) => frontendNotFound(req, set));
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
      removeFixtureDirSync({ role: 'frontend-static-encoding', path: uploadsDir });
    },
  };
}

beforeEach(async () => {
  fixtureDir = mkdtempSync(join(tmpdir(), 'encoding-frontend-'));
  server = await startServer();
});

afterEach(async () => {
  mock.restore();
  await server?.stop();
  server = null;
  resetEmbeddedFrontend();
  clearFrontendFallback();
  removeFixtureDirSync({ role: 'frontend-static-encoding', path: fixtureDir });
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

  // RFC 9110 §12.5.3 does not require a 406, and these were all answered with
  // identity before copies existed: a refusal must not start failing requests.
  test.each(['identity;q=0', '*;q=0', 'deflate, identity;q=0'])(
    'answers identity, not 406, for Accept-Encoding %p',
    async (header) => {
      for (const path of [MAIN_URL, '/']) {
        const response = await send(path, { 'Accept-Encoding': header });

        expect(response.status).toBe(200);
        expect(varyDirectives(response)).toContain('Accept-Encoding');
        expect(response.headers['content-encoding']).toBeUndefined();
      }
      const response = await send(MAIN_URL, { 'Accept-Encoding': header });
      expect(response.body.toString()).toBe(MAIN_JS);
    }
  );

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

  test('keeps Origin and Accept-Encoding in Vary on a 304', async () => {
    const gzip = await send(MAIN_URL, { 'Accept-Encoding': 'gzip' });

    for (const path of [MAIN_URL, '/']) {
      const first = path === MAIN_URL ? gzip : await send(path, { 'Accept-Encoding': 'gzip' });
      const response = await send(path, {
        'Accept-Encoding': 'gzip',
        'If-None-Match': first.headers.etag as string,
        Origin: 'http://localhost:3001',
      });

      expect(response.status).toBe(304);
      expect(response.headers.vary).toBe('Origin, Accept-Encoding');
    }
  });

  test('keeps Origin and Accept-Encoding in Vary when falling back to identity', async () => {
    // A refused identity, an unsupported coding and a missing copy all land on identity.
    const cases: [string, string][] = [
      [MAIN_URL, 'identity;q=0'],
      [MAIN_URL, 'zstd'],
      [GZIP_ONLY_URL, 'br'],
      ['/settings', 'zstd'],
    ];
    for (const [path, encoding] of cases) {
      const response = await send(path, {
        'Accept-Encoding': encoding,
        Origin: 'http://localhost:3001',
      });

      expect(response.status).toBe(200);
      expect(response.headers['content-encoding']).toBeUndefined();
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

  // File-backed fixtures, the same kind Bun slices inside a compiled binary
  // (measured: 206 for identity, gzip and Brotli over `$bunfs` files).
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

describe('embedded assets without identity bytes', () => {
  test('inflates the gzip copy for a client that accepts no stored copy', async () => {
    for (const header of [undefined, 'identity', 'deflate', 'gzip;q=0, br;q=0']) {
      const response = await send(
        NO_IDENTITY_URL,
        header === undefined ? {} : { 'Accept-Encoding': header }
      );

      expect(response.status, `Accept-Encoding ${String(header)}`).toBe(200);
      expect(response.headers['content-encoding']).toBeUndefined();
      expect(response.headers['content-type']).toStartWith('text/javascript');
      expect(response.headers['content-length']).toBe(String(response.body.length));
      // The tag a binary that embedded identity would send for the same bytes.
      expect(response.headers.etag).toBe(contentEtag(Buffer.from(NO_IDENTITY_JS)));
      expect(varyDirectives(response)).toContain('Accept-Encoding');
      expect(response.body.toString()).toBe(NO_IDENTITY_JS);
    }
  });

  test('serves the stored copies untouched', async () => {
    const gzip = await send(NO_IDENTITY_URL, { 'Accept-Encoding': 'gzip' });
    const brotli = await send(NO_IDENTITY_URL, { 'Accept-Encoding': 'gzip, br' });

    expect(gzip.headers['content-encoding']).toBe('gzip');
    expect(brotli.headers['content-encoding']).toBe('br');
    expect(decode(gzip)).toBe(NO_IDENTITY_JS);
    expect(decode(brotli)).toBe(NO_IDENTITY_JS);
    // Byte for byte what the build embedded, not a re-encoding of the same content.
    expect(gzip.body.equals(noIdentityCopies.gzip)).toBe(true);
    expect(brotli.body.equals(noIdentityCopies.br)).toBe(true);
    expect(gzip.headers['content-length']).toBe(String(noIdentityCopies.gzip.length));
    expect(brotli.headers['content-length']).toBe(String(noIdentityCopies.br.length));
  });

  test('serves the same inflated bytes for every identity request, from one inflation', async () => {
    const first = await send(NO_IDENTITY_URL);
    // The gzip copy is gone from disk, so a second identity answer can only come from the cache.
    rmSync(noIdentityCopies.gzipPath);
    const second = await send(NO_IDENTITY_URL);
    const head = await send(NO_IDENTITY_URL, {}, 'HEAD');

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.equals(first.body)).toBe(true);
    expect(second.headers.etag).toBe(first.headers.etag as string);
    expect(head.headers['content-length']).toBe(String(first.body.length));
  });

  test('does not route an identity-less asset that has no gzip copy to inflate', async () => {
    for (const header of ['br', 'identity']) {
      const response = await send(BR_ONLY_URL, { 'Accept-Encoding': header });

      expect(response.status, `Accept-Encoding ${header}`).toBe(404);
      expect(response.body.toString()).not.toContain(BR_ONLY_CSS.slice(0, 20));
    }
  });

  test('revalidates inflated identity with 304 and answers HEAD without a body', async () => {
    const first = await send(NO_IDENTITY_URL);
    const conditional = await send(NO_IDENTITY_URL, {
      'If-None-Match': first.headers.etag as string,
    });
    const head = await send(NO_IDENTITY_URL, {}, 'HEAD');

    expect(conditional.status).toBe(304);
    expect(head.status).toBe(200);
    expect(head.body.length).toBe(0);
    expect(head.headers['content-length']).toBe(String(NO_IDENTITY_JS.length));
    expect(head.headers.etag).toBe(first.headers.etag as string);
  });

  describe('without inflating', () => {
    /** Counts calls into Bun's inflater, which is the whole cost of this path. */
    function watchInflater() {
      return spyOn(Bun, 'gunzipSync');
    }

    test('answers HEAD from the recorded length on a cold cache', async () => {
      const inflater = watchInflater();
      // With the copy gone, only a request that never reads it can still succeed.
      rmSync(noIdentityCopies.gzipPath);

      const head = await send(NO_IDENTITY_URL, {}, 'HEAD');

      expect(head.status).toBe(200);
      expect(head.body.length).toBe(0);
      expect(head.headers['content-length']).toBe(String(Buffer.byteLength(NO_IDENTITY_JS)));
      expect(head.headers.etag).toBe(contentEtag(Buffer.from(NO_IDENTITY_JS)));
      expect(inflater.mock.calls.length, 'inflater calls for HEAD on a cold cache').toBe(0);
    });

    test('answers If-None-Match from the recorded tag on a cold cache', async () => {
      const inflater = watchInflater();
      rmSync(noIdentityCopies.gzipPath);

      const conditional = await send(NO_IDENTITY_URL, {
        'If-None-Match': contentEtag(Buffer.from(NO_IDENTITY_JS)),
      });
      const conditionalHead = await send(
        NO_IDENTITY_URL,
        { 'If-None-Match': contentEtag(Buffer.from(NO_IDENTITY_JS)) },
        'HEAD'
      );

      expect(conditional.status).toBe(304);
      expect(conditional.body.length).toBe(0);
      expect(conditionalHead.status).toBe(304);
      expect(inflater.mock.calls.length, 'inflater calls for 304 on a cold cache').toBe(0);
    });

    test('answers an unsatisfiable range from the recorded length on a cold cache', async () => {
      const inflater = watchInflater();

      const response = await send(NO_IDENTITY_URL, { Range: 'bytes=99999999-' });

      expect(response.status).toBe(416);
      expect(inflater.mock.calls.length, 'inflater calls for 416 on a cold cache').toBe(0);
    });

    test('inflates each asset once across two full sweeps of every identity request', async () => {
      const inflater = watchInflater();
      const sweep = [NO_IDENTITY_URL, SECOND_NO_IDENTITY_URL];

      for (let pass = 0; pass < 2; pass += 1) {
        for (const url of sweep) {
          const response = await send(url);
          expect(response.status, `${url} pass ${pass}`).toBe(200);
        }
      }

      expect(
        inflater.mock.calls.length,
        `inflater calls for ${sweep.length} assets over 2 sweeps: expected ${sweep.length}`
      ).toBe(sweep.length);
    });

    test('fails a GET whose gzip copy inflates to a length other than the recorded one', async () => {
      const response = await send(WRONG_LENGTH_URL);

      // The HEAD length was promised from the record, so the body must not contradict it.
      expect(response.status).toBe(500);
      expect(response.body.toString()).not.toContain('recorded length is wrong');
    });

    test('refuses a null entry the build recorded no measurement for', async () => {
      await server?.stop();
      server = null;
      resetEmbeddedFrontend();
      clearFrontendFallback();
      const index = fixtureWithVariants('index2.html', INDEX_HTML, ['gzip']);
      const unmeasured = fixtureWithVariants('unmeasured.js', NO_IDENTITY_JS, ['gzip']);
      registerEmbeddedFrontend(
        { '/index.html': index.identity, '/assets/unmeasured-AbCd1234.js': null },
        {
          '/index.html': index.encodings,
          '/assets/unmeasured-AbCd1234.js': unmeasured.encodings,
        } as EmbeddedFrontendEncodings
      );
      const app = new Elysia().onError(NotFound, ({ request: req, set }) =>
        frontendNotFound(req, set)
      );
      registerFrontend(app as unknown as App, '/nonexistent-frontend-dir');
      await app.modules;
      app.listen({ hostname: '127.0.0.1', port: 0, reusePort: false });
      try {
        const response = await raw(
          app.server?.port as number,
          '/assets/unmeasured-AbCd1234.js',
          {},
          'GET'
        );

        expect(response.status).toBe(404);
      } finally {
        await app.stop();
      }
    });
  });

  describe('Range over inflated identity', () => {
    const SIZE = Buffer.byteLength(NO_IDENTITY_JS);
    const body = Buffer.from(NO_IDENTITY_JS);
    const etag = contentEtag(body);

    // Each verdict is what a stored file gets from Bun, measured on a compiled hub
    // (`$bunfs` files) against the base build.
    test.each([
      ['bytes=0-9', 206, 0, 9],
      ['bytes=5-', 206, 5, SIZE - 1],
      ['bytes=-7', 206, SIZE - 7, SIZE - 1],
      ['bytes=0-0', 206, 0, 0],
      ['bytes=0-99999999999', 206, 0, SIZE - 1],
      ['bytes=-99999999', 206, 0, SIZE - 1],
      [`bytes=${SIZE - 1}-`, 206, SIZE - 1, SIZE - 1],
      ['bytes= 0-9', 206, 0, 9],
      ['BYTES=0-9', 206, 0, 9],
    ])(
      'answers %s with 206 and the slice of the decoded body',
      async (range, status, start, end) => {
        const response = await send(NO_IDENTITY_URL, { Range: range });

        expect(response.status).toBe(status);
        expect(response.headers['content-range']).toBe(`bytes ${start}-${end}/${SIZE}`);
        expect(response.headers['accept-ranges']).toBe('bytes');
        expect(response.headers['content-length']).toBe(String(end - start + 1));
        expect(response.headers.etag).toBe(etag);
        expect(response.headers['content-encoding']).toBeUndefined();
        expect(response.body.equals(body.subarray(start, end + 1))).toBe(true);
      }
    );

    test.each(['bytes=-0', `bytes=${SIZE}-`, 'bytes=99999999-'])(
      'answers %s with 416 and the length',
      async (range) => {
        const response = await send(NO_IDENTITY_URL, { Range: range });

        expect(response.status).toBe(416);
        expect(response.headers['content-range']).toBe(`bytes */${SIZE}`);
        expect(response.headers['accept-ranges']).toBe('bytes');
        expect(response.body.length).toBe(0);
      }
    );

    test.each([
      'bytes=0-1,5-6',
      'bytes=5-2',
      'bytes=abc',
      'bytes=-',
      'bytes=0-9,',
      'bytes=0-9;x',
      'items=0-1',
    ])('answers %s with the whole body', async (range) => {
      const response = await send(NO_IDENTITY_URL, { Range: range });

      expect(response.status).toBe(200);
      expect(response.headers['content-range']).toBeUndefined();
      expect(response.body.equals(body)).toBe(true);
    });

    test('a plain 200 does not advertise ranges, as for a stored file', async () => {
      const response = await send(NO_IDENTITY_URL);

      expect(response.headers['accept-ranges']).toBeUndefined();
    });

    test('honours If-Range only for the exact strong tag', async () => {
      const matching = await send(NO_IDENTITY_URL, { Range: 'bytes=0-9', 'If-Range': etag });
      const stale = await send(NO_IDENTITY_URL, { Range: 'bytes=0-9', 'If-Range': '"stale"' });
      const weak = await send(NO_IDENTITY_URL, { Range: 'bytes=0-9', 'If-Range': `W/${etag}` });
      const date = await send(NO_IDENTITY_URL, {
        Range: 'bytes=0-9',
        'If-Range': 'Wed, 21 Oct 2015 07:28:00 GMT',
      });

      expect(matching.status).toBe(206);
      for (const response of [stale, weak, date]) {
        expect(response.status).toBe(200);
        expect(response.body.equals(body)).toBe(true);
      }
    });

    test('answers HEAD with the whole length, ignoring Range', async () => {
      const head = await send(NO_IDENTITY_URL, { Range: 'bytes=0-9' }, 'HEAD');

      expect(head.status).toBe(200);
      expect(head.headers['content-length']).toBe(String(SIZE));
      expect(head.body.length).toBe(0);
    });

    test('answers If-None-Match before Range', async () => {
      const response = await send(NO_IDENTITY_URL, { Range: 'bytes=0-9', 'If-None-Match': etag });

      expect(response.status).toBe(304);
    });

    test('ranges the encoded copies exactly as before', async () => {
      const gzip = await send(NO_IDENTITY_URL, { 'Accept-Encoding': 'gzip' });
      const partial = await send(NO_IDENTITY_URL, {
        'Accept-Encoding': 'gzip',
        Range: 'bytes=0-9',
      });

      expect(partial.status).toBe(206);
      expect(partial.headers['content-encoding']).toBe('gzip');
      expect(partial.headers['content-range']).toBe(`bytes 0-9/${gzip.body.length}`);
      expect(partial.body.equals(gzip.body.subarray(0, 10))).toBe(true);
    });
  });
});

describe('paths the encoding work must not touch', () => {
  test('never answers HEAD for API or missing upload paths from the frontend', async () => {
    for (const path of ['/api/probe', '/uploads/missing.txt', '/api/nope']) {
      const head = await send(path, { 'Accept-Encoding': 'gzip, br' }, 'HEAD');

      expect(head.status).toBe(404);
      expect(head.headers['content-encoding']).toBeUndefined();
      expect(varyDirectives(head)).not.toContain('Accept-Encoding');
    }
  });

  test('answers HEAD for an existing upload from the uploads route, not the frontend', async () => {
    const head = await send('/uploads/note.txt', { 'Accept-Encoding': 'gzip, br' }, 'HEAD');

    expect(head.status).toBe(200);
    expect(head.body.length, 'HEAD /uploads/note.txt body bytes').toBe(0);
    expect(head.headers['content-encoding']).toBeUndefined();
    expect(varyDirectives(head)).not.toContain('Accept-Encoding');
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
