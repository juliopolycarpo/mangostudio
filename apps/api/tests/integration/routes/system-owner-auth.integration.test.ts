import { afterEach, describe, expect, test } from 'bun:test';

import { Elysia } from 'elysia';

import { getDb } from '../../../src/db/database';
import { SYSTEM_OWNER_EMAIL, SYSTEM_OWNER_USER_ID } from '../../../src/db/system-owner';
import { errorHandler } from '../../../src/plugins/error-handler';
import { authRoutes } from '../../../src/routes/auth';
import { createApiTestApp } from '../../support/harness/create-api-test-app';

// Under `/api` because Better Auth matches its configured `/api/auth` base path,
// and with the error handler so the request body reaches it intact.
const app = createApiTestApp(new Elysia({ prefix: '/api' }).use(errorHandler).use(authRoutes));
const CONTROL_EMAIL = 'system-owner-control@mangostudio.test';
const PASSWORD = 'a-long-enough-password';

function post(path: string, body: Record<string, string>) {
  return app.handle(
    new Request(`http://localhost/api/auth/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  );
}

afterEach(async () => {
  await getDb().deleteFrom('user').where('email', '=', CONTROL_EMAIL).execute();
});

describe('reserved system owner', () => {
  test('cannot sign in, while an ordinary account with the same call can', async () => {
    const signUp = await post('sign-up/email', {
      email: CONTROL_EMAIL,
      password: PASSWORD,
      name: 'Control',
    });
    // Control: the sign-in call itself is well formed, so the refusal below is
    // about the owner and not about the request or the test setup.
    expect(signUp.status).toBe(200);
    const control = await post('sign-in/email', { email: CONTROL_EMAIL, password: PASSWORD });
    expect(control.status).toBe(200);

    const owner = await post('sign-in/email', { email: SYSTEM_OWNER_EMAIL, password: PASSWORD });

    expect(owner.status).toBeGreaterThanOrEqual(400);
    expect(owner.status).toBeLessThan(500);
  });

  test('cannot be registered over: its email is taken', async () => {
    const response = await post('sign-up/email', {
      email: SYSTEM_OWNER_EMAIL,
      password: PASSWORD,
      name: 'Impostor',
    });

    expect(response.status).toBeGreaterThanOrEqual(400);
    const accounts = await getDb()
      .selectFrom('account')
      .select('id')
      .where('userId', '=', SYSTEM_OWNER_USER_ID)
      .execute();
    expect(accounts).toEqual([]);
  });
});
