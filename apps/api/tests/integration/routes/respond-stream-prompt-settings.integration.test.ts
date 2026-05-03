import { afterEach, describe, expect, it } from 'bun:test';
import { respondStreamRoutes } from '../../../src/modules/generation/http/respond-stream-routes';
import { createAuthenticatedApiTestApp } from '../../support/harness/create-api-test-app';

const TEST_USER = {
  id: 'prompt-settings-stream-user',
  name: 'Prompt Settings Stream',
  email: 'prompt-settings@mangostudio.test',
};

let restoreAuth: (() => void) | null = null;

afterEach(() => {
  restoreAuth?.();
  restoreAuth = null;
});

describe('POST /respond/stream with promptSettings', () => {
  it('accepts promptSettings in request body', async () => {
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, respondStreamRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      new Request('http://localhost/respond/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chatId: 'any-chat',
          prompt: 'Hello',
          promptSettings: {
            textSystemPrompt: 'You are an assistant.',
            imageSystemPrompt: '',
            agentsMd: {
              id: 'agentsMd',
              label: 'AGENTS.md',
              path: '~/.mango/AGENTS.md',
              enabled: false,
              injectionRole: 'system',
              sendFrequency: 'first-turn',
            },
            claudeMd: {
              id: 'claudeMd',
              label: 'CLAUDE.md',
              path: '~/.claude/CLAUDE.md',
              enabled: false,
              injectionRole: 'system',
              sendFrequency: 'first-turn',
            },
            customRules: [],
          },
        }),
      })
    );

    expect(response.status).not.toBe(422);
  });

  it('accepts request without promptSettings (backward compat)', async () => {
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, respondStreamRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      new Request('http://localhost/respond/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chatId: 'any-chat',
          prompt: 'Hello',
          systemPrompt: 'You are an assistant.',
        }),
      })
    );

    expect(response.status).not.toBe(422);
  });

  it('accepts request with both systemPrompt and promptSettings', async () => {
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, respondStreamRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      new Request('http://localhost/respond/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chatId: 'any-chat',
          prompt: 'Hello',
          systemPrompt: 'Be concise.',
          promptSettings: {
            textSystemPrompt: 'Base system prompt.',
            imageSystemPrompt: '',
            agentsMd: {
              id: 'agentsMd',
              label: 'AGENTS.md',
              path: '~/.mango/AGENTS.md',
              enabled: true,
              injectionRole: 'system',
              sendFrequency: 'every-turn',
            },
            claudeMd: {
              id: 'claudeMd',
              label: 'CLAUDE.md',
              path: '~/.claude/CLAUDE.md',
              enabled: false,
              injectionRole: 'system',
              sendFrequency: 'first-turn',
            },
            customRules: [],
          },
        }),
      })
    );

    expect(response.status).not.toBe(422);
  });
});
