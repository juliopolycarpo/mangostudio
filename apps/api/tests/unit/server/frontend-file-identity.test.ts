import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BUILD_STATE_FILE } from '@mangostudio/shared/utils/dist-files';
import { type AnyElysia, Elysia, NotFound } from 'elysia';
import type { App } from '../../../src/app';
import { clearFrontendFallback, frontendNotFound } from '../../../src/server/frontend-fallback';

const originalFs = { ...fs };
const realStatSync = fs.statSync;
const PRIVATE_INODE = 9_007_199_254_740_992n;
const PUBLIC_INODE = PRIVATE_INODE + 1n;
const PUBLIC_BODY = 'console.log("synthetic public asset")';
const PRIVATE_BODY = '{"apiUrl":"https://synthetic-private-identity.example.test"}';
const fixtureInodes = new Map<string, bigint>();
let frontendDir: string;
let app: AnyElysia;
let origin: string;

/** Preserve real file metadata while supplying the large IDs NTFS can report. */
function fakeLargeInodeStatSync(
  ...args: Parameters<typeof fs.statSync>
): ReturnType<typeof fs.statSync> {
  const stats = realStatSync(...args);
  const inode = fixtureInodes.get(String(args[0]));
  if (!stats || inode === undefined) return stats;
  const result = Object.create(stats) as typeof stats;
  Object.defineProperty(result, 'ino', {
    value: typeof stats.ino === 'bigint' ? inode : Number(inode),
  });
  return result;
}

/** A named filesystem fake; every operation except fixture inode reporting stays real. */
function fakeLargeInodeFs() {
  return { ...originalFs, statSync: fakeLargeInodeStatSync };
}

/** Restore the original filesystem exports after the isolated file-identity tests. */
function originalFsModule() {
  return originalFs;
}

beforeEach(async () => {
  frontendDir = originalFs.mkdtempSync(join(tmpdir(), 'frontend-large-inodes-'));
  originalFs.mkdirSync(join(frontendDir, 'assets'));
  originalFs.writeFileSync(join(frontendDir, 'index.html'), '<html>synthetic shell</html>');
  const state = join(frontendDir, BUILD_STATE_FILE);
  const asset = join(frontendDir, 'assets', 'index-LargeId.js');
  const publicAlias = join(frontendDir, 'assets', 'linked-LargeId.js');
  const privateAlias = join(frontendDir, 'assets', 'private-LargeId.json');
  originalFs.writeFileSync(state, PRIVATE_BODY);
  originalFs.writeFileSync(asset, PUBLIC_BODY);
  originalFs.linkSync(asset, publicAlias);
  originalFs.linkSync(state, privateAlias);
  for (const [path, inode] of [
    [state, PRIVATE_INODE],
    [asset, PUBLIC_INODE],
    [publicAlias, PUBLIC_INODE],
    [privateAlias, PRIVATE_INODE],
  ] as const) {
    fixtureInodes.set(originalFs.realpathSync(path), inode);
  }
  mock.module('node:fs', fakeLargeInodeFs);
  const { registerFrontend } = await import('../../../src/server/frontend-static');
  app = new Elysia().error(NotFound, ({ request }) => frontendNotFound(request));
  registerFrontend(app as unknown as App, frontendDir);
  await app.modules;
  app.listen({ hostname: '127.0.0.1', port: 0, reusePort: false });
  origin = `http://127.0.0.1:${app.server?.port}`;
});

afterEach(async () => {
  if (app?.server) await app.stop();
  mock.module('node:fs', originalFsModule);
  fixtureInodes.clear();
  clearFrontendFallback();
  originalFs.rmSync(frontendDir, { recursive: true, force: true });
});

test('serves distinct large-inode assets even when their numeric IDs collide with private state', async () => {
  expect(PRIVATE_INODE).not.toBe(PUBLIC_INODE);
  expect(Number(PRIVATE_INODE)).toBe(Number(PUBLIC_INODE));
  for (const path of ['/assets/index-LargeId.js', '/assets/linked-LargeId.js']) {
    const response = await fetch(`${origin}${path}`);
    const body = await response.text();
    const etag = response.headers.get('etag') ?? '';
    expect(response.status, body).toBe(200);
    expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(response.headers.get('content-type')).toStartWith('text/javascript');
    expect(body).toBe(PUBLIC_BODY);
    expect(etag).not.toBe('');
    const cached = await fetch(`${origin}${path}`, { headers: { 'If-None-Match': etag } });
    expect(cached.status).toBe(304);
    expect(await cached.text()).toBe('');
  }
});

test('rejects a large-inode hardlink alias for private state without exposing its fixture', async () => {
  const response = await fetch(`${origin}/assets/private-LargeId.json`);
  const body = await response.text();
  expect(response.status, body).toBe(404);
  expect(body).not.toContain(PRIVATE_BODY);
});
