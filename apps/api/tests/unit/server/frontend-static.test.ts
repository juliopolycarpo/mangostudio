/**
 * Embedded frontend serving: when the registry is populated (standalone
 * binary), the server resolves URLs through the embedded manifest and never
 * touches the filesystem `public/` directory; when it is empty (dev/source
 * runs), the existing filesystem path is used.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
  const app = new Elysia()
    .error(NotFound, ({ request }) => frontendNotFound(request))
    .use(new Elysia({ prefix: '/api' }).use(errorHandler));
  registerFrontend(app as unknown as App, frontendDir);
  return (path: string) => app.handle(new Request(`http://localhost${path}`));
}

async function expectJsonNotFound(response: Response): Promise<void> {
  expect(response.status).toBe(404);
  expect(response.headers.get('content-type')).toContain('application/json');
  const payload: unknown = await response.json();
  expect(Value.Check(ApiErrorResponseSchema, payload)).toBe(true);
  expect(payload).toEqual({ error: 'Not found', code: ERROR_CODES.NOT_FOUND });
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

  test('does not swallow /api, unknown /api/*, or missing asset paths', async () => {
    const get = registerEmbedded();

    await expectJsonNotFound(await get('/api'));
    await expectJsonNotFound(await get('/api/nope'));
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
   * embedded manifest. Its precedence is pinned separately from the embedded
   * one, so a plugin swap has to keep every outcome below identical.
   *
   * These drive the app with `app.handle()`, which resolves routes differently
   * from a listening server — see the `.listen()` suite below for the class of
   * bug that is invisible here.
   */
  async function buildFilesystemApp(): Promise<(path: string) => Promise<Response>> {
    const frontendDir = mkdtempSync(join(tmpdir(), 'fs-frontend-'));
    mkdirSync(join(frontendDir, 'assets'), { recursive: true });
    writeFileSync(join(frontendDir, 'index.html'), INDEX_HTML);
    writeFileSync(join(frontendDir, 'assets', 'index-AbCd1234.js'), ASSET_JS);

    const uploadsDir = mkdtempSync(join(tmpdir(), 'fs-uploads-'));
    writeFileSync(join(uploadsDir, 'photo.png'), UPLOAD_BYTES);

    const app = new Elysia()
      .error(NotFound, ({ request }) => frontendNotFound(request))
      .use(staticPlugin({ assets: uploadsDir, prefix: '/uploads' }))
      .use(new Elysia({ prefix: '/api' }).use(errorHandler).get('/health', () => ({ ok: true })));
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

  test('serves index.html at / with no-cache', async () => {
    const get = await buildFilesystemApp();
    const response = await get('/');

    // The explicit `GET /` registered ahead of staticPlugin, with the same
    // directive as the embedded path: every build renames the hashed bundles
    // the shell points at, so a heuristically cached shell would ask for
    // scripts that no longer exist and render a blank page.
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html');
    expect(response.headers.get('cache-control')).toBe('no-cache');
    expect(await response.text()).toBe(INDEX_HTML);
  });

  test('serves a hashed asset through the static plugin', async () => {
    const get = await buildFilesystemApp();
    const response = await get('/assets/index-AbCd1234.js');

    // A year, the same freshness the embedded branch gives these files. The
    // plugin composes `${directive}, max-age=${maxAge}` from a single-token
    // directive, so `immutable` cannot be added alongside `public` here.
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('public, max-age=31536000');
    expect(await response.text()).toBe(ASSET_JS);
  });

  test('404s an unhashed file that disappeared after boot', async () => {
    const frontendDir = mkdtempSync(join(tmpdir(), 'fs-frontend-'));
    temporaryDirs.push(frontendDir);
    writeFileSync(join(frontendDir, 'index.html'), INDEX_HTML);
    writeFileSync(join(frontendDir, 'favicon.ico'), UPLOAD_BYTES);

    const app = new Elysia().error(NotFound, ({ request }) => frontendNotFound(request));
    registerFrontend(app as unknown as App, frontendDir);
    await app.modules;
    const get = (path: string) => app.handle(new Request(`http://localhost${path}`));

    expect((await get('/favicon.ico')).status).toBe(200);

    // The route was enumerated at boot, but `build.ts` removes `dist/` before
    // every rebuild and the dev watcher rebuilds on every save. A request in
    // that window used to throw ENOENT out of the handler and answer 500.
    rmSync(join(frontendDir, 'favicon.ico'));
    expect((await get('/favicon.ico')).status).toBe(404);
  });

  test('boots past a dist entry that cannot be stat-ed', () => {
    const frontendDir = mkdtempSync(join(tmpdir(), 'fs-frontend-'));
    temporaryDirs.push(frontendDir);
    writeFileSync(join(frontendDir, 'index.html'), INDEX_HTML);
    symlinkSync(join(frontendDir, 'never-written.txt'), join(frontendDir, 'dangling.txt'));

    // Enumerating the directory is boot work, so a throw here does not degrade
    // to the API-only branch — it stops the server from starting at all.
    const app = new Elysia();
    expect(() => registerFrontend(app as unknown as App, frontendDir)).not.toThrow();
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
    for (const path of ['/api', '/api/nope']) {
      await expectJsonNotFound(await get(path));
    }
    for (const path of ['/assets/missing.js', '/scalar']) {
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

describe('registerFrontend from the filesystem, over a listening server', () => {
  /**
   * `app.handle()` and `app.listen()` do not resolve routes the same way, and
   * only the second one is what a browser talks to. Elysia promotes routes into
   * Bun's native table on `.listen()`, and there a root `GET /*` outranks
   * `.all('/*')` wildcards anywhere in the app — at the root, inside a `.group()`
   * and inside a mounted prefixed instance alike — while leaving both literal
   * routes and `.get('/*')` wildcards matching.
   *
   * `staticPlugin({ prefix: '/' })` used to register exactly that (it only skips
   * the wildcard when `alwaysStatic` is on, which keys off
   * `NODE_ENV === 'production'` — never set in this repo). Better Auth is
   * mounted as `.all('/*')` in `routes/auth.ts`, so every path under
   * `/api/auth/` except the literal `/ok` answered 404 on a real server while
   * every `handle()`-driven test stayed green. Hence a suite that binds a port.
   */
  const SHADOWED_SHAPE = '/api/auth';
  const SURVIVING_SHAPE = '/images';

  async function startFilesystemServer(): Promise<{
    get: (path: string, headers?: Record<string, string>) => Promise<Response>;
    frontendDir: string;
    stop: () => Promise<void>;
  }> {
    const frontendDir = mkdtempSync(join(tmpdir(), 'listen-frontend-'));
    mkdirSync(join(frontendDir, 'assets'), { recursive: true });
    writeFileSync(join(frontendDir, 'index.html'), INDEX_HTML);
    writeFileSync(join(frontendDir, 'favicon.ico'), UPLOAD_BYTES);
    writeFileSync(join(frontendDir, 'assets', 'index-AbCd1234.js'), ASSET_JS);
    temporaryDirs.push(frontendDir);

    // Stand-ins for the real routes, so the assertion is about routing
    // precedence rather than about Better Auth or the image store. The method
    // is the load-bearing part: `.all` is the shape that broke, `.get` is the
    // control that never did, so the guard cannot pass for the wrong reason.
    const app = new Elysia().error(NotFound, ({ request }) => frontendNotFound(request));
    app.all(`${SHADOWED_SHAPE}/*`, ({ path }) => `wildcard:${path}`);
    app.get(`${SURVIVING_SHAPE}/*`, ({ path }) => `wildcard:${path}`);
    registerFrontend(app as unknown as App, frontendDir);
    await app.modules;

    app.listen({ hostname: '127.0.0.1', port: 0, reusePort: false });
    const origin = `http://127.0.0.1:${app.server?.port}`;
    return {
      get: (path: string, headers?: Record<string, string>) =>
        fetch(`${origin}${path}`, { headers }),
      frontendDir,
      stop: async () => {
        await app.stop();
      },
    };
  }

  test('leaves every other wildcard route reachable', async () => {
    const server = await startFilesystemServer();
    try {
      for (const prefix of [SHADOWED_SHAPE, SURVIVING_SHAPE]) {
        const path = `${prefix}/get-session`;
        const response = await server.get(path);

        expect(response.status).toBe(200);
        expect(await response.text()).toBe(`wildcard:${path}`);
      }
    } finally {
      await server.stop();
    }
  });

  test('serves the shell, a root file, and a hashed asset', async () => {
    const server = await startFilesystemServer();
    try {
      for (const path of ['/', '/settings/agents']) {
        const response = await server.get(path);
        expect(response.status).toBe(200);
        expect(await response.text()).toBe(INDEX_HTML);
      }

      // Unhashed root files get their own route; without one they would fall
      // through to the SPA shell and hand an <html> document to a <link> tag.
      const icon = await server.get('/favicon.ico');
      expect(icon.status).toBe(200);
      expect(await icon.text()).toBe(UPLOAD_BYTES);

      const asset = await server.get('/assets/index-AbCd1234.js');
      expect(asset.status).toBe(200);
      expect(await asset.text()).toBe(ASSET_JS);

      const missing = await server.get('/assets/missing.js');
      expect(missing.status).toBe(404);
      expect(await missing.text()).not.toBe(INDEX_HTML);
    } finally {
      await server.stop();
    }
  });

  test('serves unhashed root files with the cache headers the static plugin used to add', async () => {
    const server = await startFilesystemServer();
    try {
      // `staticPlugin({ prefix: '/' })` gave these files max-age=86400, an
      // ETag and a 304 short-circuit; the per-file routes that replaced the
      // wildcard must not silently drop that.
      const first = await server.get('/favicon.ico');
      expect(first.status).toBe(200);
      expect(first.headers.get('cache-control')).toBe('public, max-age=86400');
      const etag = first.headers.get('etag');
      expect(etag).not.toBeNull();

      const revalidated = await server.get('/favicon.ico', { 'If-None-Match': etag as string });
      expect(revalidated.status).toBe(304);
      expect(await revalidated.text()).toBe('');

      const changed = await server.get('/favicon.ico', { 'If-None-Match': '"stale"' });
      expect(changed.status).toBe(200);
      expect(await changed.text()).toBe(UPLOAD_BYTES);
    } finally {
      await server.stop();
    }
  });

  test('serves an asset written after startup', async () => {
    const server = await startFilesystemServer();
    try {
      // Every rebuild renames the bundle, so `/assets/*` has to resolve from
      // disk per request. Pinning routes at boot would make the dev server
      // serve a 404 for the very bundle its own watcher just produced.
      writeFileSync(join(server.frontendDir, 'assets', 'index-Rebuilt1.js'), ASSET_JS);

      const response = await server.get('/assets/index-Rebuilt1.js');
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(ASSET_JS);
    } finally {
      await server.stop();
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

    for (const path of ['/api', '/api/nope']) {
      const missing = await app.handle(new Request(`http://localhost${path}`));
      await expectJsonNotFound(missing);
    }

    const root = await app.handle(new Request('http://localhost/'));
    expect(root.status).toBe(404);
    expect(await root.text()).toBe('Frontend not found. API is running.');
  });
});
