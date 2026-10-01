import Type, { type Static } from 'typebox';
import { MessageSchema } from './message';
import { ContextInfoSchema } from './schemas';

/**
 * One page of a chat transcript. Rows inside a page are chronological, oldest
 * first, whichever `order` the page was requested in: `asc` returns the oldest
 * rows of the transcript (or of what follows `cursor`), `desc` the newest rows
 * (or of what precedes `cursor`), and both hand them over oldest-first.
 *
 * `nextCursor` is `null` on the last page; otherwise it is an opaque token to
 * send back as `cursor`, naming the row at the edge of this page that faces the
 * rows not read yet: its last row for `asc`, its first row for `desc`.
 * `contextInfo` is present only on the first page.
 *
 * Each row is a {@link MessageSchema}: the stored row as the API has always
 * sent it, `null` columns included.
 */
export const MessagesPageSchema = Type.Object({
  messages: Type.Array(MessageSchema),
  nextCursor: Type.Union([Type.String(), Type.Null()]),
  contextInfo: Type.Optional(Type.Union([ContextInfoSchema, Type.Null()])),
});

export type MessagesPage = Static<typeof MessagesPageSchema>;
