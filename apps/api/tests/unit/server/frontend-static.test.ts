/**
 * Embedded frontend serving: when the registry is populated (standalone
 * binary), the server resolves URLs through the embedded manifest and never
 * touches the filesystem `public/` directory; when it is empty (dev/source
 * runs), the existing filesystem path is used.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Elysia } from 'elysia';
import type { App } from '../../../src/app';
import {
  registerEmbeddedFrontend,
  resetEmbeddedFrontend,
} from '../../../src/server/embedded-frontend';
import { registerFrontend } from '../../../src/server/frontend-static';

const INDEX_HTML = '<html><body>embedded index</body></html>';
const ASSET_JS = 'console.log("embedded")';

let assetDir: string;

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
  rmSync(assetDir, { recursive: true, force: true });
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

describe('registerFrontend without embedded assets', () => {
  test('keeps the API-only 404 behaviour when no frontend directory exists', async () => {
    const get = buildApp();
    const response = await get('/anything');

    expect(response.status).toBe(404);
    expect(await response.text()).toBe('Frontend not found. API is running.');
  });
});
