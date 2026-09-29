/**
 * Encodes a large JSON response through a compiled validator instead of the
 * framework's interpreted one.
 *
 * Elysia 2 defers compiling a route's response validator until the route has
 * answered 16 times, and checks every response before that with TypeBox's
 * interpreted `Check`. That keeps startup cheap for a few hundred routes, but
 * the interpreted walk costs tens of microseconds per object, so a list
 * response pays it once per item. A hub process rarely reaches 16 requests to
 * the same list, so in practice every request takes the slow path.
 *
 * A route returning the `Response` built here keeps its `response` schema
 * declared for OpenAPI and client types, and Elysia skips its own check for a
 * `Response`. What Elysia would have done is repeated here, in the same order
 * and with the same packages: a compiled `Check` against the same schema, the
 * `exact-mirror` clean that drops keys the schema does not declare, then
 * `Response.json`. A value that fails the check throws Elysia's own response
 * `ValidationError`, so the error handler answers exactly as before.
 *
 * Compilation happens on the first call, not at import, so hub startup does
 * not pay for it.
 */

import { ValidationError } from 'elysia';
import createMirror from 'exact-mirror';
import type { Static, TSchema } from 'typebox';
import { Compile } from 'typebox/compile';

/** The compiled check an encoder runs; the shape `typebox/compile` returns. */
export interface CompiledCheck {
  Check(value: unknown): boolean;
  Errors(value: unknown): unknown[];
}

/** Builders the encoder compiles with; injectable so tests can observe them. */
export interface JsonResponseCompilers {
  compile(schema: TSchema): CompiledCheck;
  mirror(schema: TSchema): (value: unknown) => unknown;
}

/** The production builders: the same TypeBox compiler and mirror Elysia uses. */
export const typeboxJsonResponseCompilers: JsonResponseCompilers = {
  compile: (schema) => Compile(schema),
  mirror: (schema) => createMirror(schema, { Compile }),
};

/**
 * Returns an encoder that validates, cleans, and serializes values of
 * `schema` into a JSON `Response`, compiling both steps once on first use.
 *
 * @example
 * const encodeChatList = createJsonResponseEncoder(ChatListSchema);
 * app.get('/', { response: { 200: ChatListSchema } }, async () => encodeChatList(await list()));
 */
export function createJsonResponseEncoder<Schema extends TSchema>(
  schema: Schema,
  compilers: JsonResponseCompilers = typeboxJsonResponseCompilers
): (value: Static<Schema>) => Response {
  let compiled: { check: CompiledCheck; clean: (value: unknown) => unknown } | undefined;

  return (value) => {
    compiled ??= { check: compilers.compile(schema), clean: compilers.mirror(schema) };
    const { check, clean } = compiled;
    if (!check.Check(value)) {
      throw new ValidationError('response', value, () => check.Errors(value), schema);
    }
    return Response.json(clean(value));
  };
}
