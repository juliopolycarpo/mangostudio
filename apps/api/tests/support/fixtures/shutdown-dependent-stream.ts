import type { AnyElysia } from 'elysia';

import { app } from '../../../src/app';
import { externalSessionManager } from '../../../src/modules/external-agents/application/external-session-manager';
import { terminalSessionService } from '../../../src/modules/terminals/application/terminal-session-service';
import { RuntimeConnectionManager } from '../../../src/services/runtime-client/runtime-connection-manager';

// Avoid carrying the full product route type into this fixture extension.
const fixtureApp: AnyElysia = app;

let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
let heartbeat: ReturnType<typeof setInterval> | undefined;

// A live response whose producer finishes only when session cleanup runs.
// The real Hub/Bun/Elysia lifecycle still owns listening and HTTP draining.
fixtureApp.get(
  '/__shutdown-stream',
  () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          stream = controller;
          controller.enqueue(new TextEncoder().encode('stream-ready\n'));
          heartbeat = setInterval(
            () => controller.enqueue(new TextEncoder().encode(': alive\n')),
            100
          );
          heartbeat.unref();
        },
        cancel() {
          clearInterval(heartbeat);
          stream = undefined;
        },
      }),
      { headers: { 'Content-Type': 'text/event-stream' } }
    )
);

fixtureApp.ws('/__shutdown-socket', {
  open(socket) {
    socket.send('socket-ready');
  },
  message() {},
});

const reapSessions = externalSessionManager.reapAll.bind(externalSessionManager);
externalSessionManager.reapAll = async (reason) => {
  await reapSessions(reason);
  console.warn('shutdown-fixture:external-reaped');
  clearInterval(heartbeat);
  stream?.close();
  stream = undefined;
};

const closeTerminals = terminalSessionService.closeAll.bind(terminalSessionService);
terminalSessionService.closeAll = async () => {
  await closeTerminals();
  console.warn('shutdown-fixture:terminals-closed');
};

const shutdownRuntime = RuntimeConnectionManager.prototype.shutdown;
RuntimeConnectionManager.prototype.shutdown = async function () {
  await shutdownRuntime.call(this);
  console.warn('shutdown-fixture:runtime-closed');
};
