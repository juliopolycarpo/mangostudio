import { describe, test, expect, beforeAll } from 'bun:test';
import { createApiTestApp } from '../../support/harness/create-api-test-app';
import { authRoutes } from '../../../src/routes/auth';

const app = createApiTestApp(authRoutes);

describe('Auth routes', () => {
  beforeAll(() => {
    process.env.BETTER_AUTH_SECRET = 'test-secret-at-least-32-characters-long';
    process.env.BETTER_AUTH_URL = 'http://localhost:3001';
  });

  test('GET /auth/ok — deve retornar ok', async () => {
    const res = await app.handle(
      new Request('http://localhost/auth/ok')
    );
    expect(res.status).toBe(200);
  });

  test('POST /auth/sign-up/email — deve falhar com dados inválidos', async () => {
    const res = await app.handle(
      new Request('http://localhost/auth/sign-up/email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'invalid', password: '123', name: 'Test' }),
      })
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
