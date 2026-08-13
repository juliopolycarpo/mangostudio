/**
 * How the shared handler classifies failures.
 *
 * The status is the whole point: a caller decides whether to fix its request or
 * report an outage based on nothing else, so a bad upload answered as a 500
 * sends the user looking in the wrong place.
 *
 * The body is the other half. Every arm returns an `ApiErrorResponse`, and the
 * handler is the one place standing between a framework's own error object and
 * the client — a rejected payload carries whatever the caller sent, including
 * credentials, and a raw exception carries file paths and query text. Both the
 * status mapping and the sanitization are asserted against real requests here
 * rather than against the framework's error codes, which are not our contract.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { inspect } from 'node:util';
import { ApiErrorResponseSchema, ERROR_CODES } from '@mangostudio/shared/errors';
import { Value } from '@sinclair/typebox/value';
import { Elysia, t } from 'elysia';
import { errorHandler } from '../../../src/plugins/error-handler';

const SECRET = 'sk-live-do-not-log-me';
const INTERNAL_DETAIL = '/var/secrets/private-key.pem could not be opened';

function uploadApp() {
  return new Elysia().use(errorHandler).post('/avatar', () => ({ ok: true }), {
    body: t.Object({ image: t.File({ type: 'image/*' }) }),
  });
}

function uploadRequest(bytes: Uint8Array): Request {
  const form = new FormData();
  form.append('image', new File([bytes], 'avatar.png', { type: 'image/png' }));
  return new Request('http://localhost/avatar', { method: 'POST', body: form });
}

/** Read the body as an `ApiErrorResponse`, asserting the wire contract first. */
async function errorBody(response: Response): Promise<{ error: string; code?: string }> {
  expect(response.headers.get('content-type')).toContain('application/json');
  const payload = (await response.json()) as { error: string; code?: string };
  expect(Value.Check(ApiErrorResponseSchema, payload)).toBe(true);
  return payload;
}

interface ConsoleCapture {
  lines: string[];
  restore(): void;
}

/** Capture everything the handler writes while a request is in flight. */
function captureConsole(): ConsoleCapture {
  const originalError = console.error;
  const originalWarn = console.warn;
  const lines: string[] = [];
  const record = (...args: unknown[]) => {
    // `String(error)` is `Error: message`; `String({ apiKey })` is
    // `[object Object]`. Either would hide a credential sitting on a nested
    // field of a structured argument, so walk the value the way the real
    // console formatter would print it.
    lines.push(
      args
        .map((arg) =>
          typeof arg === 'string'
            ? arg
            : inspect(arg, { depth: 8, getters: true, showHidden: true })
        )
        .join(' ')
    );
  };

  console.error = record;
  console.warn = record;

  return {
    lines,
    restore: () => {
      console.error = originalError;
      console.warn = originalWarn;
    },
  };
}

let capture: ConsoleCapture | null = null;

afterEach(() => {
  capture?.restore();
  capture = null;
});

describe('errorHandler status and body mapping', () => {
  it('answers a file of the wrong type with 422', async () => {
    const response = await uploadApp().handle(
      uploadRequest(new TextEncoder().encode('plain text pretending to be a PNG'))
    );

    // Elysia raises this outside its `VALIDATION` code, so it needs its own arm
    // — otherwise a user's mistyped file reads as a server fault.
    expect(response.status).toBe(422);
    expect(await errorBody(response)).toEqual({
      error: 'Unsupported file type',
      code: ERROR_CODES.VALIDATION,
    });
  });

  it('answers a rejected request body with 422', async () => {
    const app = new Elysia()
      .use(errorHandler)
      .post('/rename', () => ({ ok: true }), { body: t.Object({ name: t.String() }) });

    const response = await app.handle(
      new Request('http://localhost/rename', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 42 }),
      })
    );

    expect(response.status).toBe(422);
    expect(await errorBody(response)).toEqual({
      error: 'Invalid request body',
      code: ERROR_CODES.VALIDATION,
    });
  });

  it('answers a response that fails our own schema with 500', async () => {
    const app = new Elysia().use(errorHandler).get('/count', () => ({ count: 'many' }) as never, {
      response: t.Object({ count: t.Number() }),
    });

    // The caller's request was fine; the bug is ours, and saying 422 would send
    // them off to fix a request that was never at fault.
    const response = await app.handle(new Request('http://localhost/count'));

    expect(response.status).toBe(500);
    expect(await errorBody(response)).toEqual({
      error: 'An internal error occurred',
      code: ERROR_CODES.INTERNAL,
    });
  });

  it('answers an unknown route with 404', async () => {
    const app = new Elysia().use(errorHandler).get('/known', () => ({ ok: true }));

    const response = await app.handle(new Request('http://localhost/api/does-not-exist'));

    expect(response.status).toBe(404);
    expect(await errorBody(response)).toEqual({
      error: 'Not found',
      code: ERROR_CODES.NOT_FOUND,
    });
  });

  it('answers a generic thrown error with a sanitized 500', async () => {
    capture = captureConsole();
    const app = new Elysia().use(errorHandler).get('/boom', () => {
      throw new Error(INTERNAL_DETAIL);
    });

    const response = await app.handle(new Request('http://localhost/boom'));

    expect(response.status).toBe(500);
    expect(await errorBody(response)).toEqual({
      error: 'An internal error occurred',
      code: ERROR_CODES.INTERNAL,
    });
  });

  it('reaches the handler registered on a sibling instance', async () => {
    // `{ as: 'global' }` is what lets one registration cover the whole tree.
    // A scope change would leave outer routes answering with the framework's
    // own error shape instead of `ApiErrorResponse`.
    const routes = new Elysia().get('/inner', () => {
      throw new Error(INTERNAL_DETAIL);
    });
    const app = new Elysia()
      .use(errorHandler)
      .use(routes)
      .get('/outer', () => {
        throw new Error(INTERNAL_DETAIL);
      });
    capture = captureConsole();

    for (const path of ['/inner', '/outer']) {
      const response = await app.handle(new Request(`http://localhost${path}`));
      expect(response.status).toBe(500);
      expect(await errorBody(response)).toEqual({
        error: 'An internal error occurred',
        code: ERROR_CODES.INTERNAL,
      });
    }
  });
});

describe('errorHandler leaks nothing to the client', () => {
  it('keeps a rejected credential out of both the response and the logs', async () => {
    capture = captureConsole();
    const app = new Elysia().use(errorHandler).post('/connectors', () => ({ ok: true }), {
      body: t.Object({ apiKey: t.String(), enabled: t.Boolean() }),
    });

    const response = await app.handle(
      new Request('http://localhost/connectors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // `enabled` is wrong, so the whole payload — the key included — ends up
        // on the framework's error as `error.value`.
        body: JSON.stringify({ apiKey: SECRET, enabled: 'yes' }),
      })
    );
    const raw = await response.text();
    const logged = capture.lines.join('\n');

    expect(response.status).toBe(422);
    expect(raw).not.toContain(SECRET);
    expect(raw).not.toContain('apiKey');
    // The handler logs `error.type` and never the error object, precisely
    // because `error.value` carries write-only credentials.
    expect(logged).not.toContain(SECRET);
    expect(logged).toContain('[error-handler][VALIDATION]');
  });

  it('keeps an internal exception message out of the response', async () => {
    capture = captureConsole();
    const app = new Elysia().use(errorHandler).get('/read', () => {
      throw new Error(INTERNAL_DETAIL);
    });

    const raw = await (await app.handle(new Request('http://localhost/read'))).text();

    // Server-side the raw error is deliberately logged; the client gets none of
    // it. A framework that starts serializing its own error body would leak the
    // path here.
    expect(raw).not.toContain(INTERNAL_DETAIL);
    expect(raw).not.toContain('/var/secrets');
    expect(capture.lines.join('\n')).toContain(INTERNAL_DETAIL);
  });

  it('keeps a rejected response value out of the 500 it produces', async () => {
    capture = captureConsole();
    const app = new Elysia().use(errorHandler).get('/profile', () => ({ token: SECRET }) as never, {
      response: t.Object({ name: t.String() }),
    });

    const raw = await (await app.handle(new Request('http://localhost/profile'))).text();

    // The rejected value here is *our* response, which is exactly where a
    // server-side secret would be sitting when the schema catches a bug.
    expect(raw).not.toContain(SECRET);
    expect(capture.lines.join('\n')).not.toContain(SECRET);
  });
});
