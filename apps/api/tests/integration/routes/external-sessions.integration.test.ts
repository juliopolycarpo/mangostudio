import { afterEach, describe, expect, it } from 'bun:test';

import { ApiErrorResponseSchema, ERROR_CODES } from '@mangostudio/shared/errors';
import type { ApiErrorResponse } from '@mangostudio/shared/errors';
import { ExternalNativeSessionListResponseSchema } from '@mangostudio/shared/external-agents';
import Value from 'typebox/value';

import type {
  ExternalNativeSessionListing,
  ExternalNativeSessionRefusalCode,
  ExternalNativeSessionService,
  ExternalSessionAdoption,
} from '../../../src/modules/external-agents/application/external-native-sessions';
import { createExternalSessionRoutes } from '../../../src/modules/external-agents/http/external-session-routes';
import {
  createApiTestApp,
  createAuthenticatedApiTestApp,
} from '../../support/harness/create-api-test-app';

const TEST_USER = {
  id: 'external-sessions-routes-user',
  name: 'External Sessions Routes User',
  email: 'external-sessions-routes@mangostudio.test',
};

let restoreAuth: (() => void) | null = null;

afterEach(() => {
  restoreAuth?.();
  restoreAuth = null;
});

/**
 * The application service with a scripted answer, so the routes' own mapping from
 * a refusal to a status, code and body is what these tests exercise.
 */
class FakeNativeSessionService implements ExternalNativeSessionService {
  listing: ExternalNativeSessionListing = { ok: true, sessions: [] };
  adoption: ExternalSessionAdoption = {
    ok: false,
    code: 'unavailable',
    message: 'No adoption scripted.',
  };

  list(): Promise<ExternalNativeSessionListing> {
    return Promise.resolve(this.listing);
  }

  adopt(): Promise<ExternalSessionAdoption> {
    return Promise.resolve(this.adoption);
  }
}

/** What each refusal must read as over HTTP: a status and the code a client branches on. */
const REFUSAL_WIRE: ReadonlyArray<{
  readonly refusal: ExternalNativeSessionRefusalCode;
  readonly status: 400 | 403 | 409 | 503;
  readonly code: string;
}> = [
  { refusal: 'unreachable', status: 503, code: ERROR_CODES.ENVIRONMENT_UNAVAILABLE },
  { refusal: 'resolve-failed', status: 503, code: ERROR_CODES.PROVIDER_ERROR },
  { refusal: 'isolation-unproven', status: 403, code: ERROR_CODES.PERMISSION_DENIED },
  { refusal: 'unsupported', status: 400, code: ERROR_CODES.VALIDATION },
  { refusal: 'unavailable', status: 400, code: ERROR_CODES.VALIDATION },
  { refusal: 'no-workspace', status: 400, code: ERROR_CODES.VALIDATION },
  { refusal: 'stale', status: 409, code: ERROR_CODES.CONFLICT },
  { refusal: 'held', status: 409, code: ERROR_CODES.EXTERNAL_SESSION_HELD },
];

const ADOPT_BODY = {
  environmentId: 'local',
  session: { targetId: 'codex', nativeSessionId: 'thread-1' },
};

function listRequest(query = 'targetId=codex'): Request {
  return new Request(`http://localhost/external-agents/sessions?${query}`);
}

function adoptRequest(): Request {
  return new Request('http://localhost/chats/adopt-external-session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(ADOPT_BODY),
  });
}

describe('external session routes', () => {
  it('lists sessions through the declared 200 schema', async () => {
    const service = new FakeNativeSessionService();
    service.listing = {
      ok: true,
      sessions: [{ targetId: 'codex', nativeSessionId: 'thread-1', title: 'Fix the build' }],
      nextCursor: 'cursor-2',
    };
    const { app, restore } = createAuthenticatedApiTestApp(
      TEST_USER,
      createExternalSessionRoutes(service)
    );
    restoreAuth = restore;

    const response = await app.handle(listRequest());
    const payload: unknown = await response.json();

    expect(response.status).toBe(200);
    expect(Value.Check(ExternalNativeSessionListResponseSchema, payload)).toBe(true);
  });

  it('answers 404 NOT_FOUND for a target that is not an external agent', async () => {
    const { app, restore } = createAuthenticatedApiTestApp(
      TEST_USER,
      createExternalSessionRoutes(new FakeNativeSessionService())
    );
    restoreAuth = restore;

    const response = await app.handle(listRequest('targetId=not-a-vendor'));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: 'Unknown external agent.',
      code: ERROR_CODES.NOT_FOUND,
    });
  });

  it('answers 401 UNAUTHORIZED to an unauthenticated list and adopt', async () => {
    const app = createApiTestApp(createExternalSessionRoutes(new FakeNativeSessionService()));

    const listed = await app.handle(listRequest());
    const adopted = await app.handle(adoptRequest());

    expect(listed.status).toBe(401);
    expect(adopted.status).toBe(401);
  });

  for (const { refusal, status, code } of REFUSAL_WIRE) {
    it(`maps a ${refusal} refusal to ${status} ${code} on list and adopt`, async () => {
      const service = new FakeNativeSessionService();
      const scripted = { ok: false, code: refusal, message: `Refused: ${refusal}.` } as const;
      service.listing = scripted;
      service.adoption = scripted;
      const { app, restore } = createAuthenticatedApiTestApp(
        TEST_USER,
        createExternalSessionRoutes(service)
      );
      restoreAuth = restore;

      for (const response of [await app.handle(listRequest()), await app.handle(adoptRequest())]) {
        const body = (await response.json()) as ApiErrorResponse;
        expect(response.status).toBe(status);
        expect(Value.Check(ApiErrorResponseSchema, body)).toBe(true);
        expect(body).toEqual({ error: `Refused: ${refusal}.`, code });
      }
    });
  }

  it('carries the connect failure reason in details when the refusal has one', async () => {
    const service = new FakeNativeSessionService();
    service.listing = {
      ok: false,
      code: 'unreachable',
      message: 'The environment is unavailable.',
      reason: 'backing-off',
    };
    const { app, restore } = createAuthenticatedApiTestApp(
      TEST_USER,
      createExternalSessionRoutes(service)
    );
    restoreAuth = restore;

    const response = await app.handle(listRequest());

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: 'The environment is unavailable.',
      code: ERROR_CODES.ENVIRONMENT_UNAVAILABLE,
      details: { reason: 'backing-off' },
    });
  });
});
