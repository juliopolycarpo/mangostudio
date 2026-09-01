/**
 * Unit tests for the part-coalescing rule shared by the render path (the
 * frontend's `normalizeMessageParts`, which re-exports this same function),
 * the API's stream-finalization path, and the streaming reducer. If any of
 * them disagreed, a live turn and its reloaded self would disagree.
 */
import { describe, expect, it } from 'bun:test';
import { mergeMessageParts } from '../../../src/generation';
import type { MessagePart } from '../../../src/types/agent-events';

describe('mergeMessageParts — interleaved thinking segments', () => {
  it('preserves interleaved order: thinking, tool_call, tool_result, thinking, text', () => {
    const input: MessagePart[] = [
      { type: 'thinking', text: 'initial ' },
      { type: 'thinking', text: 'reasoning' },
      { type: 'tool_call', toolCallId: 'c1', name: 'search', args: {} },
      { type: 'tool_result', toolCallId: 'c1', content: '{}' },
      { type: 'thinking', text: 'after tool' },
      { type: 'text', text: 'final answer' },
    ];

    const result = mergeMessageParts(input);

    expect(result).toHaveLength(5);
    expect(result[0]).toEqual({ type: 'thinking', text: 'initial reasoning' });
    expect(result[1]).toEqual({ type: 'tool_call', toolCallId: 'c1', name: 'search', args: {} });
    expect(result[2]).toEqual({ type: 'tool_result', toolCallId: 'c1', content: '{}' });
    expect(result[3]).toEqual({ type: 'thinking', text: 'after tool' });
    expect(result[4]).toEqual({ type: 'text', text: 'final answer' });
  });

  it('produces a single thinking segment when there are no tool calls', () => {
    const input: MessagePart[] = [
      { type: 'thinking', text: 'chunk1 ' },
      { type: 'thinking', text: 'chunk2' },
      { type: 'text', text: 'answer' },
    ];

    const result = mergeMessageParts(input);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ type: 'thinking', text: 'chunk1 chunk2' });
    expect(result[1]).toEqual({ type: 'text', text: 'answer' });
  });

  it('produces no thinking parts when there is no reasoning', () => {
    const input: MessagePart[] = [
      { type: 'text', text: 'hello ' },
      { type: 'text', text: 'world' },
    ];

    const result = mergeMessageParts(input);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ type: 'text', text: 'hello world' });
    expect(result.some((p) => p.type === 'thinking')).toBe(false);
  });

  it('trailing thinking segment is preserved (thinking after last tool_result)', () => {
    const input: MessagePart[] = [
      { type: 'tool_call', toolCallId: 'c2', name: 'fn', args: {} },
      { type: 'tool_result', toolCallId: 'c2', content: '{}' },
      { type: 'thinking', text: 'post-tool reasoning' },
    ];

    const result = mergeMessageParts(input);

    expect(result).toHaveLength(3);
    expect(result[2]).toEqual({ type: 'thinking', text: 'post-tool reasoning' });
  });

  it('multiple tool call rounds preserve three separate thinking segments', () => {
    const input: MessagePart[] = [
      { type: 'thinking', text: 'before tool 1' },
      { type: 'tool_call', toolCallId: 'c1', name: 'fn1', args: {} },
      { type: 'tool_result', toolCallId: 'c1', content: 'r1' },
      { type: 'thinking', text: 'between tools' },
      { type: 'tool_call', toolCallId: 'c2', name: 'fn2', args: {} },
      { type: 'tool_result', toolCallId: 'c2', content: 'r2' },
      { type: 'thinking', text: 'after tools' },
      { type: 'text', text: 'done' },
    ];

    const result = mergeMessageParts(input);

    const thinkingParts = result.filter((p) => p.type === 'thinking');
    expect(thinkingParts).toHaveLength(3);
    expect(thinkingParts[0]).toEqual({ type: 'thinking', text: 'before tool 1' });
    expect(thinkingParts[1]).toEqual({ type: 'thinking', text: 'between tools' });
    expect(thinkingParts[2]).toEqual({ type: 'thinking', text: 'after tools' });
  });

  it('collapses consecutive text parts into a single text part', () => {
    const input: MessagePart[] = [
      { type: 'text', text: 'part1 ' },
      { type: 'text', text: 'part2 ' },
      { type: 'text', text: 'part3' },
    ];

    const result = mergeMessageParts(input);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ type: 'text', text: 'part1 part2 part3' });
  });

  it('returns an empty array for empty input', () => {
    expect(mergeMessageParts([])).toEqual([]);
  });

  /**
   * A run ends where a part of another kind begins. Holding a pending text run
   * open across a reasoning phase stored prose the model wrote *before* it
   * thought again as if it came after, and flushed thinking first, so a turn
   * that answered, reconsidered and answered again was persisted with its two
   * answers welded together above the thought that separated them.
   */
  it('does not move prose across a reasoning phase that interrupted it', () => {
    const input: MessagePart[] = [
      { type: 'text', text: 'a' },
      { type: 'thinking', text: 'b' },
      { type: 'text', text: 'c' },
    ];

    expect(mergeMessageParts(input)).toEqual([
      { type: 'text', text: 'a' },
      { type: 'thinking', text: 'b' },
      { type: 'text', text: 'c' },
    ]);
  });

  it('merges token-level interleaving only where the kinds are adjacent', () => {
    const input: MessagePart[] = [
      { type: 'thinking', text: 'The ' },
      { type: 'thinking', text: 'user ' },
      { type: 'thinking', text: 'wants me' },
      { type: 'text', text: 'Let ' },
      { type: 'text', text: 'me ' },
      { type: 'text', text: 'first explore' },
    ];

    expect(mergeMessageParts(input)).toEqual([
      { type: 'thinking', text: 'The user wants me' },
      { type: 'text', text: 'Let me first explore' },
    ]);
  });

  /**
   * Already-persisted rows are re-merged on every continuation, so the rule has
   * to be a no-op on its own output or a stored turn would drift each time it
   * was touched.
   */
  it('is idempotent over an already-merged row', () => {
    const stored: MessagePart[] = [
      { type: 'thinking', text: 'plan' },
      { type: 'tool_call', toolCallId: 'c1', name: 'fn', args: {} },
      { type: 'text', text: 'answer' },
    ];

    expect(mergeMessageParts(mergeMessageParts(stored))).toEqual(mergeMessageParts(stored));
    expect(mergeMessageParts(stored)).toEqual(stored);
  });

  it('drops an empty text part, which no event opens on purpose', () => {
    const input: MessagePart[] = [
      { type: 'text', text: '' },
      { type: 'tool_call', toolCallId: 'c1', name: 'fn', args: {} },
    ];

    expect(mergeMessageParts(input)).toEqual([
      { type: 'tool_call', toolCallId: 'c1', name: 'fn', args: {} },
    ]);
  });
});

/**
 * An empty reasoning *delta* is not an announced-but-withheld reasoning phase.
 *
 * The internal path has no `reasoning_started`: `thinking_start` is synthesized
 * from the first delta, so an empty one carries no meaning at all — unlike the
 * external path, where `reasoning_started` opens an empty part on purpose. The
 * old merge accumulated into a string and emitted only a non-empty run, so an
 * empty delta vanished; the adjacency rule keeps every `thinking` part, which
 * made it persist and render as "reasoning not shared" — asserting the model
 * withheld reasoning it never produced.
 *
 * Guarding the push (`stream-text-turn-stages.ts`) is what keeps that part out
 * of here in the first place. This pins the half that is this module's own: an
 * empty thinking part is still kept, because the *external* path needs it.
 */
describe('mergeMessageParts — an empty reasoning phase', () => {
  it('keeps an empty thinking part, which reasoning_started opens on purpose', () => {
    const input: MessagePart[] = [
      { type: 'thinking', text: '' },
      { type: 'text', text: 'answer' },
    ];

    expect(mergeMessageParts(input)).toEqual(input);
  });
});
