import { type Static, Type } from '@sinclair/typebox';

/** Generic API error response returned by all HTTP error paths. */
export const ApiErrorResponseSchema = Type.Object({
  error: Type.String(),
  code: Type.Optional(Type.String()),
  details: Type.Optional(Type.Record(Type.String(), Type.String())),
});

export type ApiErrorResponse = Static<typeof ApiErrorResponseSchema>;

/** SSE error event emitted by streaming endpoints when generation fails. */
export const SSEErrorEventSchema = Type.Object({
  type: Type.Literal('error'),
  error: Type.String(),
  done: Type.Literal(true),
});

export type SSEErrorEvent = Static<typeof SSEErrorEventSchema>;
