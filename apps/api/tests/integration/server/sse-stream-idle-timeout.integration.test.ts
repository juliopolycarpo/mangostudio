import { describe, expect, it } from 'bun:test';

import { HUB_IDLE_TIMEOUT_SECONDS, hubListenOptions } from '../../../src/lib/hub-connection-limits';
import { sseResponse } from '../../../src/lib/sse-stream';

// Bun.serve closes a connection that carries no bytes for `idleTimeout`
// seconds (10 on the hub's listener). A source that stays quiet for longer,
// such as an install step or an upgrade download, only keeps its stream if a
// keepalive lands inside the window. Bun's idle check is coarser than the
// setting: it closed such a stream about 12 s into the gap, so a 12 s gap races
// the close. 14 s is past it and shorter than the old 15 s beat.
const SILENT_GAP_MS = 14_000;
// How late past `idleTimeout` Bun was measured closing a silent stream.
const BUN_IDLE_CLOSE_SLACK_MS = 2_000;

interface StreamOutcome {
  events: unknown[];
  ending: string;
}

/** Reads the SSE body to its end, recording how it ended instead of throwing. */
async function readUntilEnd(response: Response): Promise<StreamOutcome> {
  const events: unknown[] = [];
  if (!response.body) return { events, ending: `no body (status ${response.status})` };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      let boundary = buffered.indexOf('\n\n');
      while (boundary >= 0) {
        const frame = buffered.slice(0, boundary);
        buffered = buffered.slice(boundary + 2);
        if (frame.startsWith('data: ')) events.push(JSON.parse(frame.slice('data: '.length)));
        boundary = buffered.indexOf('\n\n');
      }
    }
  } catch (error) {
    return { events, ending: `error: ${error instanceof Error ? error.message : String(error)}` };
  }
  return { events, ending: 'eof' };
}

describe('sseResponse behind the hub listener options', () => {
  it('keeps the silent gap past the point where Bun closes an idle stream', () => {
    // A larger idle timeout would let the gap below pass with any keepalive.
    expect(SILENT_GAP_MS).toBeGreaterThan(
      HUB_IDLE_TIMEOUT_SECONDS * 1_000 + BUN_IDLE_CLOSE_SLACK_MS
    );
  });

  it(
    'delivers the event sent after a silent gap longer than the idle timeout',
    async () => {
      async function* quietSource(): AsyncGenerator<{ type: string }> {
        yield { type: 'before-gap' };
        await Bun.sleep(SILENT_GAP_MS);
        yield { type: 'after-gap' };
      }
      const server = Bun.serve({
        ...hubListenOptions('127.0.0.1', 0),
        fetch: () => sseResponse(quietSource(), 'Quiet stream failed.'),
      });
      try {
        const outcome = await readUntilEnd(await fetch(server.url));

        expect(outcome).toEqual({
          events: [{ type: 'before-gap' }, { type: 'after-gap' }],
          ending: 'eof',
        });
      } finally {
        await server.stop(true);
      }
    },
    // The gap itself plus headroom for a loaded runner.
    SILENT_GAP_MS + 8_000
  );
});
