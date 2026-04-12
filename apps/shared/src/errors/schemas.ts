import { Type, type Static } from '@sinclair/typebox';

export const ApiErrorResponseSchema = Type.Object({
  error: Type.String(),
  code: Type.Optional(Type.String()),
  details: Type.Optional(Type.Record(Type.String(), Type.String())),
});

export type ApiErrorResponse = Static<typeof ApiErrorResponseSchema>;

export const SSEErrorEventSchema = Type.Object({
  type: Type.Literal('error'),
  error: Type.String(),
  done: Type.Literal(true),
});

export type SSEErrorEvent = Static<typeof SSEErrorEventSchema>;
