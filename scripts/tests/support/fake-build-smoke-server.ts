// Named fake for test-build.ts's foreground hub. Its health probe succeeds,
// then the smoke's first HTTP assertion fails because the response is not JSON.
// Usage: FAKE_BUILD_SMOKE_EVENTS=/tmp/events API_PORT=13001 ./mangostudio serve
import { appendFileSync } from 'node:fs';

const eventsPath = process.env.FAKE_BUILD_SMOKE_EVENTS;
if (!eventsPath) {
  throw new Error(
    `Invalid FAKE_BUILD_SMOKE_EVENTS: ${JSON.stringify(eventsPath)}; expected a writable events path`
  );
}
if (process.argv.slice(2).join(' ') !== 'serve') {
  throw new Error(
    `Invalid fake hub arguments: ${JSON.stringify(process.argv.slice(2))}; expected serve`
  );
}

function record(event: string, detail?: string): void {
  appendFileSync(
    eventsPath as string,
    `${JSON.stringify({ event, pid: process.pid, at: Date.now(), ...(detail ? { detail } : {}) })}\n`
  );
}

// `boot` proves the process ran its first line. A smoke script that is killed
// before any event exists never reached this file, which is the one fact that
// separates a stalled spawn from a hub that started and could not listen.
record('boot');

let server: ReturnType<typeof Bun.serve>;
try {
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: Number(process.env.API_PORT),
    fetch: () => new Response('healthy but not JSON'),
  });
} catch (caught) {
  // The test reserves its port by binding and releasing it, so another process
  // can take the number first; the smoke script would then wait for a health
  // answer until its timeout, with nothing naming the lost port.
  record('bind-failed', caught instanceof Error ? caught.message : String(caught));
  process.exit(4);
}

// eslint-disable-next-line @typescript-eslint/no-misused-promises -- The signal handler owns asynchronous shutdown before the fixture exits.
process.on('SIGTERM', async () => {
  record('sigterm');
  await server.stop(true);
  await Bun.sleep(100);
  record('exit');
  process.exit(0);
});
setTimeout(() => process.exit(3), 15_000);
record('startup');
