import { describe, expect, it } from 'bun:test';

import { Elysia } from 'elysia';

import { apiErrorStatus } from '../../../src/lib/api-error-status';

describe('apiErrorStatus', () => {
  it('carries the code and body of the error answer', () => {
    const answer = apiErrorStatus(409, { error: 'Already exists', code: 'CONFLICT' });

    expect(answer.status).toBe(409);
    expect(answer.response).toEqual({ error: 'Already exists', code: 'CONFLICT' });
  });

  it('answers on the wire at the runtime status of a union code, even after set.status was 201', async () => {
    const failures: ReadonlyArray<404 | 422> = [404, 422];
    const app = new Elysia().get('/fail/:index', ({ params, set }) => {
      // A stale success status must not outlive the typed answer.
      set.status = 201;
      const code = failures[Number(params.index)] ?? 404;
      return apiErrorStatus(code, { error: `failed with ${code}`, code: 'VALIDATION' });
    });

    for (const [index, expected] of failures.entries()) {
      const response = await app.handle(new Request(`http://localhost/fail/${index}`));
      expect(`status ${response.status}`).toBe(`status ${expected}`);
      expect(await response.json()).toEqual({
        error: `failed with ${expected}`,
        code: 'VALIDATION',
      });
    }
  });
});
