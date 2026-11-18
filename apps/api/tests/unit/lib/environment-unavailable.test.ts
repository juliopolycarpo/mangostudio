import { describe, expect, it } from 'bun:test';

import { Elysia } from 'elysia';

import {
  environmentUnavailableBody,
  EnvironmentUnavailableError,
  environmentUnavailableResponse,
} from '../../../src/lib/environment-unavailable';

describe('environmentUnavailableBody', () => {
  it('returns the fixed body with the reason and the wait for a connect failure', () => {
    const error = new EnvironmentUnavailableError('backing-off', 'raw diagnostic with /home/me', {
      retryAfterSeconds: 4,
    });

    expect(environmentUnavailableBody(error)).toEqual({
      error: 'The environment is unavailable; a new connection attempt is allowed shortly.',
      code: 'ENVIRONMENT_UNAVAILABLE',
      details: { reason: 'backing-off', retryAfterSeconds: '4' },
    });
  });

  it('returns null for any other error', () => {
    expect(environmentUnavailableBody(new Error('boom'))).toBeNull();
  });
});

describe('environmentUnavailableResponse', () => {
  it('answers a typed 503 and sets Retry-After on the headers it was given', () => {
    const headers: Record<string, string | number | string[]> = {};
    const error = new EnvironmentUnavailableError('backing-off', 'diagnostic', {
      retryAfterSeconds: 4,
    });

    const answer = environmentUnavailableResponse(error, { headers });

    expect(answer?.status).toBe(503);
    expect(answer?.response.code).toBe('ENVIRONMENT_UNAVAILABLE');
    expect(headers['Retry-After']).toBe('4');
  });

  it('returns null and leaves the headers alone for any other error', () => {
    const headers: Record<string, string | number | string[]> = {};

    expect(environmentUnavailableResponse(new Error('boom'), { headers })).toBeNull();
    expect(headers).toEqual({});
  });

  it('puts the status and the Retry-After header on the wire', async () => {
    const app = new Elysia().get('/down', ({ set }) => {
      const answer = environmentUnavailableResponse(
        new EnvironmentUnavailableError('backing-off', 'diagnostic', { retryAfterSeconds: 7 }),
        set
      );
      return answer ?? 'unexpected: not an unavailable error';
    });

    const response = await app.handle(new Request('http://localhost/down'));

    expect(`status ${response.status}`).toBe('status 503');
    expect(response.headers.get('Retry-After')).toBe('7');
    expect(((await response.json()) as { code: string }).code).toBe('ENVIRONMENT_UNAVAILABLE');
  });
});
