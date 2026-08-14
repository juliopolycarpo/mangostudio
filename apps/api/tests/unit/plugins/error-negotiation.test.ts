/**
 * What the negotiated representation may and may not change.
 *
 * The rule this suite exists to enforce is that `Accept` chooses spelling and
 * nothing else. A client that opts into problem details must get the same
 * status, the same `code`, the same headers, and the same redaction as one that
 * did not — and a client that did not opt in must be unable to tell the feature
 * shipped at all.
 *
 * Everything is asserted against real requests through the real plugin rather
 * than against the mapper in isolation, because the parts that have actually
 * been wrong in this area are the seams: which lifecycle stage sees the status,
 * whether headers survive being replaced, whether a hook reaches a sibling
 * instance.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { inspect } from 'node:util';
import {
  ApiErrorResponseSchema,
  ERROR_CODES,
  PROBLEM_JSON_ACCEPT,
  PROBLEM_JSON_MEDIA_TYPE,
  ProblemDetailsSchema,
  problemTypeUri,
} from '@mangostudio/shared/errors';
import { Elysia, t } from 'elysia';
import Value from 'typebox/value';
import { errorHandler } from '../../../src/plugins/error-handler';

const SECRET = 'sk-live-do-not-log-me';
const INTERNAL_DETAIL = '/var/secrets/private-key.pem could not be opened';

/** Ask for problem details. */
const PROBLEM: RequestInit = { headers: { accept: PROBLEM_JSON_ACCEPT } };

/** Ask the way every client that predates this feature does. */
const LEGACY: RequestInit = { headers: { accept: '*/*' } };

function captureConsole() {
  const originalError = console.error;
  const lines: string[] = [];
  console.error = (...args: unknown[]) => {
    lines.push(
      args
        .map((arg) => (typeof arg === 'string' ? arg : inspect(arg, { depth: 8, getters: true })))
        .join(' ')
    );
  };
  return { lines, restore: () => (console.error = originalError) };
}

let capture: ReturnType<typeof captureConsole> | null = null;

afterEach(() => {
  capture?.restore();
  capture = null;
});

/**
 * One app covering every failure class the boundary has to classify: framework
 * rejections, thrown errors, `status()` returns, `set.status` returns, a body
 * carrying domain data, and a success.
 */
function app() {
  return new Elysia()
    .use(errorHandler)
    .post('/rename', { body: t.Object({ name: t.String() }) }, () => ({ ok: true }))
    .post('/connectors', { body: t.Object({ apiKey: t.String(), enabled: t.Boolean() }) }, () => ({
      ok: true,
    }))
    .get('/boom', () => {
      throw new Error(INTERNAL_DETAIL);
    })
    .get(
      '/profile',
      { response: t.Object({ name: t.String() }) },
      () => ({ token: SECRET }) as never
    )
    .get('/conflict', ({ status }) =>
      status(409, { error: 'Already exists', code: ERROR_CODES.CONFLICT })
    )
    .get('/forbidden', ({ set }) => {
      set.status = 'Forbidden';
      return { error: 'Not the owner', code: ERROR_CODES.OWNERSHIP };
    })
    .get('/limited', ({ set }) => {
      set.status = 429;
      set.headers['Retry-After'] = '30';
      (set.headers as Record<string, unknown>)['X-RateLimit-Limit'] = 100;
      return { error: 'Too many requests', code: ERROR_CODES.RATE_LIMITED };
    })
    .get('/expired', ({ set, cookie }) => {
      cookie.session?.set({ value: '', httpOnly: true, maxAge: 0 });
      set.status = 401;
      return { error: 'Unauthorized', code: ERROR_CODES.UNAUTHORIZED };
    })
    .get('/blocked', ({ set }) => {
      set.status = 403;
      return {
        error: 'Install blocked',
        code: ERROR_CODES.PERMISSION_DENIED,
        recipe: { id: 'node-22' },
      };
    })
    .get('/varied-array', ({ set }) => {
      set.status = 404;
      (set.headers as Record<string, unknown>).vary = ['Origin', 'Accept-Encoding'];
      return { error: 'Missing', code: ERROR_CODES.NOT_FOUND };
    })
    .get('/varied-star', ({ set }) => {
      set.status = 404;
      set.headers.vary = '*';
      return { error: 'Missing', code: ERROR_CODES.NOT_FOUND };
    })
    .get('/ok', () => ({ ok: true }));
}

function get(path: string, init?: RequestInit) {
  return app().handle(new Request(`http://localhost${path}`, init));
}

function post(path: string, body: unknown, init?: RequestInit) {
  return app().handle(
    new Request(`http://localhost${path}`, {
      ...init,
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(init?.headers as object) },
      body: JSON.stringify(body),
    })
  );
}

/** Read a problem document, asserting the wire contract on the way through. */
async function problemBody(response: Response) {
  expect(response.headers.get('content-type')).toContain(PROBLEM_JSON_MEDIA_TYPE);
  const payload = await response.json();
  expect(Value.Check(ProblemDetailsSchema, payload)).toBe(true);
  // RFC 9457 is explicit that the member and the HTTP status agree.
  expect((payload as { status: number }).status).toBe(response.status);
  return payload as Record<string, unknown>;
}

/** Read a legacy body, asserting the wire contract on the way through. */
async function legacyBody(response: Response) {
  expect(response.headers.get('content-type')).toContain('application/json');
  expect(response.headers.get('content-type')).not.toContain('problem');
  const payload = await response.json();
  expect(Value.Check(ApiErrorResponseSchema, payload)).toBe(true);
  return payload as Record<string, unknown>;
}

describe('the legacy representation is untouched', () => {
  it('answers a wildcard client with the shape it has always had', async () => {
    const response = await get('/nope', LEGACY);

    expect(response.status).toBe(404);
    expect(await legacyBody(response)).toEqual({ error: 'Not found', code: ERROR_CODES.NOT_FOUND });
  });

  it('answers a request with no Accept at all with the legacy shape', async () => {
    const response = await get('/nope');

    expect(response.status).toBe(404);
    expect(await legacyBody(response)).toEqual({ error: 'Not found', code: ERROR_CODES.NOT_FOUND });
  });

  it('answers an explicit refusal with the legacy shape', async () => {
    const response = await get('/nope', {
      headers: { accept: `${PROBLEM_JSON_MEDIA_TYPE};q=0` },
    });

    expect(response.status).toBe(404);
    expect(await legacyBody(response)).toEqual({ error: 'Not found', code: ERROR_CODES.NOT_FOUND });
  });
});

describe('both representations agree on everything but spelling', () => {
  const cases: { name: string; path: string; status: number; code: string; message: string }[] = [
    {
      name: 'not found',
      path: '/nope',
      status: 404,
      code: ERROR_CODES.NOT_FOUND,
      message: 'Not found',
    },
    {
      name: 'conflict returned through status()',
      path: '/conflict',
      status: 409,
      code: ERROR_CODES.CONFLICT,
      message: 'Already exists',
    },
    {
      name: 'ownership returned through a status name',
      path: '/forbidden',
      status: 403,
      code: ERROR_CODES.OWNERSHIP,
      message: 'Not the owner',
    },
    {
      name: 'rate limit',
      path: '/limited',
      status: 429,
      code: ERROR_CODES.RATE_LIMITED,
      message: 'Too many requests',
    },
    {
      name: 'internal failure',
      path: '/boom',
      status: 500,
      code: ERROR_CODES.INTERNAL,
      message: 'An internal error occurred',
    },
    {
      name: 'invalid response',
      path: '/profile',
      status: 500,
      code: ERROR_CODES.INTERNAL,
      message: 'An internal error occurred',
    },
  ];

  for (const { name, path, status, code, message } of cases) {
    it(`reports ${name} identically either way`, async () => {
      capture = captureConsole();

      const legacy = await get(path, LEGACY);
      const problem = await get(path, PROBLEM);

      expect(legacy.status).toBe(status);
      expect(problem.status).toBe(status);

      expect(await legacyBody(legacy)).toEqual({ error: message, code });
      expect(await problemBody(problem)).toEqual({
        type: problemTypeUri(code as never),
        title: expect.any(String),
        status,
        detail: message,
        code,
      });
    });
  }

  it('reports a rejected request body identically either way', async () => {
    capture = captureConsole();

    const legacy = await post('/rename', { name: 42 }, LEGACY);
    const problem = await post('/rename', { name: 42 }, PROBLEM);

    expect(legacy.status).toBe(422);
    expect(problem.status).toBe(422);
    expect(await legacyBody(legacy)).toEqual({
      error: 'Invalid request body',
      code: ERROR_CODES.VALIDATION,
    });
    expect(await problemBody(problem)).toMatchObject({
      type: problemTypeUri(ERROR_CODES.VALIDATION),
      status: 422,
      detail: 'Invalid request body',
      code: ERROR_CODES.VALIDATION,
    });
  });
});

describe('Vary', () => {
  it('marks every negotiable error, whichever representation won', async () => {
    // Without this a shared cache would hand the body it stored to a client
    // that asked for the other one.
    for (const init of [LEGACY, PROBLEM]) {
      const response = await get('/nope', init);
      expect(response.headers.get('vary')).toContain('Accept');
    }
  });

  it('leaves successful responses alone', async () => {
    const response = await get('/ok', PROBLEM);

    expect(response.status).toBe(200);
    expect(response.headers.get('vary')).toBeNull();
    expect(await response.json()).toEqual({ ok: true });
  });

  it('keeps array-valued directives instead of replacing them', async () => {
    // `HTTPHeaders` is `Record<string, string | number | string[]>`. Overwriting
    // an array would drop `Origin`, and a CORS-varying response cached without
    // it is one a shared cache may hand to the wrong origin.
    for (const init of [LEGACY, PROBLEM]) {
      const fields = ((await get('/varied-array', init)).headers.get('vary') ?? '')
        .split(',')
        .map((field) => field.trim());

      expect(fields).toContain('Origin');
      expect(fields).toContain('Accept-Encoding');
      expect(fields).toContain('Accept');
    }
  });

  it('leaves Vary: * alone', async () => {
    // `*` already says the response varies on everything; `*, Accept` narrows
    // nothing and is a worse header.
    const response = await get('/varied-star', PROBLEM);

    expect(response.headers.get('vary')).toBe('*');
  });
});

describe('headers survive the replacement', () => {
  it('keeps Retry-After on a negotiated 429', async () => {
    // The replacement is a whole new `Response`. A 429 that lost its
    // `Retry-After` because the caller asked for problem details would be a
    // worse bug than not negotiating at all.
    const response = await get('/limited', PROBLEM);

    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('30');
    expect(await problemBody(response)).toMatchObject({ code: ERROR_CODES.RATE_LIMITED });
  });

  it('keeps numeric header values', async () => {
    // Elysia's header record holds numbers as well as strings, and a copy that
    // only understood strings would drop the rate-limit budget on exactly the
    // responses that report it.
    const response = await get('/limited', PROBLEM);

    expect(response.headers.get('x-ratelimit-limit')).toBe('100');
  });

  it('keeps a cookie the request set', async () => {
    const legacy = await get('/expired', LEGACY);
    const problem = await get('/expired', PROBLEM);

    expect(problem.headers.getSetCookie()).toEqual(legacy.headers.getSetCookie());
    expect(problem.headers.getSetCookie()[0]).toContain('session=');
  });
});

describe('bodies that cannot be re-rendered losslessly', () => {
  it('leaves an error carrying domain data in its documented shape', async () => {
    // `InstallBlockedResponse` is an `ApiErrorResponse` plus a `recipe` the
    // frontend keys off. Problem details has nowhere to put `recipe`, so
    // rewriting this body would silently delete it.
    const response = await get('/blocked', PROBLEM);

    expect(response.status).toBe(403);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.headers.get('content-type')).not.toContain('problem');
    expect(await response.json()).toEqual({
      error: 'Install blocked',
      code: ERROR_CODES.PERMISSION_DENIED,
      recipe: { id: 'node-22' },
    });
  });
});

describe('the negotiated representation leaks nothing extra', () => {
  it('keeps a rejected credential out of a problem document', async () => {
    capture = captureConsole();

    const response = await post('/connectors', { apiKey: SECRET, enabled: 'yes' }, PROBLEM);
    const raw = await response.text();

    expect(response.status).toBe(422);
    expect(raw).not.toContain(SECRET);
    expect(raw).not.toContain('apiKey');
    expect(capture.lines.join('\n')).not.toContain(SECRET);
  });

  it('keeps an internal exception message out of a problem document', async () => {
    capture = captureConsole();

    const raw = await (await get('/boom', PROBLEM)).text();

    expect(raw).not.toContain(INTERNAL_DETAIL);
    expect(raw).not.toContain('/var/secrets');
    // Still logged server-side: negotiation changed the wire, not the record.
    expect(capture.lines.join('\n')).toContain(INTERNAL_DETAIL);
  });

  it('keeps a rejected response value out of a problem document', async () => {
    capture = captureConsole();

    const raw = await (await get('/profile', PROBLEM)).text();

    expect(raw).not.toContain(SECRET);
    expect(capture.lines.join('\n')).not.toContain(SECRET);
  });

  it('never puts a source path or an internal URL in the type member', async () => {
    capture = captureConsole();

    for (const path of ['/nope', '/boom', '/conflict', '/limited']) {
      const body = await problemBody(await get(path, PROBLEM));
      expect(body.type).toMatch(/^https:\/\/mangostudio\.dev\/problems\//);
    }
  });
});

describe('scope', () => {
  it('negotiates for routes registered on a sibling instance', async () => {
    const routes = new Elysia().get('/inner', ({ status }) =>
      status(404, { error: 'Not found', code: ERROR_CODES.NOT_FOUND })
    );
    const composed = new Elysia()
      .use(errorHandler)
      .use(routes)
      .get('/outer', ({ status }) =>
        status(404, { error: 'Not found', code: ERROR_CODES.NOT_FOUND })
      );

    for (const path of ['/inner', '/outer']) {
      const response = await composed.handle(new Request(`http://localhost${path}`, PROBLEM));
      expect(response.status).toBe(404);
      expect(await problemBody(response)).toMatchObject({ code: ERROR_CODES.NOT_FOUND });
    }
  });
});
