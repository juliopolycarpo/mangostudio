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
import {
  ERROR_CODES,
  PROBLEM_JSON_ACCEPT,
  PROBLEM_JSON_MEDIA_TYPE,
  ProblemDetailsSchema,
  problemTypeUri,
} from '@mangostudio/shared/errors';
import Value from 'typebox/value';
import { app } from '../../../src/app';

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
        headers: { accept: PROBLEM_JSON_ACCEPT, origin: 'http://localhost:3001' },
      })
    );

    const vary = response.headers.get('vary') ?? '';
    const fields = vary.split(',').map((field) => field.trim());
    expect(fields).toContain('Origin');
    expect(fields).toContain('Accept');
    expect(new Set(fields).size).toBe(fields.length);
  });

  it('answers a non-GET to the spec path as a 404', async () => {
    const response = await app.handle(
      new Request('http://localhost/scalar/json', { method: 'POST' })
    );
    const body = (await response.json()) as { code?: string };

    expect(response.status).toBe(404);
    expect(body.code).toBe(ERROR_CODES.NOT_FOUND);
  });
});

describe('the published OpenAPI document', () => {
  it('publishes the ProblemDetails schema', async () => {
    const document = await openApiDocument();

    expect(document.components?.schemas?.ProblemDetails).toBeDefined();
  });

  it('amends the trailing-slash alias the same way', async () => {
    // Elysia serves `GET /scalar/json/` as the same document. The amendment
    // hook has to recognise that spelling or the alias ships the unamended spec.
    const response = await app.handle(new Request('http://localhost/scalar/json/'));
    expect(response.status).toBe(200);
    const document = (await response.json()) as OpenApiDocument;
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
