/**
 * Test-only: a response carrying a field its closed schema does not declare
 * fails the test, as it did on Elysia rc.4.
 *
 * On rc.4 a handler that returned an undeclared key under a closed response
 * schema (`additionalProperties: false`) answered 500, which is how a route test
 * noticed a handler and its contract drifting apart. From rc.5 that key is
 * stripped silently, so the same drift would pass every test and reach clients
 * as a field quietly missing. Production keeps rc.5's stripping on purpose: it
 * is the safer answer for a client, who never sees an unlisted field, and a 500
 * on a live request is no better a way to find the drift.
 *
 * The rewrite is the one request bodies get from `closedBodies`
 * (`rejectUnknownBodyFields`), applied to the response schema instead, and
 * only by `createApiTestApp`. Mount it before the routes it should watch.
 */

import { Elysia } from 'elysia';

import { rejectUnknownBodyFields } from '../../../src/lib/reject-unknown-body-fields';

/** A schema, as opposed to the `{ 200: schema, 404: schema }` map a route may declare. */
function isSchema(value: object): boolean {
  return '~kind' in value || 'type' in value || '$ref' in value || 'anyOf' in value;
}

/**
 * Closes one route's `response`, which is either a schema or a map of status
 * code to schema.
 */
function closeResponseSchemas(response: unknown): unknown {
  if (typeof response !== 'object' || response === null) return response;
  if (isSchema(response)) return rejectUnknownBodyFields(response);

  return Object.fromEntries(
    Object.entries(response).map(([status, schema]) => [
      status,
      typeof schema === 'object' && schema !== null ? rejectUnknownBodyFields(schema) : schema,
    ])
  );
}

export const closedResponses = new Elysia({ name: 'closed-responses' })
  .macro({
    closeResponseSchema: {
      introspect(hook) {
        const route = hook as { response?: unknown };
        if (route.response) route.response = closeResponseSchemas(route.response);
      },
    },
  })
  .guard('global', { closeResponseSchema: true });
