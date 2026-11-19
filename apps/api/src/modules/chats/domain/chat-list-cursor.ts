import { parseCursorPosition } from '../../messages/domain/cursor-position';

/**
 * Position of one chat in the order the chat list is paged: `updatedAt`
 * descending, then `rowid` ascending (creation order for chats that share a
 * millisecond). It is the last chat a page served; the next page is everything
 * after it in that order.
 */
export interface ChatListCursor {
  updatedAt: number;
  rowid: number;
}

export const CHAT_LIST_CURSOR_SHAPE = '<updatedAt>:<rowid>';

/** Raised when a client sends a cursor this server did not issue. */
export class InvalidChatListCursorError extends Error {
  constructor(value: string) {
    super(
      `Invalid chat list cursor: ${JSON.stringify(value)} | expected shape: ${CHAT_LIST_CURSOR_SHAPE}`
    );
    this.name = 'InvalidChatListCursorError';
  }
}

/**
 * Encodes a cursor as the opaque string a client sends back unchanged.
 *
 * @example
 * encodeChatListCursor({ updatedAt: 1700000000000, rowid: 42 }); // '1700000000000:42'
 */
export function encodeChatListCursor(cursor: ChatListCursor): string {
  return `${cursor.updatedAt}:${cursor.rowid}`;
}

/**
 * Decodes a cursor produced by {@link encodeChatListCursor}. A bare timestamp
 * is refused: the list never issued one, and without a `rowid` the position
 * inside a tie is unknown.
 *
 * @example
 * decodeChatListCursor('1700000000000:42'); // { updatedAt: 1700000000000, rowid: 42 }
 * decodeChatListCursor('1700000000000'); // throws InvalidChatListCursorError
 */
export function decodeChatListCursor(value: string): ChatListCursor {
  const position = parseCursorPosition(value);
  if (position?.rowid === undefined || position.rowid === null) {
    throw new InvalidChatListCursorError(value);
  }
  return { updatedAt: position.timestamp, rowid: position.rowid };
}
