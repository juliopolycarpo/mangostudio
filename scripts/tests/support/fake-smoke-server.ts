// Named fake of the compiled `mangostudio` for scripts/release/smoke-binary.sh.
//
// It answers the three requests the smoke makes (`/api/health`, `/`, and the
// bundle `/` references) and records what happens to the process in the
// JSON-lines file named by FAKE_SMOKE_SERVER_EVENTS, so a test can tell how the
// smoke treated its server without sharing a process with it.
//
// This file is deliberately self-contained: the smoke copies the executable
// into a staging directory, so a relative import would not resolve there. The
// test materialises it as an executable with a bun shebang.
//
// SIGTERM is acknowledged, then honoured after a short delay, so a smoke that
// signals but does not wait for the server returns while it is still running.
//
// @example
// FAKE_SMOKE_SERVER_EVENTS=/tmp/events.jsonl FAKE_SMOKE_SERVER_VERSION=1.2.3 \
//   ./mangostudio serve 127.0.0.1:13003

import { appendFileSync } from 'node:fs';

const SHUTDOWN_DELAY_MS = 250;
// Backstop for a test that dies before it can clean up: the server leaves by
// itself rather than staying behind for good.
const DEADMAN_MS = 60_000;
const INDEX_HTML =
  '<html><body>Fake embedded UI<script src="/assets/index-fake.js"></script></body></html>\n';
const BUNDLE_JS = 'console.log("fake embedded asset");\n';

const eventsPath = process.env.FAKE_SMOKE_SERVER_EVENTS;
if (!eventsPath) {
  throw new Error(
    `Invalid FAKE_SMOKE_SERVER_EVENTS: ${JSON.stringify(eventsPath)}; expected a writable file path`
  );
}

/**
 * Append one occurrence to the events file.
 *
 * @example
 * record('startup', { args: ['serve', '127.0.0.1:13003'] });
 */
function record(event: string, detail: Record<string, unknown> = {}): void {
  const line = { event, pid: process.pid, at: Date.now(), ...detail };
  appendFileSync(eventsPath as string, `${JSON.stringify(line)}\n`);
}

/**
 * Serve the embedded UI the smoke expects.
 *
 * @example
 * respond(new Request('http://127.0.0.1/api/health')); // { "status": "ok" }
 */
function respond(request: Request): Response {
  const { pathname } = new URL(request.url);
  if (pathname === '/api/health') return Response.json({ status: 'ok' });
  if (pathname === '/') {
    return new Response(INDEX_HTML, { headers: { 'content-type': 'text/html' } });
  }
  if (pathname === '/assets/index-fake.js') {
    return new Response(BUNDLE_JS, { headers: { 'content-type': 'application/javascript' } });
  }
  return new Response('not found', { status: 404 });
}

const args = process.argv.slice(2);

if (args.length === 1 && args[0] === '--version') {
  const version = process.env.FAKE_SMOKE_SERVER_VERSION;
  if (!version) {
    throw new Error(
      `Invalid FAKE_SMOKE_SERVER_VERSION: ${JSON.stringify(version)}; expected the version string the smoke expects`
    );
  }
  console.log(version);
  process.exit(0);
}

const address = args[1] ?? '';
const match = /^127\.0\.0\.1:(\d{1,5})$/.exec(address);
if (args.length !== 2 || args[0] !== 'serve' || !match) {
  throw new Error(
    `Invalid fake server arguments ${JSON.stringify(args)}; expected serve 127.0.0.1:<port>`
  );
}

const server = Bun.serve({ hostname: '127.0.0.1', port: Number(match[1]), fetch: respond });
let stopping = false;

// Every delivery is recorded; only the first starts the shutdown, so a smoke
// that signals twice shows up as two events instead of being absorbed.
process.on('SIGTERM', async () => {
  record('sigterm');
  if (stopping) return;
  stopping = true;
  await server.stop(true);
  await Bun.sleep(SHUTDOWN_DELAY_MS);
  record('exit');
  process.exit(0);
});

setTimeout(() => {
  record('deadman');
  process.exit(3);
}, DEADMAN_MS);

record('startup', { args, cwd: process.cwd(), executable: process.argv[1] });
