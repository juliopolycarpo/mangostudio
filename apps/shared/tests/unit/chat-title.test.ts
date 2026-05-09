import { describe, expect, it } from 'vitest';
import { createTimestampChatTitle } from '../../src/chat';

describe('createTimestampChatTitle', () => {
  it('formats a new chat title with a readable local timestamp', () => {
    const date = new Date(2026, 4, 9, 7, 5);

    const title = createTimestampChatTitle(date);

    expect(title).toBe('New Chat [2026-05-09 07:05]');
  });
});
