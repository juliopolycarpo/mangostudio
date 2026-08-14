/**
 * A failure on the spec route, which is the one route `errorHandler` cannot see.
 *
 * `@elysia/openapi` puts a local `error` hook on the spec route that logs and
 * returns nothing. It consumes the failure before `errorHandler`'s arms — which
 * are mounted later still, inside the `/api` instance — ever run, so Elysia
 * falls back to its own renderer and publishes the raw exception message as
 * `detail` on an unauthenticated endpoint. `openapiProblemDetails` is seated
 * ahead of the plugin and answers first.
 *
 * These compose a miniature root rather than the real `app`, because forcing
 * the generator to throw means configuring `openapi()`. The mirror keeps the one
 * property under test — `openapiProblemDetails` before `openapi()`, the error
 * handler after both — and the assertion that the real `app` still composes them
 * that way lives in the problem-details integration suite.
 */

import { describe, expect, it } from 'bun:test';
import { openapi } from '@elysia/openapi';
import {
  ApiErrorResponseSchema,
  ERROR_CODES,
  PROBLEM_JSON_ACCEPT,
  PROBLEM_JSON_MEDIA_TYPE,
  ProblemDetailsSchema,
  problemTypeUri,
} from '@mangostudio/shared/errors';
import { Elysia } from 'elysia';
import Value from 'typebox/value';
import { errorHandler } from '../../../src/plugins/error-handler';
import {
  OPENAPI_PATH,
  OPENAPI_SPEC_PATH,
  openapiProblemDetails,
} from '../../../src/server/openapi-problem-details';

describe('a spec route that fails to generate', () => {
  const THROWN_MESSAGE = 'connection string postgres://user:hunter2@db.internal/mango';

  /**
   * Reach `toOpenAPISchema` and throw inside the handler.
   *
   * Synthetic — the realistic trigger is a route schema the converter cannot
   * express — but it needs no fixture route and does not depend on which
   * conversion happens to be fragile this week. If an `@elysia/openapi` bump
   * stops routing `exclude.methods` through `.toLowerCase()` these stop failing
   * generation, which is a signal worth having rather than a silent gap.
   */
  const exclude = {
    methods: [
      {
        toLowerCase() {
          throw new Error(THROWN_MESSAGE);
        },
      },
    ],
  } as unknown as { methods: string[] };

  function failingSpecApp(options: { guarded: boolean }) {
    const api = new Elysia({ prefix: '/api' })
      .use(errorHandler)
      .get('/health', () => ({ ok: true }));
    const root = new Elysia();
    return (options.guarded ? root.use(openapiProblemDetails) : root)
      .use(openapi({ path: OPENAPI_PATH, exclude }))
      .use(api);
  }

  /**
   * Fetch the spec, returning the response alongside what was logged.
   *
   * The plugin and the guard both write the failure to the console on purpose,
   * so silencing it is what keeps this suite's output readable — and capturing
   * it is what lets the sanitized answer be checked against the server-side
   * record that has to survive it.
   */
  async function fetchSpec(
    // Structural rather than `Elysia`: the ternary in `failingSpecApp` widens to
    // a union of two fully-parameterized instances that no bare `Elysia`
    // annotation accepts, and `handle` is the entire surface used here.
    root: { handle(request: Request): Promise<Response> },
    options: { accept?: string; path?: string; method?: string } = {}
  ): Promise<{ response: Response; logged: string }> {
    const { error, warn, log } = console;
    const lines: string[] = [];
    const capture = (...args: unknown[]) => lines.push(args.map(String).join(' '));
    console.error = capture;
    console.warn = capture;
    console.log = capture;

    try {
      const response = await root.handle(
        new Request(`http://localhost${options.path ?? OPENAPI_SPEC_PATH}`, {
          method: options.method ?? 'GET',
          ...(options.accept ? { headers: { accept: options.accept } } : {}),
        })
      );
      // Read the body before the console is restored: the negotiator and the
      // framework both serialize lazily.
      const buffered = new Response(await response.arrayBuffer(), response);
      return { response: buffered, logged: lines.join('\n') };
    } finally {
      console.error = error;
      console.warn = warn;
      console.log = log;
    }
  }

  it('answers with a sanitized ApiErrorResponse', async () => {
    const { response, logged } = await fetchSpec(failingSpecApp({ guarded: true }));
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.headers.get('content-type')).not.toContain('problem');
    expect(Value.Check(ApiErrorResponseSchema, body)).toBe(true);
    expect(body).toEqual({ error: 'An internal error occurred', code: ERROR_CODES.INTERNAL });
    // Elysia's built-in renderer spells a failure `{…, detail, name}`. Both the
    // thrown text and the `name` member are what this route used to publish.
    expect(JSON.stringify(body)).not.toContain('hunter2');
    expect(Object.keys(body as object)).not.toContain('name');
    // Withholding the cause from the client is only acceptable because the
    // server still records it. A silent 500 would be the worse bug.
    expect(logged).toContain(THROWN_MESSAGE);
  });

  it('sanitizes the trailing-slash alias too', async () => {
    // Elysia serves `GET /scalar/json/` as the same document. `path` keeps the
    // trailing slash, so an exact match would skip the guard and leak here.
    const { response, logged } = await fetchSpec(failingSpecApp({ guarded: true }), {
      path: `${OPENAPI_SPEC_PATH}/`,
    });
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(Value.Check(ApiErrorResponseSchema, body)).toBe(true);
    expect(JSON.stringify(body)).not.toContain('hunter2');
    expect(logged).toContain(THROWN_MESSAGE);
  });

  it('negotiates that failure like any other', async () => {
    // The spec route sits outside `errorHandler`'s reach, so its negotiation is
    // wired separately. Answering one representation here while every other
    // failure answers two would be an inconsistency owed to hook order alone.
    const { response } = await fetchSpec(failingSpecApp({ guarded: true }), {
      accept: PROBLEM_JSON_ACCEPT,
    });
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(response.headers.get('content-type')).toContain(PROBLEM_JSON_MEDIA_TYPE);
    expect(response.headers.get('vary')).toContain('Accept');
    expect(Value.Check(ProblemDetailsSchema, body)).toBe(true);
    expect(body).toMatchObject({
      type: problemTypeUri(ERROR_CODES.INTERNAL),
      status: 500,
      code: ERROR_CODES.INTERNAL,
    });
    expect(JSON.stringify(body)).not.toContain('hunter2');
  });

  it('carries Vary: Accept on the default representation too', async () => {
    // A cache that stored the legacy body without it would go on serving it to
    // a client that asked for problem details.
    const { response } = await fetchSpec(failingSpecApp({ guarded: true }));

    expect(response.headers.get('vary')).toContain('Accept');
  });

  it('leaves a non-GET to the spec path as a 404', async () => {
    // The guard keys off the path. A POST is a miss, and rewriting it to
    // INTERNAL would be this arm classifying a 404 it does not own.
    const { response, logged } = await fetchSpec(failingSpecApp({ guarded: true }), {
      method: 'POST',
    });
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(Value.Check(ApiErrorResponseSchema, body)).toBe(true);
    expect(body).toMatchObject({ code: ERROR_CODES.NOT_FOUND });
    expect(logged).not.toContain('[openapi-spec]');
  });

  it('leaks the thrown message with the guard removed', async () => {
    // Pins the precondition the guard exists for. Dropping `openapiProblemDetails`
    // is the only difference from the cases above, so this failing is either the
    // plugin having stopped swallowing spec-route errors or Elysia having stopped
    // rendering the message — both worth looking at rather than deleting the guard.
    const { response } = await fetchSpec(failingSpecApp({ guarded: false }));

    expect(response.status).toBe(500);
    expect(await response.text()).toContain('hunter2');
  });
});
