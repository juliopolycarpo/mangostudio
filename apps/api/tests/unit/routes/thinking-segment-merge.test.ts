/**
 * Unit tests for the interleaved thinking segment-merging algorithm used in
 * respond-stream.ts before persisting the final message parts.
 */
import { describe, expect, it } from 'bun:test';
import type { MessagePart } from '@mangostudio/shared';

/**
 * Replicates the merging algorithm from respond-stream.ts.
 * Merges all thinking/text deltas within a structural section so token-level
 * interleaving from the provider does not create one block per word.
 */
function mergePartsForPersistence(allParts: MessagePart[]): MessagePart[] {
  const finalParts: MessagePart[] = [];
  let currentThinkingRun = '';
  let currentTextRun = '';

  const flushRuns = () => {
    if (currentThinkingRun) {
      finalParts.push({ type: 'thinking', text: currentThinkingRun });
      currentThinkingRun = '';
    }
    if (currentTextRun) {
      finalParts.push({ type: 'text', text: currentTextRun });
      currentTextRun = '';
    }
  };

  for (const part of allParts) {
    if (part.type === 'thinking') {
      currentThinkingRun += part.text;
    } else if (part.type === 'text') {
      currentTextRun += part.text;
    } else {
      flushRuns();
      finalParts.push(part);
    }
  }

  flushRuns();
  return finalParts;
}

describe('mergePartsForPersistence — interleaved thinking segments', () => {
  it('preserves interleaved order: thinking, tool_call, tool_result, thinking, text', () => {
    const input: MessagePart[] = [
      { type: 'thinking', text: 'initial ' },
      { type: 'thinking', text: 'reasoning' },
      { type: 'tool_call', toolCallId: 'c1', name: 'search', args: {} },
      { type: 'tool_result', toolCallId: 'c1', content: '{}' },
      { type: 'thinking', text: 'after tool' },
      { type: 'text', text: 'final answer' },
    ];

    const result = mergePartsForPersistence(input);

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

    const result = mergePartsForPersistence(input);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ type: 'thinking', text: 'chunk1 chunk2' });
    expect(result[1]).toEqual({ type: 'text', text: 'answer' });
  });

  it('produces no thinking parts when there is no reasoning', () => {
    const input: MessagePart[] = [
      { type: 'text', text: 'hello ' },
      { type: 'text', text: 'world' },
    ];

    const result = mergePartsForPersistence(input);

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

    const result = mergePartsForPersistence(input);

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

    const result = mergePartsForPersistence(input);

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

    const result = mergePartsForPersistence(input);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ type: 'text', text: 'part1 part2 part3' });
  });

  it('returns an empty array for empty input', () => {
    expect(mergePartsForPersistence([])).toEqual([]);
  });

  it('collapses token-level interleaving into one thinking block and one text block', () => {
    const input: MessagePart[] = [
      { type: 'thinking', text: 'The ' },
      { type: 'text', text: 'Let ' },
      { type: 'thinking', text: 'user ' },
      { type: 'text', text: 'me ' },
      { type: 'thinking', text: 'wants me' },
      { type: 'text', text: 'first explore' },
    ];

    const result = mergePartsForPersistence(input);

    expect(result).toEqual([
      { type: 'thinking', text: 'The user wants me' },
      { type: 'text', text: 'Let me first explore' },
    ]);
  });
});
