import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { ApiErrorResponseSchema, ERROR_CODES } from '@mangostudio/shared/errors';
import { Elysia } from 'elysia';
import Value from 'typebox/value';
import { requireAuth } from '../../../src/plugins/auth-middleware';
import { authRoutes } from '../../../src/routes/auth';
import { createApiTestApp } from '../../support/harness/create-api-test-app';

const app = createApiTestApp(authRoutes);

describe('Auth routes', () => {
  let previousLogSetting: string | undefined;

  beforeEach(() => {
    previousLogSetting = process.env.MANGOSTUDIO_DIAGNOSTIC_LOGS;
  });

  afterEach(() => {
    mock.restore();
    if (previousLogSetting === undefined) {
      delete process.env.MANGOSTUDIO_DIAGNOSTIC_LOGS;
      return;
    }
    process.env.MANGOSTUDIO_DIAGNOSTIC_LOGS = previousLogSetting;
  });

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

  test('DELETE /auth/session returns canonical method-not-allowed error', async () => {
    const res = await app.handle(
      new Request('http://localhost/auth/session', { method: 'DELETE' })
    );

    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET, POST');

    const payload = await res.json();
    expect(Value.Check(ApiErrorResponseSchema, payload)).toBe(true);
    expect(payload).toEqual({
      error: 'Method not allowed',
      code: ERROR_CODES.METHOD_NOT_ALLOWED,
    });
  });

  test('protected routes return canonical unauthorized error', async () => {
    const privateRoutes = new Elysia().use(requireAuth).get('/private', () => ({ ok: true }));
    const privateApp = createApiTestApp(privateRoutes);

    const res = await privateApp.handle(new Request('http://localhost/private'));

    expect(res.status).toBe(401);

    const payload = await res.json();
    expect(Value.Check(ApiErrorResponseSchema, payload)).toBe(true);
    expect(payload).toEqual({ error: 'Unauthorized', code: ERROR_CODES.UNAUTHORIZED });
  });

  test('auth diagnostics stay silent when disabled', async () => {
    process.env.MANGOSTUDIO_DIAGNOSTIC_LOGS = '0';
    const lines: string[] = [];
    spyOn(console, 'warn').mockImplementation((line: string) => lines.push(line));

    await app.handle(new Request('http://localhost/auth/session', { method: 'DELETE' }));

    expect(lines).toHaveLength(0);
  });

  test('auth diagnostics emit structured JSON when enabled', async () => {
    process.env.MANGOSTUDIO_DIAGNOSTIC_LOGS = '1';
    const lines: string[] = [];
    spyOn(console, 'warn').mockImplementation((line: string) => lines.push(line));

    await app.handle(new Request('http://localhost/auth/session', { method: 'DELETE' }));

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({
      level: 'info',
      scope: 'auth-plugin',
      event: 'request',
      metadata: { method: 'DELETE', path: '/auth/session' },
    });
  });
});
