/**
 * Turns an `AsyncIterable` of JSON-serializable events into a Server-Sent
 * Events `Response`: a heartbeat comment keeps a reverse proxy from closing
 * an idle connection, an uncaught throw from the source becomes one
 * `SSEErrorEvent` rather than a dropped connection, and a disconnecting
 * client's `cancel()` returns the source's own iterator so it can clean up.
 *
 * Every route that streams progress this way (`/environments/install/:runId/
 * log`, `/machine/upgrade`) goes through this one implementation rather than
 * its own copy.
 */

import { ERROR_CODES } from '@mangostudio/shared/errors';
import type { SSEErrorEvent } from '@mangostudio/shared/streaming';

const KEEPALIVE_INTERVAL_MS = 15_000;
const ENCODER = new TextEncoder();
const KEEPALIVE_BYTES = ENCODER.encode(': keepalive\n\n');

function sseEvent(data: object): Uint8Array {
  return ENCODER.encode(`data: ${JSON.stringify(data)}\n\n`);
}

/**
 * Build the SSE response. `errorMessage` is the fallback text for a thrown
 * non-`Error` value; a real `Error`'s own message is used when there is one.
 * // Usage: return sseResponse(source, 'Upgrade stream failed.')
 */
export function sseResponse<T extends object>(
  source: AsyncIterable<T>,
  errorMessage: string
): Response {
  const iterator = source[Symbol.asyncIterator]();
  let disconnected = false;

  const stream = new ReadableStream({
    async start(controller) {
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(KEEPALIVE_BYTES);
        } catch {
          // The client may already have disconnected.
        }
      }, KEEPALIVE_INTERVAL_MS);
      try {
        while (!disconnected) {
          const next = await iterator.next();
          if (next.done) break;
          controller.enqueue(sseEvent(next.value));
        }
      } catch (error) {
        if (!disconnected) {
          const event: SSEErrorEvent = {
            type: 'error',
            error: error instanceof Error ? error.message : errorMessage,
            code: ERROR_CODES.INTERNAL,
            done: true,
          };
          controller.enqueue(sseEvent(event));
        }
      } finally {
        clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          // The browser may have cancelled the stream.
        }
      }
    },
    async cancel() {
      disconnected = true;
      await iterator.return?.();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
