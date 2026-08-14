import Type, { type Static } from 'typebox';

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
  code: Type.Optional(Type.String()),
  done: Type.Literal(true),
});

export type SSEErrorEvent = Static<typeof SSEErrorEventSchema>;

/**
 * RFC 9457 Problem Details, the negotiated alternative representation of
 * {@link ApiErrorResponseSchema}.
 *
 * Returned only when a client explicitly accepts `application/problem+json`;
 * `ApiErrorResponse` stays the default for every other request. Both are
 * rendered from one classification, so status, `code` and redaction cannot
 * diverge between them.
 *
 * `code` and `details` are RFC extension members carrying MangoStudio's own
 * contract unchanged. Both stay optional and untyped-beyond-`string` on purpose:
 * they mirror `ApiErrorResponse` exactly, so no caller loses information by
 * asking for problem details, and no caller gains a field the legacy shape
 * cannot express.
 *
 * @see https://www.rfc-editor.org/rfc/rfc9457
 */
export const ProblemDetailsSchema = Type.Object(
  {
    /** Stable URI naming the problem type. `about:blank` when no code was set. */
    type: Type.String(),
    /** Short, stable, non-sensitive summary of the problem type. */
    title: Type.String(),
    /** Always equal to the HTTP status of the response carrying it. */
    status: Type.Integer(),
    /** Caller-safe explanation of this occurrence — the legacy `error` text. */
    detail: Type.Optional(Type.String()),
    /** Public identifier for this occurrence. Never a server-internal path. */
    instance: Type.Optional(Type.String()),
    /** Extension member: MangoStudio's stable machine-readable error code. */
    code: Type.Optional(Type.String()),
    /** Extension member: the legacy field-level failure map, passed through. */
    details: Type.Optional(Type.Record(Type.String(), Type.String())),
  },
  { additionalProperties: false }
);

export type ProblemDetails = Static<typeof ProblemDetailsSchema>;
