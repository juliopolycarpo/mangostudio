/**
 * Embedded frontend serving: when the registry is populated (standalone
 * binary), the server resolves URLs through the embedded manifest and never
 * touches the filesystem `public/` directory; when it is empty (dev/source
 * runs), the existing filesystem path is used.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { staticPlugin } from '@elysia/static';
import { ApiErrorResponseSchema, ERROR_CODES } from '@mangostudio/shared/errors';
import { Elysia, NotFound } from 'elysia';
import Value from 'typebox/value';
import type { App } from '../../../src/app';
import { errorHandler } from '../../../src/plugins/error-handler';
import {
  registerEmbeddedFrontend,
  resetEmbeddedFrontend,
} from '../../../src/server/embedded-frontend';
import { clearFrontendFallback, frontendNotFound } from '../../../src/server/frontend-fallback';
import { registerFrontend } from '../../../src/server/frontend-static';

const INDEX_HTML = '<html><body>embedded index</body></html>';
const ASSET_JS = 'console.log("embedded")';
const UPLOAD_BYTES = 'not-really-a-png';

let assetDir: string;
/** Extra fixture directories a test created; removed together in afterEach. */
const temporaryDirs: string[] = [];

function buildApp(frontendDir = '/nonexistent-frontend-dir'): (path: string) => Promise<Response> {
  const app = new Elysia();
  registerFrontend(app as unknown as App, frontendDir);
  return (path: string) => app.handle(new Request(`http://localhost${path}`));
}

beforeEach(() => {
  assetDir = mkdtempSync(join(tmpdir(), 'embedded-frontend-'));
  writeFileSync(join(assetDir, 'index.html'), INDEX_HTML);
  writeFileSync(join(assetDir, 'index-AbCd1234.js'), ASSET_JS);
});

afterEach(() => {
  resetEmbeddedFrontend();
  clearFrontendFallback();
  rmSync(assetDir, { recursive: true, force: true });
  while (temporaryDirs.length > 0) {
    rmSync(temporaryDirs.pop() as string, { recursive: true, force: true });
  }
});

describe('registerFrontend with embedded assets', () => {
  function registerEmbedded(): (path: string) => Promise<Response> {
    registerEmbeddedFrontend({
      '/index.html': join(assetDir, 'index.html'),
      '/assets/index-AbCd1234.js': join(assetDir, 'index-AbCd1234.js'),
    });
    return buildApp();
  }

  test('serves index.html at / with no-cache', async () => {
    const get = registerEmbedded();
    const response = await get('/');

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-cache');
    expect(await response.text()).toBe(INDEX_HTML);
  });

  test('serves manifest assets with an immutable cache header', async () => {
    const get = registerEmbedded();
    const response = await get('/assets/index-AbCd1234.js');

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(await response.text()).toBe(ASSET_JS);
  });

  test('falls back to index.html for SPA routes', async () => {
    const get = registerEmbedded();
    const response = await get('/settings');

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(INDEX_HTML);
  });

  test('does not swallow unknown /api/* or missing asset paths', async () => {
    const get = registerEmbedded();

    expect((await get('/api/nope')).status).toBe(404);
    expect((await get('/assets/missing.js')).status).toBe(404);
  });

  test('does not shadow mounted wildcard routes such as Better Auth /api/auth/*', async () => {
    // Reproduces the binary-smoke regression: Better Auth mounts /api/auth/*
    // as a wildcard on a prefixed sub-instance (routes/auth.ts). A root
    // app.get('/*') intercepts it; the explicit-route + onError design must
    // let the mounted handler win.
    registerEmbeddedFrontend({
      '/index.html': join(assetDir, 'index.html'),
      '/assets/index-AbCd1234.js': join(assetDir, 'index-AbCd1234.js'),
    });
    const app = new Elysia().group('/api', (api) =>
      api.group('/auth', (auth) => auth.all('/*', () => new Response('auth-handler')))
    );
    registerFrontend(app as unknown as App, '/nonexistent-frontend-dir');

    const response = await app.handle(new Request('http://localhost/api/auth/get-session'));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('auth-handler');
  });

  test('ignores the filesystem frontend directory entirely', async () => {
    registerEmbeddedFrontend({ '/index.html': join(assetDir, 'index.html') });
    // A stale sidecar directory with a different index must never be served.
    const staleDir = mkdtempSync(join(tmpdir(), 'stale-public-'));
    writeFileSync(join(staleDir, 'index.html'), '<html>STALE</html>');
    try {
      const get = buildApp(staleDir);
      expect(await (await get('/')).text()).toBe(INDEX_HTML);
    } finally {
      rmSync(staleDir, { recursive: true, force: true });
    }
  });
});

describe('registerFrontend from the filesystem', () => {
  /**
   * The source/`npm install` path, where assets come off disk instead of the
   * embedded manifest. It is the branch carrying the documented
   * `@elysia/static` `ignorePatterns` workaround, so its precedence is pinned
   * separately from the embedded one: a plugin swap that fixes the underlying
   * inverted-comparison bug must keep every outcome below identical before the
   * workaround can be removed.
   */
  async function buildFilesystemApp(): Promise<(path: string) => Promise<Response>> {
    const frontendDir = mkdtempSync(join(tmpdir(), 'fs-frontend-'));
    mkdirSync(join(frontendDir, 'assets'), { recursive: true });
    writeFileSync(join(frontendDir, 'index.html'), INDEX_HTML);
    writeFileSync(join(frontendDir, 'assets', 'index-AbCd1234.js'), ASSET_JS);

    const uploadsDir = mkdtempSync(join(tmpdir(), 'fs-uploads-'));
    writeFileSync(join(uploadsDir, 'photo.png'), UPLOAD_BYTES);

    const app = new Elysia()
      .use(staticPlugin({ assets: uploadsDir, prefix: '/uploads' }))
      .group('/api', (api) => api.get('/health', () => ({ ok: true })));
    registerFrontend(app as unknown as App, frontendDir);

    // `staticPlugin` enumerates its directory asynchronously, so both its
    // routes and the `onError` fallback chained after it land on a later tick.
    // A request issued before that resolves sees a half-registered app — which
    // is a real property of this wiring worth knowing during a plugin swap, and
    // a race that silently rewrites every assertion below if it is not awaited.
    await app.modules;

    temporaryDirs.push(frontendDir, uploadsDir);
    return (path: string) => app.handle(new Request(`http://localhost${path}`));
  }

  test('serves index.html at / with no cache header', async () => {
    const get = await buildFilesystemApp();
    const response = await get('/');

    // The explicit `GET /` registered ahead of staticPlugin. Unlike the
    // embedded path it sets no Cache-Control, so the shell is revalidated by
    // the browser's default heuristics rather than by an explicit directive.
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html');
    expect(response.headers.get('cache-control')).toBeNull();
    expect(await response.text()).toBe(INDEX_HTML);
  });

  test('serves a hashed asset through the static plugin', async () => {
    const get = await buildFilesystemApp();
    const response = await get('/assets/index-AbCd1234.js');

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('public, max-age=86400');
    expect(await response.text()).toBe(ASSET_JS);
  });

  test('serves a real upload and 404s a missing one without the SPA shell', async () => {
    const get = await buildFilesystemApp();

    const served = await get('/uploads/photo.png');
    expect(served.status).toBe(200);
    expect(await served.text()).toBe(UPLOAD_BYTES);

    // `/uploads/*` sits in `ignorePatterns` and in `isSpaRoute`'s exclusions.
    // A missing upload must stay a 404: answering it with the SPA shell would
    // hand an <html> document to an <img> tag.
    const missing = await get('/uploads/missing.png');
    expect(missing.status).toBe(404);
    expect(await missing.text()).not.toBe(INDEX_HTML);
  });

  test('never claims API, asset, or scalar paths for the SPA', async () => {
    const get = await buildFilesystemApp();

    expect((await get('/api/health')).status).toBe(200);
    for (const path of ['/api/nope', '/assets/missing.js', '/scalar']) {
      const response = await get(path);
      expect(response.status).toBe(404);
      expect(await response.text()).not.toBe(INDEX_HTML);
    }
  });

  test('serves SPA deep links with 200, matching the embedded branch', async () => {
    const get = await buildFilesystemApp();

    // This used to answer 404-with-the-shell here and 200 in the embedded
    // branch: the framework's NOT_FOUND status leaked onto the `Response` the
    // fallback returned, so every SPA deep link on a source or `npm install`
    // deployment reported 404 to uptime checks and crawlers while rendering
    // fine in a browser. A returned `Response` now carries its own status, so
    // both deployment shapes answer 200 and the divergence is gone.
    //
    // Kept as an explicit assertion rather than deleted: the two branches
    // agreeing is the property worth holding, and it was reached by a framework
    // behavior change rather than by a decision recorded here.
    for (const path of ['/settings', '/index.html']) {
      const response = await get(path);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(INDEX_HTML);
    }
  });
});

describe('registerFrontend without embedded assets', () => {
  test('keeps the API-only 404 behaviour when no frontend directory exists', async () => {
    const get = buildApp();
    const response = await get('/anything');

    expect(response.status).toBe(404);
    expect(await response.text()).toBe('Frontend not found. API is running.');
  });

  test('keeps API routes reachable in API-only mode', async () => {
    const app = new Elysia().group('/api', (api) => api.get('/health', () => ({ ok: true })));
    registerFrontend(app as unknown as App, '/nonexistent-frontend-dir');

    const healthy = await app.handle(new Request('http://localhost/api/health'));
    expect(healthy.status).toBe(200);
    expect(await healthy.json()).toEqual({ ok: true });

    const root = await app.handle(new Request('http://localhost/'));
    expect(root.status).toBe(404);
    expect(await root.text()).toBe('Frontend not found. API is running.');
  });

  test('leaves unknown API paths to the JSON error handler in API-only mode', async () => {
    // Same seating as `app.ts`: the SPA/API-only fallback is registered on the
    // outer instance, ahead of the API plugin's `errorHandler`. If the fallback
    // claims `/api/*`, that outer handler answers first and the JSON 404 never
    // runs.
    const app = new Elysia()
      .error(NotFound, ({ request }) => frontendNotFound(request))
      .use(new Elysia({ prefix: '/api' }).use(errorHandler).get('/health', () => ({ ok: true })));
    registerFrontend(app as unknown as App, '/nonexistent-frontend-dir');

    const missing = await app.handle(new Request('http://localhost/api/nope'));
    expect(missing.status).toBe(404);
    expect(missing.headers.get('content-type')).toContain('application/json');
    const payload: unknown = await missing.json();
    expect(Value.Check(ApiErrorResponseSchema, payload)).toBe(true);
    expect(payload).toEqual({ error: 'Not found', code: ERROR_CODES.NOT_FOUND });

    const root = await app.handle(new Request('http://localhost/'));
    expect(root.status).toBe(404);
    expect(await root.text()).toBe('Frontend not found. API is running.');
  });
});
