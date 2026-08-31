/**
 * The live stream and the reloaded transcript must render the same turn — the
 * internal half of what `external-turn-live-vs-reload.test.ts` pins for vendor
 * CLIs.
 *
 * Two independent pieces of code build message parts from one ordered sequence
 * of provider output: this app's reducer, which produces what is on screen
 * while the turn runs, and the shared `mergeMessageParts`, which the API calls
 * to produce what is stored. A divergence between them is invisible until
 * someone reloads the page and the turn they just watched looks different —
 * which is exactly what happened here, with prose written *before* a tool call
 * rendering *after* it live and before it on reload.
 *
 * `mergeMessageParts` is imported rather than re-implemented. Its input, the
 * per-delta `session.allParts`, is built here by hand because accumulating it
 * is one `push` per event in `stream-text-turn-stages.ts` — the rule worth
 * pinning lives in the merge, not in the push.
 */

import { describe, expect, it } from 'bun:test';
import { mergeMessageParts } from '@mangostudio/shared/generation';
import type { StreamChunk } from '@mangostudio/shared/streaming';
import type { MessagePart } from '@mangostudio/shared/types';
import {
  createTextGenerationStreamState,
  reduceTextGenerationStreamChunk,
} from '../../../../src/features/generation/text-generation-stream-reducer';

const REDUCER_OPTIONS = { pendingSubagentName: 'Pending subagent' };

function liveParts(chunks: readonly StreamChunk[]): MessagePart[] {
  let state = createTextGenerationStreamState({ userMessageId: 'u1', aiMessageId: 'a1' });
  for (const chunk of chunks) {
    state = reduceTextGenerationStreamChunk(state, chunk, REDUCER_OPTIONS);
  }
  return state.parts;
}

describe('internal turn: live stream vs reloaded transcript', () => {
  /**
   * The turn loop, at its smallest: say something, call a tool, say something
   * else. The reducer used to remove the `text` part and re-append it with the
   * whole accumulated text, so the live render read `[tool_call, text('ab')]`
   * — prose written before the call, shown after it, welded to prose that came
   * after — while the reload read the two sentences in the order they arrived.
   */
  it('keeps prose on the side of the tool call it was written on', () => {
    const live = liveParts([
      { type: 'text', text: 'a', done: false },
      { type: 'tool_call_started', callId: 'c1', name: 'search', done: false },
      {
        type: 'tool_call_completed',
        callId: 'c1',
        name: 'search',
        arguments: '{"q":"mango"}',
        done: false,
      },
      { type: 'text', text: 'b', done: false },
    ]);

    // What `stream-text-turn-stages` accumulates from the same provider events.
    const persisted = mergeMessageParts([
      { type: 'text', text: 'a' },
      { type: 'tool_call', toolCallId: 'c1', name: 'search', args: { q: 'mango' } },
      { type: 'text', text: 'b' },
    ]);

    const expected: MessagePart[] = [
      { type: 'text', text: 'a' },
      { type: 'tool_call', toolCallId: 'c1', name: 'search', args: { q: 'mango' } },
      { type: 'text', text: 'b' },
    ];

    expect(live).toEqual(expected);
    expect(persisted).toEqual(expected);
  });

  /**
   * A thought that follows prose stays after it, and stays *last* — which is
   * how the renderer decides which part is still streaming.
   */
  it('leaves a reasoning phase that follows prose trailing on both paths', () => {
    const live = liveParts([
      { type: 'text', text: 'Let me check.', done: false },
      { type: 'thinking_start', done: false },
      { type: 'thinking', text: 'The build script is generated.', done: false },
    ]);

    const persisted = mergeMessageParts([
      { type: 'text', text: 'Let me check.' },
      { type: 'thinking', text: 'The build script is generated.' },
    ]);

    expect(live).toEqual(persisted);
    expect(live.at(-1)).toEqual({ type: 'thinking', text: 'The build script is generated.' });
  });

  it('still collapses a run of deltas into one block on both paths', () => {
    const live = liveParts([
      { type: 'text', text: 'Hello ', done: false },
      { type: 'text', text: 'there', done: false },
    ]);

    const persisted = mergeMessageParts([
      { type: 'text', text: 'Hello ' },
      { type: 'text', text: 'there' },
    ]);

    expect(live).toEqual([{ type: 'text', text: 'Hello there' }]);
    expect(persisted).toEqual(live);
  });
});
