/**
 * Directory-mode serving does blocking filesystem work on every request. These
 * tests pin how much: the root is resolved once per request, and the build-state
 * file is only stat-ed for a file that could be a hardlink to it.
 */
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
const realRealpathSync = fs.realpathSync;
const SHELL_BODY = '<html>synthetic shell</html>';
const ASSET_BODY = 'console.log("synthetic asset")';
const PRIVATE_BODY = '{"apiUrl":"https://synthetic-private-fs-calls.example.test"}';

/** What the counting fake saw since the last `resetCalls()`. */
const calls = { rootRealpaths: 0, buildStateStats: 0 };
let frontendDir: string;
let buildStatePath: string;
let app: AnyElysia;
let origin: string;

function resetCalls(): void {
  calls.rootRealpaths = 0;
  calls.buildStateStats = 0;
}

/** Real stat, counting the calls that name the private build-state file. */
function countingStatSync(...args: Parameters<typeof fs.statSync>): ReturnType<typeof fs.statSync> {
  if (String(args[0]) === buildStatePath) calls.buildStateStats += 1;
  return realStatSync(...args);
}

/** Real realpath, counting the calls that resolve the frontend root itself. */
function countingRealpathSync(...args: Parameters<typeof fs.realpathSync>): string {
  if (String(args[0]) === frontendDir) calls.rootRealpaths += 1;
  return realRealpathSync(...args) as string;
}

/** A named filesystem fake; every operation stays real, only the counted ones are observed. */
function countingFs() {
  return { ...originalFs, statSync: countingStatSync, realpathSync: countingRealpathSync };
}

/** Restore the original filesystem exports after the counting tests. */
function originalFsModule() {
  return originalFs;
}

beforeEach(async () => {
  // Canonical already, so the root realpath the fake counts is a call with this exact path.
  frontendDir = originalFs.realpathSync(
    originalFs.mkdtempSync(join(tmpdir(), 'frontend-fs-calls-'))
  );
  buildStatePath = join(frontendDir, BUILD_STATE_FILE);
  originalFs.mkdirSync(join(frontendDir, 'assets'));
  originalFs.writeFileSync(join(frontendDir, 'index.html'), SHELL_BODY);
  originalFs.writeFileSync(buildStatePath, PRIVATE_BODY);
  originalFs.writeFileSync(join(frontendDir, 'assets', 'index-FsCalls.js'), ASSET_BODY);
  originalFs.writeFileSync(join(frontendDir, 'favicon.ico'), 'icon');
  await mock.module('node:fs', countingFs);
  const { registerFrontend } = await import('../../../src/server/frontend-static');
  app = new Elysia().onError(NotFound, ({ request }) => frontendNotFound(request));
  registerFrontend(app as unknown as App, frontendDir);
  await app.modules;
  app.listen({ hostname: '127.0.0.1', port: 0, reusePort: false });
  origin = `http://127.0.0.1:${app.server?.port}`;
  resetCalls();
});

afterEach(async () => {
  if (app?.server) await app.stop();
  await mock.module('node:fs', originalFsModule);
  clearFrontendFallback();
  originalFs.rmSync(frontendDir, { recursive: true, force: true });
});

/** GET `path`, returning its status and body with the call counts it cost. */
async function getCounted(path: string) {
  resetCalls();
  const response = await fetch(`${origin}${path}`);
  const body = await response.text();
  return { status: response.status, body, ...calls };
}

test('resolves the root once and skips the build-state stat for a single-link asset', async () => {
  const result = await getCounted('/assets/index-FsCalls.js');
  expect(result.status, `GET /assets/index-FsCalls.js: ${result.body}`).toBe(200);
  expect(result.body).toBe(ASSET_BODY);
  expect(result.rootRealpaths, 'root realpaths for an asset').toBe(1);
  expect(result.buildStateStats, 'build-state stats for a single-link asset').toBe(0);
});

test('resolves the root once and skips the build-state stat for the shell at /', async () => {
  const result = await getCounted('/');
  expect(result.status, `GET /: ${result.body}`).toBe(200);
  expect(result.body).toBe(SHELL_BODY);
  expect(result.rootRealpaths, 'root realpaths for /').toBe(1);
  expect(result.buildStateStats, 'build-state stats for /').toBe(0);
});

test('resolves the root once for a dotted deep link that falls through to the shell', async () => {
  const result = await getCounted('/library/my-skill.md');
  expect(result.status, `GET /library/my-skill.md: ${result.body}`).toBe(200);
  expect(result.body).toBe(SHELL_BODY);
  expect(result.rootRealpaths, 'root realpaths for a dotted deep link').toBe(1);
  expect(result.buildStateStats, 'build-state stats for a dotted deep link').toBe(0);
});

test('resolves the root once for an undotted deep link', async () => {
  const result = await getCounted('/chat/synthetic-id');
  expect(result.status, `GET /chat/synthetic-id: ${result.body}`).toBe(200);
  expect(result.rootRealpaths, 'root realpaths for an undotted deep link').toBe(1);
});

test('does not resolve the root for a request that names no file and no SPA route', async () => {
  const result = await getCounted('/scalar');
  expect(result.status, `GET /scalar: ${result.body}`).toBe(404);
  expect(result.rootRealpaths, 'root realpaths for a non-file, non-SPA path').toBe(0);
});

test('still stats the build state for a hardlinked file and refuses an alias of it', async () => {
  originalFs.linkSync(join(frontendDir, 'favicon.ico'), join(frontendDir, 'favicon-alias.ico'));
  originalFs.linkSync(buildStatePath, join(frontendDir, 'assets', 'private-FsCalls.json'));

  const publicLink = await getCounted('/favicon-alias.ico');
  expect(publicLink.status, `GET /favicon-alias.ico: ${publicLink.body}`).toBe(200);
  expect(publicLink.buildStateStats, 'build-state stats for a hardlinked public file').toBe(1);

  const alias = await getCounted('/assets/private-FsCalls.json');
  expect(alias.status, 'a hardlink to the build state must answer 404').toBe(404);
  expect(alias.body).not.toContain(PRIVATE_BODY);
  // A miss runs the fallback once per NotFound handler (this app registers its own
  // ahead of `registerSpa`'s), so assert that the stat happened, not how often.
  expect(alias.buildStateStats, 'build-state stats for a build-state alias').toBeGreaterThan(0);
});
