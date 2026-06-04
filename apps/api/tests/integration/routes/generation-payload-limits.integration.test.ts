import { afterEach, describe, expect, it } from 'bun:test';
import {
  GENERATION_ATTACHMENT_IDS_MAX_ITEMS,
  GENERATION_PROMPT_MAX_LENGTH,
  GENERATION_SYSTEM_PROMPT_MAX_LENGTH,
} from '@mangostudio/shared/generation';
import { generateRoutes } from '../../../src/modules/generation/http/generate-routes';
import { respondRoutes } from '../../../src/modules/generation/http/respond-routes';
import { respondStreamRoutes } from '../../../src/modules/generation/http/respond-stream-routes';
import { createAuthenticatedApiTestApp } from '../../support/harness/create-api-test-app';

const TEST_USER = {
  id: 'generation-payload-limits-user',
  name: 'Generation Payload Limits',
  email: 'generation-payload-limits@mangostudio.test',
};

let restoreAuth: (() => void) | null = null;

afterEach(() => {
  restoreAuth?.();
  restoreAuth = null;
});

function createApp(...routes: Parameters<typeof createAuthenticatedApiTestApp>[1][]) {
  const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, ...routes);
  restoreAuth = restore;
  return app;
}

function jsonPost(path: string, body: object): Request {
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('generation payload size limits', () => {
  it('rejects oversized text generation prompts', async () => {
    const app = createApp(respondRoutes);

    const response = await app.handle(
      jsonPost('/respond', {
        chatId: 'chat-payload-limits',
        prompt: 'x'.repeat(GENERATION_PROMPT_MAX_LENGTH + 1),
      })
    );

    expect(response.status).toBe(422);
  });

  it('rejects oversized streaming attachment lists', async () => {
    const app = createApp(respondStreamRoutes);

    const response = await app.handle(
      jsonPost('/respond/stream', {
        chatId: 'chat-payload-limits',
        prompt: 'Hello',
        attachmentIds: Array.from(
          { length: GENERATION_ATTACHMENT_IDS_MAX_ITEMS + 1 },
          (_, index) => `attachment-${index}`
        ),
      })
    );

    expect(response.status).toBe(422);
  });

  it('rejects oversized image generation system prompts', async () => {
    const app = createApp(generateRoutes);

    const response = await app.handle(
      jsonPost('/generate', {
        chatId: 'chat-payload-limits',
        prompt: 'A small mango studio icon',
        systemPrompt: 'x'.repeat(GENERATION_SYSTEM_PROMPT_MAX_LENGTH + 1),
      })
    );

    expect(response.status).toBe(422);
  });
});
