import { afterEach, describe, expect, it } from 'bun:test';
import {
  ToolSettingsDescriptorSchema,
  type ToolSettingsListResponse,
  ToolSettingsListResponseSchema,
} from '@mangostudio/shared/tool-settings';
import { Value } from '@sinclair/typebox/value';
import { getDb } from '../../../src/db/database';
import { settingsRoutes } from '../../../src/routes/settings';
import { createAuthenticatedApiTestApp } from '../../support/harness/create-api-test-app';

const TEST_USER = {
  id: 'tool-settings-user',
  name: 'Tool Settings User',
  email: 'tool-settings@mangostudio.test',
};

const OTHER_USER = {
  id: 'tool-settings-other-user',
  name: 'Other Tool Settings User',
  email: 'other-tool-settings@mangostudio.test',
};

let restoreAuth: (() => void) | null = null;

afterEach(() => {
  restoreAuth?.();
  restoreAuth = null;
});

describe('settings tool settings routes', () => {
  it('lists descriptors for registered tools', async () => {
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, settingsRoutes);
    restoreAuth = restore;

    const response = await app.handle(new Request('http://localhost/settings/tools'));
    const payload = (await response.json()) as ToolSettingsListResponse;
    const toolNames = payload.tools.map((tool) => tool.name);

    expect(response.status).toBe(200);
    expect(Value.Check(ToolSettingsListResponseSchema, payload)).toBe(true);
    expect(toolNames).toContain('get_current_datetime');
    expect(toolNames).toContain('generate_image');
    expect(toolNames).toContain('read_file');
    expect(toolNames).toContain('list_directory');
    expect(payload.tools.find((tool) => tool.name === 'get_current_datetime')).toMatchObject({
      enabled: true,
    });
    expect(payload.tools.find((tool) => tool.name === 'generate_image')).toMatchObject({
      enabled: true,
      category: 'image',
    });
  });

  it('persists tool settings per user', async () => {
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, settingsRoutes);
    restoreAuth = restore;

    const update = await app.handle(
      new Request('http://localhost/settings/tools/get_current_datetime', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled: false,
          parameters: { timezone: 'America/Sao_Paulo', locale: 'pt-BR' },
        }),
      })
    );
    const updatedPayload = await update.json();

    expect(update.status).toBe(200);
    expect(Value.Check(ToolSettingsDescriptorSchema, updatedPayload)).toBe(true);
    expect(updatedPayload).toMatchObject({
      enabled: false,
      parameters: { timezone: 'America/Sao_Paulo', locale: 'pt-BR' },
    });

    const reenabled = await app.handle(
      new Request('http://localhost/settings/tools/get_current_datetime', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true }),
      })
    );
    const reenabledPayload = await reenabled.json();

    expect(reenabled.status).toBe(200);
    expect(reenabledPayload).toMatchObject({ enabled: true });

    restoreAuth?.();
    const other = createAuthenticatedApiTestApp(OTHER_USER, settingsRoutes);
    restoreAuth = other.restore;

    const otherResponse = await other.app.handle(new Request('http://localhost/settings/tools'));
    const otherPayload = (await otherResponse.json()) as ToolSettingsListResponse;
    const otherTool = otherPayload.tools.find(
      (tool: { name: string }) => tool.name === 'get_current_datetime'
    );

    expect(otherResponse.status).toBe(200);
    expect(otherTool).toMatchObject({ enabled: true, parameters: { timezone: 'UTC' } });
  });

  it('normalizes malformed persisted JSON to tool defaults', async () => {
    await getDb()
      .insertInto('user_tool_settings')
      .values({
        id: 'malformed-tool-settings-row',
        userId: 'malformed-tool-settings-user',
        toolName: 'get_current_datetime',
        enabled: 1,
        parametersJson: '{bad-json',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      .execute();

    const { app, restore } = createAuthenticatedApiTestApp(
      {
        id: 'malformed-tool-settings-user',
        name: 'Malformed Tool User',
        email: 'malformed-tool-settings@mangostudio.test',
      },
      settingsRoutes
    );
    restoreAuth = restore;

    const response = await app.handle(new Request('http://localhost/settings/tools'));
    const payload = (await response.json()) as ToolSettingsListResponse;
    const tool = payload.tools.find(
      (item: { name: string }) => item.name === 'get_current_datetime'
    );

    expect(response.status).toBe(200);
    expect(tool).toMatchObject({ parameters: { timezone: 'UTC', locale: 'en-US' } });
  });

  it('returns typed errors for unknown tools and invalid parameters', async () => {
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, settingsRoutes);
    restoreAuth = restore;

    const unknown = await app.handle(
      new Request('http://localhost/settings/tools/unknown_tool', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true }),
      })
    );
    const invalid = await app.handle(
      new Request('http://localhost/settings/tools/get_current_datetime', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parameters: { timezone: 123 } }),
      })
    );

    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({ code: 'NOT_FOUND' });
    expect(invalid.status).toBe(422);
    expect(await invalid.json()).toMatchObject({ code: 'VALIDATION' });
  });
});
