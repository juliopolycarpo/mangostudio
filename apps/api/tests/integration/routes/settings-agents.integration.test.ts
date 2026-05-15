import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Value } from '@sinclair/typebox/value';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  AgentMarkdownPreviewResponseSchema,
  AgentProfileListResponseSchema,
  AgentProfileSchema,
  type AgentProfile,
  type AgentProfileListResponse,
} from '@mangostudio/shared/agents';
import { DEFAULT_APP_SETTINGS } from '@mangostudio/shared/app-settings';
import { loadConfigForTest } from '../../../src/lib/config';
import { getDb } from '../../../src/db/database';
import { settingsRoutes } from '../../../src/routes/settings';
import { createAuthenticatedApiTestApp } from '../../support/harness/create-api-test-app';

const TEST_USER = {
  id: 'agent-settings-user',
  name: 'Agent Settings User',
  email: 'agent-settings@mangostudio.test',
};

const OTHER_USER = {
  id: 'agent-settings-other-user',
  name: 'Other Agent Settings User',
  email: 'other-agent-settings@mangostudio.test',
};

let restoreAuth: (() => void) | null = null;
let agentsDir: string;

beforeEach(() => {
  agentsDir = mkdtempSync(join(tmpdir(), 'mango-agent-routes-'));
  loadConfigForTest({ agents: { dir: agentsDir } });
});

afterEach(() => {
  restoreAuth?.();
  restoreAuth = null;
  rmSync(agentsDir, { recursive: true, force: true });
});

describe('settings agents routes', () => {
  it('lists built-in chat and default agents for authenticated users', async () => {
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, settingsRoutes);
    restoreAuth = restore;

    const response = await app.handle(new Request('http://localhost/settings/agents'));
    const payload = (await response.json()) as AgentProfileListResponse;

    expect(response.status).toBe(200);
    expect(Value.Check(AgentProfileListResponseSchema, payload)).toBe(true);
    expect(payload.agents.map((agent) => agent.id)).toEqual(['chat', 'default', 'explore']);
    expect(payload.agents.find((agent) => agent.id === 'chat')?.source).toEqual({
      type: 'builtin',
    });
    expect(payload.agents.find((agent) => agent.id === 'explore')).toMatchObject({
      role: 'subagent',
      kind: 'builtin',
    });
  });

  it('synthesizes chat from legacy app settings and enabled tools', async () => {
    await getDb()
      .insertInto('user_app_settings')
      .values({
        id: 'agent-legacy-app-settings',
        userId: TEST_USER.id,
        settingsJson: JSON.stringify({
          ...DEFAULT_APP_SETTINGS,
          promptSettings: {
            ...DEFAULT_APP_SETTINGS.promptSettings,
            textSystemPrompt: 'Legacy chat prompt',
          },
          thinkingEnabled: true,
          reasoningEffort: 'high',
          maxToolIterations: 4,
        }),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      .execute();
    await getDb()
      .insertInto('user_tool_settings')
      .values({
        id: 'agent-disabled-tool',
        userId: TEST_USER.id,
        toolName: 'generate_image',
        enabled: 0,
        parametersJson: '{}',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      .execute();
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, settingsRoutes);
    restoreAuth = restore;

    const response = await app.handle(new Request('http://localhost/settings/agents/chat'));
    const payload = (await response.json()) as AgentProfile;

    expect(response.status).toBe(200);
    expect(Value.Check(AgentProfileSchema, payload)).toBe(true);
    expect(payload).toMatchObject({
      id: 'chat',
      systemPrompt: 'Legacy chat prompt',
      thinkingEnabled: true,
      reasoningEffort: 'high',
      maxToolIterations: 4,
    });
    expect(payload.toolNames).toContain('get_current_datetime');
    expect(payload.toolNames).not.toContain('generate_image');
  });

  it('updates built-in chat settings per user', async () => {
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, settingsRoutes);
    restoreAuth = restore;

    const update = await app.handle(
      new Request('http://localhost/settings/agents/chat', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Chat',
          description: 'Custom chat profile.',
          role: 'primary',
          systemPrompt: 'Persisted chat prompt',
          thinkingEnabled: true,
          reasoningEffort: 'xhigh',
          maxToolIterations: 1_000,
          toolNames: ['read_file'],
          toolsEnabled: true,
          subagentIds: [],
          metadata: {},
        }),
      })
    );
    const payload = (await update.json()) as AgentProfile;

    expect(update.status).toBe(200);
    expect(payload).toMatchObject({
      id: 'chat',
      systemPrompt: 'Persisted chat prompt',
      maxToolIterations: 1_000,
    });

    restoreAuth?.();
    const other = createAuthenticatedApiTestApp(OTHER_USER, settingsRoutes);
    restoreAuth = other.restore;

    const otherResponse = await other.app.handle(
      new Request('http://localhost/settings/agents/chat')
    );
    const otherPayload = (await otherResponse.json()) as AgentProfile;

    expect(otherResponse.status).toBe(200);
    expect(otherPayload.systemPrompt).toBe('');
  });

  it('updates built-in explore settings per user and returns the saved profile in the list endpoint', async () => {
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, settingsRoutes);
    restoreAuth = restore;

    const update = await app.handle(
      new Request('http://localhost/settings/agents/explore', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Explore',
          description: 'Custom explore profile.',
          role: 'subagent',
          systemPrompt: 'Explore with persisted prompt.',
          thinkingEnabled: true,
          reasoningEffort: 'high',
          maxToolIterations: 3,
          toolNames: [],
          toolsEnabled: false,
          subagentIds: [],
          metadata: {},
        }),
      })
    );
    const payload = (await update.json()) as AgentProfile;

    expect(update.status).toBe(200);
    expect(payload).toMatchObject({
      id: 'explore',
      systemPrompt: 'Explore with persisted prompt.',
    });

    const listResponse = await app.handle(new Request('http://localhost/settings/agents'));
    const listPayload = (await listResponse.json()) as AgentProfileListResponse;

    expect(listResponse.status).toBe(200);
    expect(listPayload.agents.find((agent) => agent.id === 'explore')?.systemPrompt).toBe(
      'Explore with persisted prompt.'
    );

    restoreAuth?.();
    const other = createAuthenticatedApiTestApp(OTHER_USER, settingsRoutes);
    restoreAuth = other.restore;

    const otherListResponse = await other.app.handle(
      new Request('http://localhost/settings/agents')
    );
    const otherListPayload = (await otherListResponse.json()) as AgentProfileListResponse;

    expect(otherListResponse.status).toBe(200);
    expect(otherListPayload.agents.find((agent) => agent.id === 'explore')?.systemPrompt).toContain(
      'Final Report'
    );
  });

  it('creates, reads, updates, and deletes markdown-backed user agents', async () => {
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, settingsRoutes);
    restoreAuth = restore;

    const create = await app.handle(
      new Request('http://localhost/settings/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Researcher',
          description: 'Finds context.',
          role: 'both',
          systemPrompt: 'Research first.',
          toolNames: ['read_file'],
          toolsEnabled: true,
          subagentIds: [],
          metadata: { color: 'mango' },
        }),
      })
    );
    const created = (await create.json()) as AgentProfile;

    expect(create.status).toBe(200);
    expect(created.id).toBe('user:researcher');
    expect(existsSync(join(agentsDir, 'researcher.md'))).toBe(true);

    const read = await app.handle(new Request('http://localhost/settings/agents/user:researcher'));
    const readPayload = (await read.json()) as AgentProfile;
    expect(read.status).toBe(200);
    expect(readPayload.systemPrompt).toBe('Research first.');

    const update = await app.handle(
      new Request('http://localhost/settings/agents/user:researcher', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Researcher',
          description: 'Finds context.',
          role: 'both',
          systemPrompt: 'Research and cite files.',
          toolNames: ['read_file', 'list_directory'],
          toolsEnabled: true,
          subagentIds: [],
          metadata: {},
        }),
      })
    );
    const updated = (await update.json()) as AgentProfile;
    expect(update.status).toBe(200);
    expect(updated.systemPrompt).toBe('Research and cite files.');

    const deleted = await app.handle(
      new Request('http://localhost/settings/agents/user:researcher', { method: 'DELETE' })
    );
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ success: true });
    expect(existsSync(join(agentsDir, 'researcher.md'))).toBe(false);
  });

  it('previews markdown and returns typed validation errors', async () => {
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, settingsRoutes);
    restoreAuth = restore;

    const preview = await app.handle(
      new Request('http://localhost/settings/agents/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: 'user:preview-agent',
          markdown: '---\nname: Preview Agent\nrole: subagent\n---\nPreview prompt.',
        }),
      })
    );
    const payload = await preview.json();

    expect(preview.status).toBe(200);
    expect(Value.Check(AgentMarkdownPreviewResponseSchema, payload)).toBe(true);
    expect(payload).toMatchObject({ profile: { id: 'user:preview-agent', role: 'subagent' } });

    const invalid = await app.handle(
      new Request('http://localhost/settings/agents/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ markdown: '---\nname: Bad\nrole: worker\n---\nPrompt.' }),
      })
    );

    expect(invalid.status).toBe(422);
    expect(await invalid.json()).toMatchObject({ code: 'VALIDATION' });
  });
});
