import { afterEach, describe, expect, it } from 'bun:test';
import { generateRoutes } from '../../../src/modules/generation/http/generate-routes';
import { createAuthenticatedApiTestApp } from '../../support/harness/create-api-test-app';

const TEST_USER = {
  id: 'prompt-settings-gen-user',
  name: 'Prompt Settings Gen',
  email: 'prompt-settings-gen@mangostudio.test',
};

let restoreAuth: (() => void) | null = null;

afterEach(() => {
  restoreAuth?.();
  restoreAuth = null;
});

describe('POST /generate with promptSettings', () => {
  it('accepts promptSettings in request body', async () => {
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, generateRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      new Request('http://localhost/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chatId: 'any-chat',
          prompt: 'A beautiful sunset',
          promptSettings: {
            textSystemPrompt: '',
            imageSystemPrompt: 'Generate photorealistic images.',
            agentsMd: {
              id: 'agentsMd',
              label: 'AGENTS.md',
              path: '~/.mango/AGENTS.md',
              enabled: true,
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
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, generateRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      new Request('http://localhost/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chatId: 'any-chat',
          prompt: 'A beautiful sunset',
          systemPrompt: 'Generate photorealistic images.',
        }),
      })
    );

    expect(response.status).not.toBe(422);
  });

  it('accepts request with both systemPrompt and promptSettings', async () => {
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, generateRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      new Request('http://localhost/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chatId: 'any-chat',
          prompt: 'A beautiful sunset',
          systemPrompt: 'Generic prompt.',
          promptSettings: {
            textSystemPrompt: '',
            imageSystemPrompt: 'Base image system prompt.',
            agentsMd: {
              id: 'agentsMd',
              label: 'AGENTS.md',
              path: '~/.mango/AGENTS.md',
              enabled: true,
              injectionRole: 'user',
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
