/**
 * The generation routes answer failures as `status(code, body)`.
 *
 * Pins the wire result of that conversion: each refusal keeps its status, its
 * `ApiErrorResponse` body and its code, the same as when the handlers assigned
 * `set.status` and returned the bare body.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { ApiErrorResponseSchema, ERROR_CODES } from '@mangostudio/shared/errors';
import Value from 'typebox/value';

import { capabilityRoutes } from '../../../src/modules/generation/http/capability-routes';
import { generateRoutes } from '../../../src/modules/generation/http/generate-routes';
import { respondRoutes } from '../../../src/modules/generation/http/respond-routes';
import { respondStreamRoutes } from '../../../src/modules/generation/http/respond-stream-routes';
import { insertTestChat, insertTestUser, type UserFixture } from '../../support/factories';
import { createAuthenticatedApiTestApp } from '../../support/harness/create-api-test-app';

let user: UserFixture;
let restore: () => void;
let app: ReturnType<typeof createAuthenticatedApiTestApp>['app'];

beforeEach(async () => {
  user = await insertTestUser();
  const harness = createAuthenticatedApiTestApp(
    user,
    respondRoutes,
    respondStreamRoutes,
    generateRoutes,
    capabilityRoutes
  );
  app = harness.app;
  restore = harness.restore;
});

afterEach(() => {
  restore();
});

function post(path: string, body: unknown) {
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** Asserts the status, then the `ApiErrorResponse` envelope and code of the body. */
async function expectRefusal(response: Response, status: number, code: string) {
  expect(`status ${response.status}`).toBe(`status ${status}`);
  const body: unknown = await response.json();
  expect(Value.Check(ApiErrorResponseSchema, body)).toBe(true);
  expect(body).toMatchObject({ code });
}

describe('generation routes answer failures with their own status', () => {
  it('POST /respond answers 404 for a chat the user does not own', async () => {
    await expectRefusal(
      await app.handle(post('/respond', { chatId: 'missing-chat', prompt: 'Hello' })),
      404,
      ERROR_CODES.NOT_FOUND
    );
  });

  it('POST /respond answers 400 for an empty turn', async () => {
    const chat = await insertTestChat(user.id);
    await expectRefusal(
      await app.handle(post('/respond', { chatId: chat.id, prompt: '' })),
      400,
      ERROR_CODES.VALIDATION
    );
  });

  it('POST /respond keeps 404 when the keyed path refuses an unknown chat', async () => {
    await expectRefusal(
      await app.handle(
        post('/respond', { chatId: 'missing-chat', prompt: 'Hello', operationId: 'respond-key' })
      ),
      404,
      ERROR_CODES.NOT_FOUND
    );
  });

  it('POST /respond/stream answers 404 as JSON before any stream starts', async () => {
    const response = await app.handle(
      post('/respond/stream', { chatId: 'missing-chat', prompt: 'Hello' })
    );
    expect(response.headers.get('Content-Type')).toContain('application/json');
    await expectRefusal(response, 404, ERROR_CODES.NOT_FOUND);
  });

  it('POST /respond/stream answers 400 for an empty turn as JSON', async () => {
    const chat = await insertTestChat(user.id);
    const response = await app.handle(post('/respond/stream', { chatId: chat.id, prompt: '' }));
    expect(response.headers.get('Content-Type')).toContain('application/json');
    await expectRefusal(response, 400, ERROR_CODES.VALIDATION);
  });

  it('POST /generate answers 404 for a chat the user does not own', async () => {
    await expectRefusal(
      await app.handle(post('/generate', { chatId: 'missing-chat', prompt: 'A sunset' })),
      404,
      ERROR_CODES.NOT_FOUND
    );
  });

  it('GET /chats/:id/capabilities answers 404 for a chat the user does not own', async () => {
    await expectRefusal(
      await app.handle(new Request('http://localhost/chats/missing-chat/capabilities')),
      404,
      ERROR_CODES.NOT_FOUND
    );
  });
});
