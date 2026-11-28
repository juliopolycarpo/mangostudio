/**
 * Keeps an unknown request-body field a 422 on every route, without each route
 * having to ask.
 *
 * Elysia 2.0.0-rc.5 strips what a closed body schema (`additionalProperties:
 * false`) rejects instead of answering 422 as rc.4 did. `rejectUnknownBodyFields`
 * holds the rewrite that turns the closure into one Elysia does not strip; this
 * plugin runs it over the body schema of every route registered after it.
 *
 * The seam is a macro's `introspect`, which Elysia documents as the way to
 * "inspect or rewrite the hooks a route compiles with". It runs once per route
 * on the route's final hooks, so it sees the body whether the route declared it
 * itself or inherited it from a guard, and it replaces the compiled copy only:
 * the schema the route file imported, which the response, OpenAPI and frontend
 * types are derived from, is untouched. Because validation, not a hook, does the
 * rejecting, every content type Elysia parses into an object (JSON, a `+json`
 * type, urlencoded, multipart) is covered, and so is a body that coercion
 * reshapes before the check.
 *
 * Mount it before the route plugins: a global guard only reaches routes
 * registered after it, so a route registered earlier keeps its closed schema and
 * its unknown fields are stripped again. The contract test fails for any route
 * whose body still holds `additionalProperties: false`, so a misplaced mount
 * cannot go unnoticed.
 */

import { Elysia } from 'elysia';

import { rejectUnknownBodyFields } from '../lib/reject-unknown-body-fields';

export const closedBodies = new Elysia({ name: 'closed-bodies' })
  .macro({
    closeBodySchema: {
      introspect(hook) {
        const route = hook as { body?: unknown };
        if (route.body && typeof route.body === 'object') {
          route.body = rejectUnknownBodyFields(route.body);
        }
      },
    },
  })
  .guard('global', { closeBodySchema: true });
