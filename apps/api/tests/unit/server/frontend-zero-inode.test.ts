import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BUILD_STATE_FILE, BUILD_STATE_URL_PATH } from '@mangostudio/shared/utils/dist-files';
import { type AnyElysia, Elysia, NotFound } from 'elysia';

import type { App } from '../../../src/app';
import { clearFrontendFallback, frontendNotFound } from '../../../src/server/frontend-fallback';

const originalFs = { ...fs };
const realStatSync = fs.statSync;
const PUBLIC_BODY = 'console.log("synthetic public asset")';
const PRIVATE_BODY = '{"apiUrl":"https://synthetic-private-zero-inode.example.test"}';
let frontendDir: string;
let app: AnyElysia;
let origin: string;

/**
 * Real file metadata, except that the volume reports no file ID: every path gets
 * `ino` 0, as exFAT/FAT and some SMB or FUSE mounts do.
 */
function fakeZeroInodeStatSync(
  ...args: Parameters<typeof fs.statSync>
): ReturnType<typeof fs.statSync> {
  const stats = realStatSync(...args);
  if (!stats) return stats;
  const result = Object.create(stats) as typeof stats;
  Object.defineProperty(result, 'ino', { value: typeof stats.ino === 'bigint' ? 0n : 0 });
  return result;
}

/** A named filesystem fake; every operation except inode reporting stays real. */
function fakeZeroInodeFs() {
  return { ...originalFs, statSync: fakeZeroInodeStatSync };
}

/** Restore the original filesystem exports after the zero-inode tests. */
function originalFsModule() {
  return originalFs;
}

beforeEach(async () => {
  frontendDir = originalFs.mkdtempSync(join(tmpdir(), 'frontend-zero-inode-'));
  originalFs.mkdirSync(join(frontendDir, 'assets'));
  originalFs.writeFileSync(join(frontendDir, 'index.html'), '<html>synthetic shell</html>');
  originalFs.writeFileSync(join(frontendDir, BUILD_STATE_FILE), PRIVATE_BODY);
  originalFs.writeFileSync(join(frontendDir, 'assets', 'index-ZeroId.js'), PUBLIC_BODY);
  originalFs.symlinkSync(
    join(frontendDir, BUILD_STATE_FILE),
    join(frontendDir, 'assets', 'state-link-ZeroId.json')
  );
  await mock.module('node:fs', fakeZeroInodeFs);
  const { registerFrontend } = await import('../../../src/server/frontend-static');
  app = new Elysia().onError(NotFound, ({ request }) => frontendNotFound(request));
  registerFrontend(app as unknown as App, frontendDir);
  await app.modules;
  app.listen({ hostname: '127.0.0.1', port: 0, reusePort: false });
  origin = `http://127.0.0.1:${app.server?.port}`;
});

afterEach(async () => {
  if (app?.server) await app.stop();
  await mock.module('node:fs', originalFsModule);
  clearFrontendFallback();
  originalFs.rmSync(frontendDir, { recursive: true, force: true });
});

test('serves public files when the volume reports inode 0 for every path', async () => {
  const asset = await fetch(`${origin}/assets/index-ZeroId.js`);
  const assetBody = await asset.text();
  expect(asset.status, `GET /assets/index-ZeroId.js with every ino 0: ${assetBody}`).toBe(200);
  expect(assetBody).toBe(PUBLIC_BODY);

  for (const path of ['/', '/index.html']) {
    const shell = await fetch(`${origin}${path}`);
    const shellBody = await shell.text();
    expect(shell.status, `GET ${path} with every ino 0: ${shellBody}`).toBe(200);
    expect(shellBody).toBe('<html>synthetic shell</html>');
  }
});

test('still refuses the build state and a symlink to it when every inode is 0', async () => {
  for (const path of [BUILD_STATE_URL_PATH, '/assets/state-link-ZeroId.json']) {
    const response = await fetch(`${origin}${path}`);
    const body = await response.text();
    expect(response.status, `GET ${path} must be refused by realpath, got body: ${body}`).toBe(404);
    expect(body).not.toContain(PRIVATE_BODY);
  }
});
