/**
 * Unit tests for the chat message-content helpers.
 * Covers run-merging normalization, message-to-parts resolution with legacy
 * `text` fallback, and raw-markdown extraction used by the copy action.
 */

import { describe, expect, it } from 'bun:test';
import type { Message, MessagePart } from '@mangostudio/shared';
import {
  extractRawMarkdown,
  isImageInteraction,
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

  /**
   * The marker an external turn writes on the part it stopped inside. Rebuilding
   * the run from its text alone dropped it, so a cancelled turn rendered as an
   * ordinary one — on the live path and after a reload alike, since both read
   * their parts through here.
   */
  it('keeps the incomplete marker when it rebuilds a run', () => {
    const parts: MessagePart[] = [{ type: 'text', text: 'Here is the pla', incomplete: true }];

    expect(normalizeMessageParts(parts)).toEqual([
      { type: 'text', text: 'Here is the pla', incomplete: true },
    ]);
  });

  /** A block that was cut short and then continued was not cut short. */
  it('takes the marker from where the run ends, not from anywhere in it', () => {
    const parts: MessagePart[] = [
      { type: 'text', text: 'first', incomplete: true },
      { type: 'text', text: ' second' },
    ];

    expect(normalizeMessageParts(parts)).toEqual([{ type: 'text', text: 'first second' }]);
  });

  /** Unlike `incomplete`, hidden content stays hidden whatever followed it. */
  it('keeps a redacted run marked redacted', () => {
    const parts: MessagePart[] = [
      { type: 'thinking', text: 'a', redacted: true },
      { type: 'thinking', text: 'b' },
    ];

    expect(normalizeMessageParts(parts)).toEqual([
      { type: 'thinking', text: 'ab', redacted: true },
    ]);
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

  /**
   * `reasoning_started` opens a `thinking` part with no text, because
   * `display: "omitted"` is the API default and that empty part is the whole
   * of what the reader ever sees of the phase. Rebuilding runs from their text
   * alone deleted it before it could render, so the one event announcing a
   * withheld reasoning phase showed nothing at all.
   */
  it('keeps a reasoning phase that opened with no text yet', () => {
    const parts: MessagePart[] = [{ type: 'thinking', text: '' }];

    expect(normalizeMessageParts(parts)).toEqual([{ type: 'thinking', text: '' }]);
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

describe('isImageInteraction', () => {
  it('is true for an explicit image interaction mode', () => {
    expect(isImageInteraction(makeMessage({ interactionMode: 'image' }))).toBe(true);
  });

  it('is true for a legacy message that only carries an imageUrl', () => {
    expect(
      isImageInteraction(makeMessage({ interactionMode: undefined, imageUrl: '/img.png' }))
    ).toBe(true);
  });

  it('is false for a chat interaction even when an imageUrl is present', () => {
    expect(isImageInteraction(makeMessage({ interactionMode: 'chat', imageUrl: '/img.png' }))).toBe(
      false
    );
  });

  it('is false for a plain text message with no image', () => {
    expect(isImageInteraction(makeMessage({ interactionMode: undefined, text: 'hi' }))).toBe(false);
  });
});
