import Type, { type Static } from 'typebox';
import type { Message } from './entities';
import { ContextInfoSchema } from './schemas';

/**
 * One page of a chat transcript, oldest row first.
 *
 * `nextCursor` is `null` on the last page; otherwise it is an opaque token to
 * send back as `cursor`. `contextInfo` is present only on the first page.
 *
 * The row shape stays the hand-written `Message` interface: it is wider than
 * this contract and has no schema yet, so each row is declared as an open
 * object here instead of being re-described.
 */
export const MessagesPageSchema = Type.Object({
  messages: Type.Array(Type.Unsafe<Message>(Type.Object({}, { additionalProperties: true }))),
  nextCursor: Type.Union([Type.String(), Type.Null()]),
  contextInfo: Type.Optional(Type.Union([ContextInfoSchema, Type.Null()])),
});

export type MessagesPage = Static<typeof MessagesPageSchema>;
