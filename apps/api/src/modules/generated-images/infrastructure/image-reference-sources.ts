/**
 * Every database column that can hold an `/images/<name>` URL of a generated
 * image. The delete path and the unreferenced-file sweep both read this list,
 * so a column missing from it makes the sweep delete a file a row still shows.
 *
 * A new writer of image URLs (a new table, or a new column on one of these)
 * must be added here. `image-reference-sources.test.ts` walks the live schema
 * and fails for any text column that is neither registered nor listed there as
 * known not to carry one.
 */
export interface ImageReferenceSource {
  readonly table: 'chats' | 'generated_images' | 'message_checkpoint_deltas' | 'messages';
  readonly column: string;
  /**
   * Columns that order the table for paging. `rowid` for ordinary tables; the
   * primary key for a `WITHOUT ROWID` table, which has no rowid to page by.
   */
  readonly pageKey: readonly string[];
  /** How a row belongs to a chat: its own column, or through the message it hangs off. */
  readonly chat: { readonly column: string } | { readonly messageColumn: string };
}

const MESSAGE_ROW = { pageKey: ['rowid'], chat: { column: 'chatId' } } as const;
const CHAT_ROW = { pageKey: ['rowid'], chat: { column: 'id' } } as const;

export const IMAGE_REFERENCE_SOURCES: readonly ImageReferenceSource[] = [
  // The artifact rows a finished turn records.
  { table: 'generated_images', column: 'imageUrl', pageKey: ['rowid'], chat: { column: 'chatId' } },
  // Legacy single-image messages, and a reference image sent with a prompt.
  { table: 'messages', column: 'imageUrl', ...MESSAGE_ROW },
  { table: 'messages', column: 'referenceImage', ...MESSAGE_ROW },
  // URLs inside larger text or JSON: the image part and tool result a turn
  // checkpoints before its artifact rows exist, and the provider's own history.
  { table: 'messages', column: 'text', ...MESSAGE_ROW },
  { table: 'messages', column: 'parts', ...MESSAGE_ROW },
  { table: 'messages', column: 'providerState', ...MESSAGE_ROW },
  // A streaming turn checkpoints full MessageParts as deltas, and only folds
  // them into the message row when the turn ends or is reconciled.
  {
    table: 'message_checkpoint_deltas',
    column: 'delta',
    pageKey: ['messageId', 'seq'],
    chat: { messageColumn: 'messageId' },
  },
  // Per-chat copies of the provider continuation state.
  { table: 'chats', column: 'lastProviderState', ...CHAT_ROW },
  { table: 'chats', column: 'lastContextState', ...CHAT_ROW },
];
