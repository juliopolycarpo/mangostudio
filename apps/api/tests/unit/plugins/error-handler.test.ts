/**
 * How the shared handler classifies failures.
 *
 * The status is the whole point: a caller decides whether to fix its request or
 * report an outage based on nothing else, so a bad upload answered as a 500
 * sends the user looking in the wrong place.
 */

import { describe, expect, it } from 'bun:test';
import { Elysia, t } from 'elysia';
import { errorHandler } from '../../../src/plugins/error-handler';

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

describe('errorHandler', () => {
  it('answers a file of the wrong type with 422', async () => {
    const response = await uploadApp().handle(
      uploadRequest(new TextEncoder().encode('plain text pretending to be a PNG'))
    );

    // Elysia raises this outside its `VALIDATION` code, so it needs its own arm
    // — otherwise a user's mistyped file reads as a server fault.
    expect(response.status).toBe(422);
    expect((await response.json()) as { code: string }).toMatchObject({ code: 'VALIDATION' });
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
  });

  it('answers a response that fails our own schema with 500', async () => {
    const app = new Elysia().use(errorHandler).get('/count', () => ({ count: 'many' }) as never, {
      response: t.Object({ count: t.Number() }),
    });

    // The caller's request was fine; the bug is ours, and saying 422 would send
    // them off to fix a request that was never at fault.
    const response = await app.handle(new Request('http://localhost/count'));

    expect(response.status).toBe(500);
  });
});
