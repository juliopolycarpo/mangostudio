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
 *   SKIP_BUILD    - Set to 1 to verify a manifest-backed prebuilt target.
 *   SOURCE_SHA    - Expected source commit when SKIP_BUILD=1.
 *   DISTRIBUTION_CHANNEL - Expected artifact channel when SKIP_BUILD=1.
 *   DISTRIBUTION_MANIFEST_PATH - Optional manifest override for tests.
 *   API_PORT      - Port for the smoke server (default: 13001).
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFakeChatGptServer } from '../apps/api/tests/support/chatgpt/fake-server';
import { extractTarArchive } from './lib/archive';
import {
  DISTRIBUTION_MANIFEST_FILE,
  readDistributionManifest,
  validateDistributionManifest,
} from './lib/distribution-manifest';
import { captureCommand } from './lib/exec';
import {
  type BinaryTarget,
  filterBinaryTargets,
  releaseArchiveFileName,
  releaseRawHubBinaryFileName,
  releaseRawRuntimeBinaryFileName,
  runtimeBinaryName,
} from './lib/release-targets';
import { resolveReleaseVersion } from './lib/release-version';
import { waitForServerReady } from './lib/wait-for-health';
import { findChecksum, sha256File } from './release/verify-checksum';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const ROOT_DIR = join(import.meta.dir, '..');
const OUT_DIR = join(ROOT_DIR, '.mango', 'out');
const REQUESTED_PLATFORM = process.env.PLATFORM;
const SKIP_BUILD = process.env.SKIP_BUILD === '1';
const PORT = parseInt(process.env.API_PORT ?? '13001', 10);
const RELEASE_ASSETS_DIR = join(ROOT_DIR, 'release-assets');
const DISTRIBUTION_MANIFEST_PATH =
  process.env.DISTRIBUTION_MANIFEST_PATH?.trim() || join(ROOT_DIR, DISTRIBUTION_MANIFEST_FILE);
const CHATGPT_CALLBACK_PORT = 1455;
const RUNTIME_HANDSHAKE_TIMEOUT_MS = 10_000;
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
const RUNTIME_BINARY_NAME = runtimeBinaryName(PLATFORM.name);
const CAN_EXECUTE = canExecutePlatform(PLATFORM);
const PLATFORM_DIR = join(OUT_DIR, PLATFORM.arch);
const BINARY_PATH = join(PLATFORM_DIR, BINARY_NAME);
const RUNTIME_BINARY_PATH = join(PLATFORM_DIR, RUNTIME_BINARY_NAME);
const ARCHIVE_PATH = join(RELEASE_ASSETS_DIR, releaseArchiveFileName(VERSION, PLATFORM));
const RAW_HUB_ASSET_NAME = releaseRawHubBinaryFileName(VERSION, PLATFORM);
const RAW_RUNTIME_ASSET_NAME = releaseRawRuntimeBinaryFileName(VERSION, PLATFORM);
const RAW_HUB_ASSET_PATH = join(RELEASE_ASSETS_DIR, RAW_HUB_ASSET_NAME);
const RAW_RUNTIME_ASSET_PATH = join(RELEASE_ASSETS_DIR, RAW_RUNTIME_ASSET_NAME);

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

  // The hub resolves the runtime as a sibling of its own executable, so a
  // release that ships one without the other cannot start stdio environments.
  if (!existsSync(RUNTIME_BINARY_PATH)) fail(`Missing runtime binary: ${RUNTIME_BINARY_PATH}`);
  pass(`Runtime binary exists: ${RUNTIME_BINARY_NAME}`);
}

function validatePrebuiltDistribution(): void {
  const sourceSha = process.env.SOURCE_SHA?.trim();
  const channel = process.env.DISTRIBUTION_CHANNEL?.trim();
  if (!sourceSha) fail('SOURCE_SHA is required when SKIP_BUILD=1.');
  if (!channel) fail('DISTRIBUTION_CHANNEL is required when SKIP_BUILD=1.');

  try {
    const manifest = readDistributionManifest(DISTRIBUTION_MANIFEST_PATH);
    validateDistributionManifest(manifest, {
      rootDir: ROOT_DIR,
      sourceSha,
      packageVersion: VERSION,
      channel,
      target: PLATFORM.arch,
    });
    pass(`Prebuilt distribution verified for ${PLATFORM.arch}`);
  } catch (caught) {
    fail(caught instanceof Error ? caught.message : String(caught));
  }
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
    await extractTarArchive(ARCHIVE_PATH, extractDir);
    validateExtractedArchive(extractDir);
  } finally {
    removeTempDir(extractDir);
  }

  validateRawReleaseAssets();
}

function validateRawReleaseAssets(): void {
  console.log('\n📦 Validating raw release binaries...');
  const checksumsPath = join(RELEASE_ASSETS_DIR, 'SHA256SUMS');
  if (!existsSync(checksumsPath)) fail('SHA256SUMS is missing from release-assets/');

  // Target distribution bundles ship archive + SHA256SUMS only. Under SKIP_BUILD,
  // prove the published raw checksums match the binaries extracted from that
  // archive instead of requiring duplicate uncompressed uploads in every target
  // artifact. Local/rebuild smoke still requires the real release-assets copies.
  const hubPath = existsSync(RAW_HUB_ASSET_PATH) ? RAW_HUB_ASSET_PATH : BINARY_PATH;
  const runtimePath = existsSync(RAW_RUNTIME_ASSET_PATH)
    ? RAW_RUNTIME_ASSET_PATH
    : RUNTIME_BINARY_PATH;

  if (!SKIP_BUILD) {
    if (!existsSync(RAW_HUB_ASSET_PATH)) fail(`Raw hub asset missing: ${RAW_HUB_ASSET_NAME}`);
    if (!existsSync(RAW_RUNTIME_ASSET_PATH)) {
      fail(`Raw runtime asset missing: ${RAW_RUNTIME_ASSET_NAME}`);
    }
  } else if (!existsSync(hubPath) || !existsSync(runtimePath)) {
    fail('Materialized hub/runtime binaries missing for raw checksum verification');
  }

  const manifest = readFileSync(checksumsPath, 'utf8');
  for (const [name, path] of [
    [RAW_HUB_ASSET_NAME, hubPath],
    [RAW_RUNTIME_ASSET_NAME, runtimePath],
  ] as const) {
    const expected = findChecksum(manifest, name);
    const actual = sha256File(path);
    if (actual !== expected) fail(`Checksum mismatch for ${name}`);
  }
  pass(`Raw hub and runtime assets verify against SHA256SUMS`);
}

function validateExtractedArchive(extractDir: string): void {
  if (existsSync(join(extractDir, PLATFORM.arch)))
    fail('Archive contains nested platform directory');
  if (!existsSync(join(extractDir, BINARY_NAME))) fail(`Archive is missing ${BINARY_NAME}`);
  if (!existsSync(join(extractDir, RUNTIME_BINARY_NAME)))
    fail(`Archive is missing ${RUNTIME_BINARY_NAME}`);
  if (!existsSync(join(extractDir, 'README.md'))) fail('Archive is missing README.md');

  for (const name of [BINARY_NAME, RUNTIME_BINARY_NAME]) {
    const mode = statSync(join(extractDir, name)).mode;
    if ((mode & 0o111) === 0) fail(`${name} is not executable in archive`);
  }
  pass('Archive has flat root with executable binaries and README.md');
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

  const installedRuntime = join(tempHome, '.mango', 'dist', VERSION, RUNTIME_BINARY_NAME);
  if (!existsSync(installedRuntime)) fail(`Installer did not place ${installedRuntime}`);
  pass('install.sh --local placed the runtime binary beside the hub binary');
}

/**
 * Runs a runtime binary the way the hub does: one NDJSON handshake over its
 * pipes. A binary that only answers `--version` can still be unable to serve.
 */
async function smokeRuntimeBinary(binaryPath: string = RUNTIME_BINARY_PATH): Promise<void> {
  const label = binaryPath === RUNTIME_BINARY_PATH ? RUNTIME_BINARY_NAME : binaryPath;
  console.log(`\n🔌 Running runtime binary smoke (${label})...`);

  const { stdout: versionOut, exitCode: versionExit } = await captureCommand([
    binaryPath,
    '--version',
  ]);
  if (versionExit !== 0) fail(`${label} --version exited ${versionExit}`);
  if (versionOut.trim() !== VERSION) {
    fail(`${label} reported ${versionOut.trim()}, expected ${VERSION}`);
  }
  pass(`${label} --version → ${VERSION}`);

  const child = Bun.spawn({
    cmd: [binaryPath, '--stdio'],
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  try {
    const hello = await readFirstLine(child.stdout, RUNTIME_HANDSHAKE_TIMEOUT_MS);
    if (!hello) fail(`${label} --stdio sent no handshake frame`);

    let frame: { type?: string; runtimeVersion?: string; manifest?: { platform?: string } };
    try {
      frame = JSON.parse(hello) as typeof frame;
    } catch {
      fail(`${label} --stdio wrote a non-JSON line to stdout: ${hello}`);
    }
    if (frame.type !== 'hello') fail(`Expected a hello frame, got: ${hello}`);
    if (frame.runtimeVersion !== VERSION) {
      fail(`Handshake reported runtime ${frame.runtimeVersion}, expected ${VERSION}`);
    }
    if (!frame.manifest?.platform) fail('Handshake carried no capability manifest');
    pass(`${label} --stdio handshakes with a v${VERSION} manifest`);
  } finally {
    child.stdin.end();
    child.kill();
    await child.exited.catch(() => undefined as undefined);
  }
}

/**
 * Reads one newline-terminated record, or null if the deadline passes first.
 *
 * Deliberately hand-rolled rather than reusing `RuntimeFrameDecoder`: this
 * script runs in the smoke matrix with `--no-install`, so it must have no
 * external runtime imports — `scripts/tests/smoke-dependencies.unit.test.ts`
 * enforces that. The shape assertions above stand in for schema validation.
 */
async function readFirstLine(
  stream: ReadableStream<Uint8Array>,
  timeoutMs: number
): Promise<string | null> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const deadline = Bun.sleep(timeoutMs).then(() => null);
  let buffered = '';

  try {
    while (true) {
      const chunk = await Promise.race([reader.read(), deadline]);
      if (!chunk || chunk.done) return null;
      buffered += decoder.decode(chunk.value, { stream: true });
      const newline = buffered.indexOf('\n');
      if (newline !== -1) return buffered.slice(0, newline);
    }
  } finally {
    reader.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// Runtime smoke test
// ---------------------------------------------------------------------------

const MODULE_RESOLUTION_FAILURE_PATTERNS = [
  'ResolveMessage',
  'Cannot find module',
  './642.js',
] as const;

function assertNoModuleResolutionFailures(text: string, label: string): void {
  for (const pattern of MODULE_RESOLUTION_FAILURE_PATTERNS) {
    if (text.includes(pattern)) {
      fail(`${label} contains forbidden module-resolution pattern: ${pattern}`);
    }
  }
}

function buildSessionCookieHeader(response: Response): string {
  const setCookies =
    typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : [response.headers.get('set-cookie')].filter((value): value is string => Boolean(value));

  if (setCookies.length === 0) {
    fail('Auth sign-up did not return a session cookie');
  }

  return setCookies.map((cookie) => cookie.split(';')[0]).join('; ');
}

/**
 * The deprecation, as the shipped binary enforces it.
 *
 * This replaces a smoke that existed to prove a vendored Node SDK tree resolved
 * from inside the compiled executable. That tree is gone, and what is worth
 * asserting now is the rule that replaced it: the endpoint refuses a new Cursor
 * connector regardless of what any picker rendered. Server stderr is still
 * checked for module-resolution failures, because a compiled binary is exactly
 * where those surface.
 */
async function smokeDeprecatedCursorConnector(
  port: number,
  sessionCookie: string,
  serverStderr: string
): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${port}/api/settings/connectors`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: sessionCookie,
    },
    body: JSON.stringify({
      name: 'smoke-cursor-connector',
      apiKey: 'smoke-invalid-cursor-key',
      source: 'config-file',
      provider: 'cursor',
    }),
  });

  const body = await response.text();
  assertNoModuleResolutionFailures(body, 'Cursor connector response body');
  assertNoModuleResolutionFailures(serverStderr, 'Server stderr');

  if (response.status !== 410) {
    fail(
      `POST /api/settings/connectors (cursor) returned ${response.status}; expected 410 for a deprecated provider. Body: ${body}`
    );
  }

  let payload: { error?: string };
  try {
    payload = JSON.parse(body) as { error?: string };
  } catch {
    fail(`Cursor connector refusal is not JSON: ${body}`);
  }
  if (!payload.error?.trim()) {
    fail('Cursor connector refusal is missing a user-facing error message');
  }

  pass('POST /api/settings/connectors (cursor) → 410 (deprecated provider)');
}

async function smokeChatGptConnector(port: number, sessionCookie: string): Promise<void> {
  const startResponse = await fetch(
    `http://127.0.0.1:${port}/api/settings/connectors/chatgpt/oauth/start`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: sessionCookie,
      },
      body: JSON.stringify({ name: 'smoke-chatgpt-connector' }),
    }
  );
  if (!startResponse.ok) {
    fail(`ChatGPT OAuth start failed with ${startResponse.status}: ${await startResponse.text()}`);
  }
  const started = (await startResponse.json()) as { sessionId: string; authorizeUrl: string };

  const callbackResponse = await fetch(started.authorizeUrl);
  if (!callbackResponse.ok) {
    fail(`ChatGPT OAuth callback failed with ${callbackResponse.status}`);
  }

  const status = await waitForChatGptOAuthStatus(port, sessionCookie, started.sessionId);
  if (status.status !== 'completed' || !status.connectorId) {
    fail(`ChatGPT OAuth did not complete: ${JSON.stringify(status)}`);
  }

  const connectorsResponse = await fetch(`http://127.0.0.1:${port}/api/settings/connectors`, {
    headers: { Cookie: sessionCookie },
  });
  if (!connectorsResponse.ok) {
    fail(`GET /api/settings/connectors failed with ${connectorsResponse.status}`);
  }
  const connectors = (await connectorsResponse.json()) as {
    connectors?: Array<{ id?: string; provider?: string; needsReauth?: boolean }>;
  };
  const connector = connectors.connectors?.find((item) => item.id === status.connectorId);
  if (connector?.provider !== 'chatgpt' || connector.needsReauth) {
    fail(`ChatGPT connector status is not healthy: ${JSON.stringify(connector)}`);
  }

  const modelsResponse = await fetch(`http://127.0.0.1:${port}/api/settings/models`, {
    headers: { Cookie: sessionCookie },
  });
  if (!modelsResponse.ok) {
    fail(`GET /api/settings/models failed with ${modelsResponse.status}`);
  }
  const models = (await modelsResponse.json()) as {
    allModels?: Array<{ provider?: string; modelId?: string }>;
  };
  const hasChatGptModel = models.allModels?.some(
    (model) => model.provider === 'chatgpt' && model.modelId === 'gpt-5.5'
  );
  if (!hasChatGptModel) {
    fail(`ChatGPT model catalog did not include gpt-5.5: ${JSON.stringify(models)}`);
  }

  pass('ChatGPT OAuth connector smoke completed and listed models');
}

async function waitForChatGptOAuthStatus(
  port: number,
  sessionCookie: string,
  sessionId: string
): Promise<{ status: string; connectorId?: string; error?: string }> {
  const deadline = Date.now() + 5_000;
  let lastStatus: { status: string; connectorId?: string; error?: string } = { status: 'pending' };
  while (Date.now() < deadline) {
    const response = await fetch(
      `http://127.0.0.1:${port}/api/settings/connectors/chatgpt/oauth/${sessionId}/status`,
      { headers: { Cookie: sessionCookie } }
    );
    if (!response.ok) fail(`ChatGPT OAuth status failed with ${response.status}`);
    lastStatus = (await response.json()) as typeof lastStatus;
    if (lastStatus.status !== 'pending') return lastStatus;
    await Bun.sleep(100);
  }
  return lastStatus;
}

function canBindChatGptCallbackPort(): boolean {
  let server: ReturnType<typeof Bun.serve> | null = null;
  try {
    server = Bun.serve({
      hostname: '127.0.0.1',
      port: CHATGPT_CALLBACK_PORT,
      fetch: () => new Response('ok'),
    });
    return true;
  } catch {
    return false;
  } finally {
    server?.stop(true);
  }
}

async function smokeTest(): Promise<void> {
  console.log(`\n🚀 Starting binary on port ${PORT}...`);

  const tmpHome = makeTempDir();
  const dbPath = join(tmpHome, 'smoke.sqlite');
  const authBaseUrl = `http://127.0.0.1:${PORT}`;
  const chatGptSmokeEnabled = canBindChatGptCallbackPort();
  const fakeChatGpt = chatGptSmokeEnabled ? startFakeChatGptServer() : null;
  let serverStderr = '';

  // The binary is a CLI; bare invocation prints help, so start the server
  // explicitly in the foreground (API_PORT is honored by `serve`).
  const proc = Bun.spawn({
    cmd: [BINARY_PATH, 'serve'],
    cwd: PLATFORM_DIR,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      HOME: tmpHome,
      DATABASE_PATH: dbPath,
      API_HOST: '127.0.0.1',
      API_PORT: String(PORT),
      BETTER_AUTH_URL: authBaseUrl,
      ...(fakeChatGpt
        ? {
            MANGO_CHATGPT_AUTH_BASE_URL: fakeChatGpt.authBaseUrl,
            MANGO_CHATGPT_BASE_URL: fakeChatGpt.apiBaseUrl,
            MANGO_SECRET_STORE_UNSAFE_FILE_FALLBACK_DIR: join(tmpHome, 'secret-store'),
          }
        : {}),
      // Required since the auth-secret startup guard landed; a 32+ char
      // random value satisfies the runtime check without exposing a real key.
      BETTER_AUTH_SECRET: 'smoke-test-secret-at-least-32-characters-long',
    },
    stdout: 'ignore',
    stderr: 'pipe',
  });

  const stderrReader = proc.stderr.getReader();
  const stderrPump = (async () => {
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await stderrReader.read();
      if (done) break;
      if (value) {
        serverStderr += decoder.decode(value, { stream: true });
      }
    }
    serverStderr += decoder.decode();
  })();

  try {
    console.log('   Waiting for server to be ready...');
    try {
      await waitForServerReady(`http://127.0.0.1:${PORT}/api/health`);
    } catch (caught) {
      fail(caught instanceof Error ? caught.message : String(caught));
    }

    console.log('\n🔍 Running HTTP assertions...');

    // /api/health → 200 JSON
    {
      const res = await fetch(`http://127.0.0.1:${PORT}/api/health`);
      if (res.status !== 200) fail(`/api/health returned ${res.status}`);
      const ct = res.headers.get('content-type') ?? '';
      if (!ct.includes('application/json')) fail(`/api/health content-type is not JSON: ${ct}`);
      pass('/api/health → 200 JSON');
    }

    // / → 200 HTML
    {
      const res = await fetch(`http://127.0.0.1:${PORT}/`);
      if (res.status !== 200) fail(`/ returned ${res.status}`);
      const body = await res.text();
      if (!body.includes('<html')) fail(`/ response does not contain <html>`);
      pass('/ → 200 HTML');
    }

    // /index.html → 200 HTML
    {
      const res = await fetch(`http://127.0.0.1:${PORT}/index.html`);
      if (res.status !== 200) fail(`/index.html returned ${res.status}`);
      pass('/index.html → 200 HTML');
    }

    // /assets/fake.js → 404 (must NOT be intercepted by SPA fallback)
    {
      const res = await fetch(`http://127.0.0.1:${PORT}/assets/fake.js`);
      if (res.status !== 404) fail(`/assets/fake.js should return 404, got ${res.status}`);
      pass('/assets/fake.js → 404 (SPA fallback bypassed)');
    }

    // /api/auth/get-session → NOT 404, NOT HTML
    // Verifies that the SPA onError handler does NOT intercept auth GET routes.
    // Better Auth may return text/plain or application/json depending on session
    // state — the key assertion is that the response is NOT the SPA index.html.
    {
      const res = await fetch(`http://127.0.0.1:${PORT}/api/auth/get-session`);
      if (res.status === 404)
        fail('/api/auth/get-session returned 404 — SPA fallback is intercepting auth routes');
      const ct = res.headers.get('content-type') ?? '';
      if (ct.includes('text/html'))
        fail(`/api/auth/get-session returned text/html — SPA fallback is intercepting auth routes`);
      pass('/api/auth/get-session → handled by Better Auth (not intercepted by SPA fallback)');
    }

    // The connector smokes both need an account. The Cursor one always runs —
    // it asserts a refusal, which needs nothing running behind it.
    {
      const signupEmail = `smoke-${Date.now()}@test.local`;
      const signupResponse = await fetch(`${authBaseUrl}/api/auth/sign-up/email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: signupEmail,
          password: 'smoke-pass-12345',
          name: 'Smoke User',
        }),
      });
      if (!signupResponse.ok) {
        const signupBody = await signupResponse.text();
        fail(`Auth sign-up failed with ${signupResponse.status}: ${signupBody}`);
      }
      pass('POST /api/auth/sign-up/email → session created');

      const sessionCookie = buildSessionCookieHeader(signupResponse);

      console.log('\n🔌 Running deprecated Cursor connector smoke...');
      await smokeDeprecatedCursorConnector(PORT, sessionCookie, serverStderr);

      if (fakeChatGpt) {
        console.log('\n🔌 Running ChatGPT connector smoke...');
        await smokeChatGptConnector(PORT, sessionCookie);
      } else {
        console.log(
          `\n⏭️  ChatGPT connector smoke skipped — port ${CHATGPT_CALLBACK_PORT} is already bound.`
        );
      }
    }
  } finally {
    proc.kill();
    await proc.exited.catch(() => undefined as undefined);
    await stderrPump.catch(() => undefined as undefined);
    fakeChatGpt?.stop();
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
  await archiveAssets();
} else {
  validatePrebuiltDistribution();
}

validateLayout();
await validateReleaseArchive();
await smokeLocalInstaller();

if (CAN_EXECUTE) {
  await smokeRuntimeBinary();
  if (PLATFORM.arch === 'linux-x64' && existsSync(RAW_RUNTIME_ASSET_PATH)) {
    await smokeRuntimeBinary(RAW_RUNTIME_ASSET_PATH);
  }
  await smokeTest();
  console.log('\n✅ All runtime assertions passed.');
} else {
  console.log('\n✅ Packaging validation passed (runtime test skipped — cross-platform).');
}
