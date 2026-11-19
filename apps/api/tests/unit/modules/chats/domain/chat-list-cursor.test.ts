import { describe, expect, it } from 'bun:test';

import {
  decodeChatListCursor,
  encodeChatListCursor,
  InvalidChatListCursorError,
} from '../../../../../src/modules/chats/domain/chat-list-cursor';

describe('chat list cursor', () => {
  it('round-trips a position through its opaque string', () => {
    const position = { updatedAt: 1_750_000_000_123, rowid: 42 };

    const encoded = encodeChatListCursor(position);

    expect(encoded).toBe('1750000000123:42');
    expect(decodeChatListCursor(encoded)).toEqual(position);
  });

  it.each(['', 'abc', '1750000000000', '1750000000000:', ':5', '1750000000000:5:7', 'NaN:5'])(
    'refuses %p and names the shape the server issues',
    (value) => {
      const attempt = () => decodeChatListCursor(value);

      expect(attempt).toThrow(InvalidChatListCursorError);
      expect(attempt).toThrow('expected shape: <updatedAt>:<rowid>');
    }
  );
});
