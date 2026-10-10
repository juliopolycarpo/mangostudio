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

function record(event: string): void {
  appendFileSync(eventsPath as string, `${JSON.stringify({ event, pid: process.pid })}\n`);
}

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: Number(process.env.API_PORT),
  fetch: () => new Response('healthy but not JSON'),
});

process.on('SIGTERM', async () => {
  record('sigterm');
  await server.stop(true);
  await Bun.sleep(100);
  record('exit');
  process.exit(0);
});
setTimeout(() => process.exit(3), 15_000);
record('startup');
