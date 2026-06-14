#!/usr/bin/env bun

/**
 * Binary smoke test script.
 *
 * Behaviour:
 *   1. Builds the standalone bundle for the requested platform
 *      (skipped if SKIP_BUILD=1).
 *   2. Validates that the artifact layout is correct.
 *   3. If the binary can run on the current host, starts it and asserts
 *      that core HTTP endpoints respond correctly.
 *
 * Environment variables:
 *   PLATFORM      - Target platform (for example linux-x64). Required.
 *   SKIP_BUILD    - Set to 1 to skip the standalone build step.
 *   API_PORT      - Port for the smoke server (default: 13001).
 */

import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { captureCommand } from './lib/exec';
import {
  type BinaryTarget,
  filterBinaryTargets,
  releaseArchiveFileName,
} from './lib/release-targets';
import { resolveReleaseVersion } from './lib/release-version';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const ROOT_DIR = join(import.meta.dir, '..');
const OUT_DIR = join(ROOT_DIR, '.mango', 'out');
const REQUESTED_PLATFORM = process.env.PLATFORM;
const SKIP_BUILD = process.env.SKIP_BUILD === '1';
const PORT = parseInt(process.env.API_PORT ?? '13001', 10);
const RELEASE_ASSETS_DIR = join(ROOT_DIR, 'release-assets');
// Resolve via the canonical helper so the archive name we expect matches the one
// archive-assets.ts produces (same VERSION override + semver validation).
const VERSION = resolveReleaseVersion({ rootDir: ROOT_DIR });

const hostRuntimeByPlatform: Partial<
  Record<BinaryTarget['arch'], { platform: typeof process.platform; arch: typeof process.arch }>
> = {
  'linux-x64': { platform: 'linux', arch: 'x64' },
  'linux-arm64': { platform: 'linux', arch: 'arm64' },
  'windows-x64': { platform: 'win32', arch: 'x64' },
  'windows-arm64': { platform: 'win32', arch: 'arm64' },
  'darwin-x64': { platform: 'darwin', arch: 'x64' },
  'darwin-arm64': { platform: 'darwin', arch: 'arm64' },
};

const PLATFORM = resolvePlatform(REQUESTED_PLATFORM);

const BINARY_NAME = PLATFORM.name;
const CAN_EXECUTE = canExecutePlatform(PLATFORM);
const PLATFORM_DIR = join(OUT_DIR, PLATFORM.arch);
const BINARY_PATH = join(PLATFORM_DIR, BINARY_NAME);
const PUBLIC_DIR = join(PLATFORM_DIR, 'public');
const ARCHIVE_PATH = join(RELEASE_ASSETS_DIR, releaseArchiveFileName(VERSION, PLATFORM));

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

function resolvePlatform(platform: string | undefined): BinaryTarget {
  if (platform) {
    const [target] = filterBinaryTargets(platform);
    if (target) return target;
  }

  const supported = filterBinaryTargets()
    .map((target) => target.arch)
    .join(', ');
  console.error(`❌ PLATFORM must be one of: ${supported}`);
  console.error(
    '   Set it via environment variable: PLATFORM=linux-x64 bun run scripts/test-build.ts'
  );
  process.exit(1);
}

function canExecutePlatform(platform: BinaryTarget): boolean {
  if (platform.arch.endsWith('-musl')) return false;

  const expected = hostRuntimeByPlatform[platform.arch];
  return process.platform === expected?.platform && process.arch === expected.arch;
}

async function run(cmd: string[], cwd?: string, env?: Record<string, string>): Promise<void> {
  const {
    stdout: out,
    stderr: err,
    exitCode: code,
  } = await captureCommand(cmd, {
    cwd: cwd ?? ROOT_DIR,
    env,
  });

  if (code !== 0) {
    if (out.trim()) console.error(out.trim());
    if (err.trim()) console.error(err.trim());
    fail(`Command failed (exit ${code}): ${cmd.join(' ')}`);
  }

  if (out.trim()) console.log(out.trim());
}

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'mangostudio-smoke-'));
}

function removeTempDir(path: string): void {
  rmSync(path, { force: true, recursive: true });
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

async function buildBinary(): Promise<void> {
  console.log(`\n🔨 Building binary for ${PLATFORM.arch}...`);
  await run(['bun', 'run', 'build:binary', '--platform', PLATFORM.arch]);
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
// Release archive smoke test
// ---------------------------------------------------------------------------

async function archiveAssets(): Promise<void> {
  if (PLATFORM.arch !== 'linux-x64') {
    console.log('\n📦 Release archive smoke skipped for non-linux-x64 platform.');
    return;
  }

  console.log('\n📦 Archiving release assets...');
  await run(['bun', './scripts/release/archive-assets.ts', '--platform', PLATFORM.arch]);
  pass(`Release archive created: ${ARCHIVE_PATH}`);
}

async function validateReleaseArchive(): Promise<void> {
  if (PLATFORM.arch !== 'linux-x64') return;

  console.log('\n📦 Validating release archive layout...');
  const extractDir = makeTempDir();

  try {
    await run(['tar', '-xzf', ARCHIVE_PATH, '-C', extractDir]);
    validateExtractedArchive(extractDir);
  } finally {
    removeTempDir(extractDir);
  }
}

function validateExtractedArchive(extractDir: string): void {
  if (existsSync(join(extractDir, PLATFORM.arch)))
    fail('Archive contains nested platform directory');
  if (!existsSync(join(extractDir, BINARY_NAME))) fail(`Archive is missing ${BINARY_NAME}`);
  if (!existsSync(join(extractDir, 'public', 'index.html')))
    fail('Archive is missing public/index.html');
  if (!existsSync(join(extractDir, 'README.md'))) fail('Archive is missing README.md');

  const mode = statSync(join(extractDir, BINARY_NAME)).mode;
  if ((mode & 0o111) === 0) fail(`${BINARY_NAME} is not executable in archive`);
  pass('Archive has flat root with executable binary and public/index.html');
}

async function smokeLocalInstaller(): Promise<void> {
  if (PLATFORM.arch !== 'linux-x64' || process.platform !== 'linux') {
    console.log('\n📦 Local installer smoke skipped for this host/platform.');
    return;
  }

  console.log('\n📦 Installing release archive with install.sh --local...');
  const tempHome = makeTempDir();

  try {
    await run(['bash', 'scripts/install/install.sh', '--local', ARCHIVE_PATH], ROOT_DIR, {
      HOME: tempHome,
      MANGOSTUDIO_VERSION: VERSION,
    });
    await validateInstalledBinary(tempHome);
  } finally {
    removeTempDir(tempHome);
  }
}

async function validateInstalledBinary(tempHome: string): Promise<void> {
  const installed = join(tempHome, '.local', 'bin', 'mangostudio');
  if (!existsSync(installed)) fail(`Installer did not create ${installed}`);
  await run([installed, '--version'], ROOT_DIR, { HOME: tempHome });
  pass('install.sh --local created a runnable user binary');
}

// ---------------------------------------------------------------------------
// Runtime smoke test
// ---------------------------------------------------------------------------

async function smokeTest(): Promise<void> {
  console.log(`\n🚀 Starting binary on port ${PORT}...`);

  const tmpHome = makeTempDir();
  const dbPath = join(tmpHome, 'smoke.sqlite');

  // The binary is a CLI; bare invocation prints help, so start the server
  // explicitly in the foreground (API_PORT is honored by `serve`).
  const proc = Bun.spawn({
    cmd: [BINARY_PATH, 'serve'],
    cwd: PLATFORM_DIR,
    env: {
      ...process.env,
      HOME: tmpHome,
      DATABASE_PATH: dbPath,
      API_PORT: String(PORT),
      // Required since the auth-secret startup guard landed; a 32+ char
      // random value satisfies the runtime check without exposing a real key.
      BETTER_AUTH_SECRET: 'smoke-test-secret-at-least-32-characters-long',
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
      if (res.status === 404)
        fail('/api/auth/get-session returned 404 — SPA fallback is intercepting auth routes');
      const ct = res.headers.get('content-type') ?? '';
      if (ct.includes('text/html'))
        fail(`/api/auth/get-session returned text/html — SPA fallback is intercepting auth routes`);
      pass('/api/auth/get-session → handled by Better Auth (not intercepted by SPA fallback)');
    }
  } finally {
    proc.kill();
    await proc.exited.catch(() => undefined as undefined);
    removeTempDir(tmpHome);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

console.log(`\n🧪 Binary smoke test — platform: ${PLATFORM.arch}`);
console.log(`   Can execute on this host: ${CAN_EXECUTE}`);

if (!SKIP_BUILD) {
  await buildBinary();
}

validateLayout();
await archiveAssets();
await validateReleaseArchive();
await smokeLocalInstaller();

if (CAN_EXECUTE) {
  await smokeTest();
  console.log('\n✅ All runtime assertions passed.');
} else {
  console.log('\n✅ Packaging validation passed (runtime test skipped — cross-platform).');
}
