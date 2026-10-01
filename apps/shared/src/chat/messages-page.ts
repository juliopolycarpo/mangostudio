import Type, { type Static } from 'typebox';
import { MessageSchema } from './message';
import { ContextInfoSchema } from './schemas';

/**
 * One page of a chat transcript, oldest row first.
 *
 * `nextCursor` is `null` on the last page; otherwise it is an opaque token to
 * send back as `cursor`. `contextInfo` is present only on the first page.
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
