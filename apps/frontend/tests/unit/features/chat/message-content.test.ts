/**
 * Unit tests for the chat message-content helpers.
 * Covers run-merging normalization, message-to-parts resolution with legacy
 * `text` fallback, and raw-markdown extraction used by the copy action.
 */

import type { Message, MessagePart } from '@mangostudio/shared';
import { describe, expect, it } from 'vitest';
import {
  extractRawMarkdown,
  messagePartsFromMessage,
  normalizeMessageParts,
} from '../../../../src/features/chat/components/message-content';

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'msg-1',
    chatId: 'chat-1',
    role: 'ai',
    text: '',
    timestamp: 0,
    ...overrides,
  };
}

describe('normalizeMessageParts', () => {
  it('merges consecutive text tokens into one block', () => {
    const parts: MessagePart[] = [
      { type: 'text', text: 'Hello ' },
      { type: 'text', text: 'world' },
    ];

    expect(normalizeMessageParts(parts)).toEqual([{ type: 'text', text: 'Hello world' }]);
  });

  it('merges interleaved thinking and text into one block each, preserving order', () => {
    const parts: MessagePart[] = [
      { type: 'thinking', text: 'The ' },
      { type: 'text', text: 'Let ' },
      { type: 'thinking', text: 'user ' },
      { type: 'text', text: 'me ' },
      { type: 'thinking', text: 'wants' },
      { type: 'text', text: 'go' },
    ];

    expect(normalizeMessageParts(parts)).toEqual([
      { type: 'thinking', text: 'The user wants' },
      { type: 'text', text: 'Let me go' },
    ]);
  });

  it('flushes pending runs before a non-text part to keep ordering', () => {
    const parts: MessagePart[] = [
      { type: 'thinking', text: 'plan ' },
      { type: 'text', text: 'answer' },
      { type: 'tool_call', toolCallId: 'c1', name: 'search', args: {} },
      { type: 'text', text: 'after tool' },
    ];

    expect(normalizeMessageParts(parts)).toEqual([
      { type: 'thinking', text: 'plan ' },
      { type: 'text', text: 'answer' },
      { type: 'tool_call', toolCallId: 'c1', name: 'search', args: {} },
      { type: 'text', text: 'after tool' },
    ]);
  });

  it('returns an empty array for empty input', () => {
    expect(normalizeMessageParts([])).toEqual([]);
  });
});

describe('messagePartsFromMessage', () => {
  it('returns normalized parts when present', () => {
    const msg = makeMessage({
      parts: [
        { type: 'text', text: 'a' },
        { type: 'text', text: 'b' },
      ],
    });

    expect(messagePartsFromMessage(msg)).toEqual([{ type: 'text', text: 'ab' }]);
  });

  it('falls back to legacy text when parts are absent', () => {
    const msg = makeMessage({ parts: undefined, text: 'legacy body' });

    expect(messagePartsFromMessage(msg)).toEqual([{ type: 'text', text: 'legacy body' }]);
  });

  it('returns no parts when neither parts nor text exist', () => {
    const msg = makeMessage({ parts: undefined, text: '' });

    expect(messagePartsFromMessage(msg)).toEqual([]);
  });
});

describe('extractRawMarkdown', () => {
  it('joins only text parts with blank lines', () => {
    const msg = makeMessage({
      parts: [
        { type: 'thinking', text: 'ignored thought' },
        { type: 'text', text: 'first' },
        { type: 'tool_call', toolCallId: 'c1', name: 'fn', args: {} },
        { type: 'text', text: 'second' },
      ],
    });

    // Adjacent text parts are merged first, so the blank-line join only appears
    // when a non-text part separates them.
    expect(extractRawMarkdown(msg)).toBe('first\n\nsecond');
  });

  it('returns an empty string when there is no text content', () => {
    const msg = makeMessage({ parts: [{ type: 'thinking', text: 'only thinking' }] });

    expect(extractRawMarkdown(msg)).toBe('');
  });
});
