import { describe, expect, it } from 'bun:test';
import {
  PROMPT_HISTORY_LIMIT,
  readPromptHistory,
  recallNext,
  recallPrevious,
  recordPrompt,
} from '../../../../src/features/chat/lib/prompt-history';

const ENTRIES = ['newest', 'middle', 'oldest'] as const;

describe('prompt recall', () => {
  it('enters at the most recent entry and walks backwards', () => {
    let cursor = { entries: ENTRIES, index: null as number | null, draft: 'half typed' };

    const first = recallPrevious(cursor);
    expect(first).toEqual({ index: 0, text: 'newest' });

    cursor = { ...cursor, index: first?.index ?? null };
    expect(recallPrevious(cursor)).toEqual({ index: 1, text: 'middle' });
  });

  it('holds at the oldest entry rather than wrapping to the newest', () => {
    const cursor = { entries: ENTRIES, index: ENTRIES.length - 1, draft: '' };
    expect(recallPrevious(cursor)).toBeNull();
  });

  it('restores the stashed draft on the way out of history', () => {
    const cursor = { entries: ENTRIES, index: 0, draft: 'half typed' };
    expect(recallNext(cursor)).toEqual({ index: null, text: 'half typed' });
  });

  it('does nothing when the composer was never in history', () => {
    expect(recallNext({ entries: ENTRIES, index: null, draft: '' })).toBeNull();
    expect(recallPrevious({ entries: [], index: null, draft: '' })).toBeNull();
  });
});

describe('recordPrompt', () => {
  it('stores newest first and skips an immediate repeat', () => {
    sessionStorage.clear();
    recordPrompt('chat-1', 'first');
    recordPrompt('chat-1', 'second');
    recordPrompt('chat-1', 'second');
    expect(readPromptHistory('chat-1')).toEqual(['second', 'first']);
  });

  it('keeps a prompt sent again after others, because that is where you left off', () => {
    sessionStorage.clear();
    recordPrompt('chat-1', 'build');
    recordPrompt('chat-1', 'test');
    recordPrompt('chat-1', 'build');
    expect(readPromptHistory('chat-1')).toEqual(['build', 'test', 'build']);
  });

  it('keeps each chat separate and ignores blank sends', () => {
    sessionStorage.clear();
    recordPrompt('chat-1', 'one');
    recordPrompt('chat-2', 'two');
    recordPrompt('chat-1', '   ');
    expect(readPromptHistory('chat-1')).toEqual(['one']);
    expect(readPromptHistory('chat-2')).toEqual(['two']);
  });

  it('caps the depth', () => {
    sessionStorage.clear();
    for (let index = 0; index <= PROMPT_HISTORY_LIMIT + 5; index++) {
      recordPrompt('chat-1', `prompt ${index}`);
    }
    expect(readPromptHistory('chat-1')).toHaveLength(PROMPT_HISTORY_LIMIT);
    expect(readPromptHistory('chat-1')[0]).toBe(`prompt ${PROMPT_HISTORY_LIMIT + 5}`);
  });

  it('treats an unusable stored value as no history rather than throwing', () => {
    sessionStorage.clear();
    sessionStorage.setItem('mangostudio:composer-history:chat-1', '{"not":"an array"}');
    expect(readPromptHistory('chat-1')).toEqual([]);
    sessionStorage.setItem('mangostudio:composer-history:chat-1', 'not json at all');
    expect(readPromptHistory('chat-1')).toEqual([]);
    // Mixed contents keep the strings and drop the rest.
    sessionStorage.setItem('mangostudio:composer-history:chat-1', '["ok", 7, null]');
    expect(readPromptHistory('chat-1')).toEqual(['ok']);
  });
});
