#!/usr/bin/env bun
/**
 * Binary smoke test script.
 *
 * Behaviour:
 *   1. Builds the frontend (skipped if SKIP_BUILD=1).
 *   2. Builds the binary for the requested platform.
 *   3. Validates that the artifact layout is correct.
 *   4. If the binary can run on the current host, starts it and asserts
 *      that core HTTP endpoints respond correctly.
 *
 * Environment variables:
 *   PLATFORM      - Target platform (linux-x64 | windows-x64). Required.
 *   SKIP_BUILD    - Set to 1 to skip frontend + binary build steps.
 *   API_PORT      - Port for the smoke server (default: 13001).
 */

import { join } from 'path';
import { existsSync } from 'fs';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const ROOT_DIR = join(import.meta.dir, '..');
const OUT_DIR = join(ROOT_DIR, '.mango', 'out');
const PLATFORM = process.env.PLATFORM;
const SKIP_BUILD = process.env.SKIP_BUILD === '1';
const PORT = parseInt(process.env.API_PORT ?? '13001', 10);

const PLATFORM_META: Record<string, { binary: string; canExecute: boolean }> = {
  'linux-x64': { binary: 'mangostudio', canExecute: process.platform === 'linux' },
  'windows-x64': { binary: 'mangostudio.exe', canExecute: process.platform === 'win32' },
};

if (!PLATFORM || !(PLATFORM in PLATFORM_META)) {
  console.error(`❌ PLATFORM must be one of: ${Object.keys(PLATFORM_META).join(', ')}`);
  console.error('   Set it via environment variable: PLATFORM=linux-x64 bun run scripts/test-build.ts');
  process.exit(1);
}

const { binary: BINARY_NAME, canExecute: CAN_EXECUTE } = PLATFORM_META[PLATFORM];
const PLATFORM_DIR = join(OUT_DIR, PLATFORM);
const BINARY_PATH = join(PLATFORM_DIR, BINARY_NAME);
const PUBLIC_DIR = join(PLATFORM_DIR, 'public');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pass(msg: string): void {
  console.log(`  ✅ ${msg}`);
}

function fail(msg: string): never {
  console.error(`  ❌ ${msg}`);
  process.exit(1);
}

async function run(cmd: string[], cwd?: string): Promise<void> {
  const proc = Bun.spawn({ cmd, cwd: cwd ?? ROOT_DIR, stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (code !== 0) {
    if (out.trim()) console.error(out.trim());
    if (err.trim()) console.error(err.trim());
    fail(`Command failed (exit ${code}): ${cmd.join(' ')}`);
  }

  if (out.trim()) console.log(out.trim());
}

async function waitFor(url: string, retries = 15, delayMs = 500): Promise<void> {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // not ready yet
    }
    await Bun.sleep(delayMs);
  }
  fail(`Server never became ready at ${url}`);
}

// ---------------------------------------------------------------------------
// Build steps
// ---------------------------------------------------------------------------

async function buildFrontend(): Promise<void> {
  console.log('\n📦 Building frontend...');
  await run(['bun', 'run', 'build']);
  pass('Frontend built');
}

async function buildBinary(): Promise<void> {
  console.log(`\n🔨 Building binary for ${PLATFORM}...`);
  const env = { ...process.env, ONLY_PLATFORM: PLATFORM };
  const proc = Bun.spawn({
    cmd: ['bun', 'run', 'build:binary'],
    cwd: ROOT_DIR,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    if (out.trim()) console.error(out.trim());
    if (err.trim()) console.error(err.trim());
    fail(`Binary build failed (exit ${code})`);
  }
  pass(`Binary built: ${BINARY_PATH}`);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateLayout(): void {
  console.log('\n📁 Validating artifact layout...');

  if (!existsSync(BINARY_PATH)) fail(`Missing binary: ${BINARY_PATH}`);
  pass(`Binary exists: ${BINARY_NAME}`);

  if (!existsSync(join(PUBLIC_DIR, 'index.html'))) fail(`Missing public/index.html`);
  pass('public/index.html exists');

  const jsFiles = Array.from(new Bun.Glob('*.js').scanSync(join(PUBLIC_DIR, 'assets')));
  if (jsFiles.length === 0) fail('No JS files in public/assets/');
  pass(`JS assets: ${jsFiles.length} file(s)`);

  const cssFiles = Array.from(new Bun.Glob('*.css').scanSync(join(PUBLIC_DIR, 'assets')));
  if (cssFiles.length === 0) fail('No CSS files in public/assets/');
  pass(`CSS assets: ${cssFiles.length} file(s)`);
}

// ---------------------------------------------------------------------------
// Runtime smoke test
// ---------------------------------------------------------------------------

async function smokeTest(): Promise<void> {
  console.log(`\n🚀 Starting binary on port ${PORT}...`);

  const tmpHome = await Bun.$`mktemp -d`.text().then((t) => t.trim());
  const dbPath = join(tmpHome, 'smoke.sqlite');

  const proc = Bun.spawn({
    cmd: [BINARY_PATH],
    cwd: PLATFORM_DIR,
    env: {
      ...process.env,
      HOME: tmpHome,
      DATABASE_PATH: dbPath,
      API_PORT: String(PORT),
    },
    stdout: 'ignore',
    stderr: 'ignore',
  });

  try {
    console.log('   Waiting for server to be ready...');
    await waitFor(`http://localhost:${PORT}/api/health`);

    console.log('\n🔍 Running HTTP assertions...');

    // /api/health → 200 JSON
    {
      const res = await fetch(`http://localhost:${PORT}/api/health`);
      if (res.status !== 200) fail(`/api/health returned ${res.status}`);
      const ct = res.headers.get('content-type') ?? '';
      if (!ct.includes('application/json')) fail(`/api/health content-type is not JSON: ${ct}`);
      pass('/api/health → 200 JSON');
    }

    // / → 200 HTML
    {
      const res = await fetch(`http://localhost:${PORT}/`);
      if (res.status !== 200) fail(`/ returned ${res.status}`);
      const body = await res.text();
      if (!body.includes('<html')) fail(`/ response does not contain <html>`);
      pass('/ → 200 HTML');
    }

    // /index.html → 200 HTML
    {
      const res = await fetch(`http://localhost:${PORT}/index.html`);
      if (res.status !== 200) fail(`/index.html returned ${res.status}`);
      pass('/index.html → 200 HTML');
    }

    // /assets/fake.js → 404 (must NOT be intercepted by SPA fallback)
    {
      const res = await fetch(`http://localhost:${PORT}/assets/fake.js`);
      if (res.status !== 404) fail(`/assets/fake.js should return 404, got ${res.status}`);
      pass('/assets/fake.js → 404 (SPA fallback bypassed)');
    }

    // /api/auth/get-session → NOT 404, NOT HTML
    // Verifies that the SPA onError handler does NOT intercept auth GET routes.
    // Better Auth may return text/plain or application/json depending on session
    // state — the key assertion is that the response is NOT the SPA index.html.
    {
      const res = await fetch(`http://localhost:${PORT}/api/auth/get-session`);
      if (res.status === 404) fail('/api/auth/get-session returned 404 — SPA fallback is intercepting auth routes');
      const ct = res.headers.get('content-type') ?? '';
      if (ct.includes('text/html')) fail(`/api/auth/get-session returned text/html — SPA fallback is intercepting auth routes`);
      pass('/api/auth/get-session → handled by Better Auth (not intercepted by SPA fallback)');
    }
  } finally {
    proc.kill();
    await proc.exited.catch(() => {});
    await Bun.$`rm -rf ${tmpHome}`.quiet();
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

console.log(`\n🧪 Binary smoke test — platform: ${PLATFORM}`);
console.log(`   Can execute on this host: ${CAN_EXECUTE}`);

if (!SKIP_BUILD) {
  await buildFrontend();
  await buildBinary();
}

validateLayout();

if (CAN_EXECUTE) {
  await smokeTest();
  console.log('\n✅ All runtime assertions passed.');
} else {
  console.log('\n✅ Packaging validation passed (runtime test skipped — cross-platform).');
}
