import { describe, test, expect } from 'bun:test';
import { createApiTestApp } from '../../support/harness/create-api-test-app';
import { authRoutes } from '../../../src/routes/auth';

const app = createApiTestApp(authRoutes);

describe('Auth routes', () => {
  test('GET /auth/ok — deve retornar ok', async () => {
    const res = await app.handle(new Request('http://localhost/auth/ok'));
    expect(res.status).toBe(200);
  });

  test('POST /auth/sign-up/email — deve falhar com dados inválidos', async () => {
    // Use a password exceeding maxPasswordLength (128) to guarantee rejection
    const res = await app.handle(
      new Request('http://localhost/auth/sign-up/email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'test@example.com',
          password: 'x'.repeat(200),
          name: 'Test',
        }),
      })
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
