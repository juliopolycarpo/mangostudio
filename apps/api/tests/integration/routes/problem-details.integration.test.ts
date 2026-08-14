/**
 * Problem details as the assembled application actually serves them.
 *
 * The unit suites prove the boundary and the spec amendment in isolation. What
 * they cannot prove is that both are still wired into `app.ts` in the one order
 * that works: the negotiator has to sit ahead of the API's routes, and the spec
 * amendment ahead of the OpenAPI plugin. Either hook mounted a line too late
 * goes quiet without failing anything else, so both are exercised here through
 * the real app.
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
import { app } from '../../../src/app';
import { errorHandler } from '../../../src/plugins/error-handler';
import { OPENAPI_PATH, openapiProblemDetails } from '../../../src/server/openapi-problem-details';

interface OpenApiDocument {
  info?: { description?: string };
  components?: { schemas?: Record<string, unknown> };
  paths?: Record<
    string,
    Record<string, { responses?: Record<string, { content?: Record<string, unknown> }> }>
  >;
}

let cachedDocument: OpenApiDocument | null = null;

async function openApiDocument(): Promise<OpenApiDocument> {
  if (cachedDocument) return cachedDocument;
  const response = await app.handle(new Request('http://localhost/scalar/json'));
  expect(response.status).toBe(200);
  cachedDocument = (await response.json()) as OpenApiDocument;
  return cachedDocument;
}

/** An unauthenticated request to a guarded route: a real 401 through the real stack. */
function unauthenticated(accept?: string) {
  return app.handle(
    new Request('http://localhost/api/chats', accept ? { headers: { accept } } : undefined)
  );
}

describe('negotiation through the assembled app', () => {
  it('answers a guarded route with the legacy shape by default', async () => {
    const response = await unauthenticated();

    expect(response.status).toBe(401);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.headers.get('content-type')).not.toContain('problem');
    expect(await response.json()).toMatchObject({ code: ERROR_CODES.UNAUTHORIZED });
  });

  it('answers the same route with problem details when asked', async () => {
    const response = await unauthenticated(PROBLEM_JSON_ACCEPT);
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(response.headers.get('content-type')).toContain(PROBLEM_JSON_MEDIA_TYPE);
    expect(response.headers.get('vary')).toContain('Accept');
    expect(Value.Check(ProblemDetailsSchema, body)).toBe(true);
    expect(body).toMatchObject({
      type: problemTypeUri(ERROR_CODES.UNAUTHORIZED),
      status: 401,
      code: ERROR_CODES.UNAUTHORIZED,
    });
  });

  it('keeps the status identical across representations', async () => {
    // The 401 is what the frontend's login redirect keys off. It has to survive
    // the representation change, because the redirect never reads the body.
    const [legacy, problem] = await Promise.all([
      unauthenticated(),
      unauthenticated(PROBLEM_JSON_ACCEPT),
    ]);

    const [problemBody, legacyBody] = (await Promise.all([problem.json(), legacy.json()])) as {
      code?: string;
    }[];

    expect(problem.status).toBe(legacy.status);
    expect(problemBody?.code).toBe(legacyBody?.code as string);
  });

  it('answers an unknown API route with problem details', async () => {
    const response = await app.handle(
      new Request('http://localhost/api/does-not-exist', {
        headers: { accept: PROBLEM_JSON_ACCEPT },
      })
    );

    expect(response.status).toBe(404);
    expect(Value.Check(ProblemDetailsSchema, await response.json())).toBe(true);
  });

  it('negotiates a non-API miss, which already answers with an ApiErrorResponse', async () => {
    // The error plugin's `NotFound` arm is global, so it answers paths the
    // frontend does not claim too — those 404s have always carried
    // `ApiErrorResponse`, and re-spelling them is the same promise as anywhere
    // else. Recorded because it is wider than "the negotiator covers /api".
    const response = await app.handle(
      new Request('http://localhost/not-an-api-path', {
        headers: { accept: PROBLEM_JSON_ACCEPT },
      })
    );

    expect(response.status).toBe(404);
    expect(Value.Check(ProblemDetailsSchema, await response.json())).toBe(true);
  });

  it('leaves a 404 that is not an ApiErrorResponse untouched', async () => {
    // The generated-image route answers its own misses. Nothing about asking
    // for problem details may turn a body the negotiator cannot re-render into
    // one it pretends it can.
    const response = await app.handle(
      new Request('http://localhost/images/does-not-exist.png', {
        headers: { accept: PROBLEM_JSON_ACCEPT },
      })
    );

    expect(response.status).toBe(404);
    expect(response.headers.get('content-type') ?? '').not.toContain(PROBLEM_JSON_MEDIA_TYPE);
  });

  it('leaves successful responses untouched', async () => {
    const response = await app.handle(
      new Request('http://localhost/api/health', { headers: { accept: PROBLEM_JSON_ACCEPT } })
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.headers.get('content-type')).not.toContain('problem');
    // CORS contributes `Vary: Origin`; the negotiator must not add `Accept` to
    // a response whose representation it never chose.
    expect(response.headers.get('vary') ?? '').not.toContain('Accept');
    expect(await response.json()).toMatchObject({ status: 'ok' });
  });

  it('appends to Vary rather than replacing what CORS set', async () => {
    // A duplicated `Origin` here would mean the two writers are using
    // differently-cased keys on the same header record.
    const response = await app.handle(
      new Request('http://localhost/api/chats', {
        headers: { accept: PROBLEM_JSON_ACCEPT, origin: 'http://localhost:5173' },
      })
    );

    const vary = response.headers.get('vary') ?? '';
    const fields = vary.split(',').map((field) => field.trim());
    expect(fields).toContain('Origin');
    expect(fields).toContain('Accept');
    expect(new Set(fields).size).toBe(fields.length);
  });
});

describe('the published OpenAPI document', () => {
  it('publishes the ProblemDetails schema', async () => {
    const document = await openApiDocument();

    expect(document.components?.schemas?.ProblemDetails).toBeDefined();
  });

  it('documents the negotiation', async () => {
    const document = await openApiDocument();

    expect(document.info?.description).toContain(PROBLEM_JSON_MEDIA_TYPE);
  });

  it('offers both media types on documented error responses', async () => {
    const document = await openApiDocument();

    let negotiated = 0;
    let plain = 0;
    for (const methods of Object.values(document.paths ?? {})) {
      for (const operation of Object.values(methods)) {
        for (const [status, response] of Object.entries(operation.responses ?? {})) {
          if (Number.parseInt(status, 10) < 400) continue;
          if (!response.content?.['application/json']) continue;
          if (response.content[PROBLEM_JSON_MEDIA_TYPE]) negotiated += 1;
          else plain += 1;
        }
      }
    }

    // The overwhelming majority of error responses negotiate; the handful that
    // do not are the ones whose body carries domain data alongside the error.
    expect(negotiated).toBeGreaterThan(0);
    expect(negotiated).toBeGreaterThan(plain * 10);
  });

  it('references the published schema rather than inlining a copy', async () => {
    const document = await openApiDocument();

    const refs = new Set<string>();
    for (const methods of Object.values(document.paths ?? {})) {
      for (const operation of Object.values(methods)) {
        for (const response of Object.values(operation.responses ?? {})) {
          const media = response.content?.[PROBLEM_JSON_MEDIA_TYPE] as
            | { schema?: { $ref?: string } }
            | undefined;
          if (media?.schema?.$ref) refs.add(media.schema.$ref);
        }
      }
    }

    expect([...refs]).toEqual(['#/components/schemas/ProblemDetails']);
  });
});

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
 * These build their own root rather than using the real `app`, because forcing
 * the generator to throw means configuring `openapi()`. The mirror keeps the one
 * property under test — `openapiProblemDetails` before `openapi()`, the error
 * handler after both — and the assertion that the real `app` still composes them
 * that way is the successful document above.
 */
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
    accept?: string
  ): Promise<{ response: Response; logged: string }> {
    const { error, warn, log } = console;
    const lines: string[] = [];
    const capture = (...args: unknown[]) => lines.push(args.map(String).join(' '));
    console.error = capture;
    console.warn = capture;
    console.log = capture;

    try {
      const response = await root.handle(
        new Request(`http://localhost${OPENAPI_PATH}/json`, accept ? { headers: { accept } } : {})
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

  it('negotiates that failure like any other', async () => {
    // The spec route sits outside `errorHandler`'s reach, so its negotiation is
    // wired separately. Answering one representation here while every other
    // failure answers two would be an inconsistency owed to hook order alone.
    const { response } = await fetchSpec(failingSpecApp({ guarded: true }), PROBLEM_JSON_ACCEPT);
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
