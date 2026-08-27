import { afterEach, describe, expect, it } from 'bun:test';
import {
  type AppSettings,
  AppSettingsSchema,
  DEFAULT_APP_SETTINGS,
} from '@mangostudio/shared/app-settings';
import Value from 'typebox/value';
import { getDb } from '../../../src/db/database';
import { settingsRoutes } from '../../../src/routes/settings';
import { createAuthenticatedApiTestApp } from '../../support/harness/create-api-test-app';

const TEST_USER = {
  id: 'app-settings-user',
  name: 'App Settings User',
  email: 'app-settings@mangostudio.test',
};

const OTHER_USER = {
  id: 'app-settings-other-user',
  name: 'Other App Settings User',
  email: 'other-app-settings@mangostudio.test',
};

let restoreAuth: (() => void) | null = null;

afterEach(() => {
  restoreAuth?.();
  restoreAuth = null;
});

describe('settings app settings routes', () => {
  it('returns defaults for a new user', async () => {
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, settingsRoutes);
    restoreAuth = restore;

    const response = await app.handle(new Request('http://localhost/settings/app'));
    const payload = (await response.json()) as AppSettings;

    expect(response.status).toBe(200);
    expect(Value.Check(AppSettingsSchema, payload)).toBe(true);
    expect(payload).toEqual(DEFAULT_APP_SETTINGS);
  });

  it('persists app settings per user', async () => {
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, settingsRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      new Request('http://localhost/settings/app', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...DEFAULT_APP_SETTINGS,
          globalImageQuality: '4K',
          thinkingEnabled: true,
          reasoningEffort: 'high',
          maxToolIterations: 1_000,
          contextSettings: {
            ...DEFAULT_APP_SETTINGS.contextSettings,
            compactionBehavior: 'off',
            providerCompactionEnabled: false,
          },
          workspaceSettings: {
            ...DEFAULT_APP_SETTINGS.workspaceSettings,
            sidePanel: {
              // A complete panel list: the normalizer backfills any id this blob
              // has never seen, so an incomplete order would echo back widened
              // and this round-trip assertion would fail for a reason it is not
              // testing.
              visiblePanelIds: ['todos'],
              panelOrder: ['todos', 'git', 'github'],
              width: 420,
            },
          },
          promptSettings: {
            ...DEFAULT_APP_SETTINGS.promptSettings,
            textSystemPrompt: 'Persisted text prompt',
            customRules: [
              {
                id: 'custom-rule-1',
                label: 'Team rules',
                path: '~/rules/team.md',
                enabled: true,
                injectionRole: 'system',
                sendFrequency: 'every-turn',
              },
            ],
          },
        } satisfies AppSettings),
      })
    );
    const payload = (await response.json()) as AppSettings;

    expect(response.status).toBe(200);
    expect(Value.Check(AppSettingsSchema, payload)).toBe(true);
    expect(payload).toMatchObject({
      globalImageQuality: '4K',
      thinkingEnabled: true,
      reasoningEffort: 'high',
      maxToolIterations: 1_000,
      contextSettings: {
        compactionBehavior: 'off',
        providerCompactionEnabled: false,
      },
      workspaceSettings: {
        sidePanel: {
          visiblePanelIds: ['todos'],
          panelOrder: ['todos', 'git', 'github'],
          width: 420,
        },
      },
      promptSettings: {
        textSystemPrompt: 'Persisted text prompt',
        customRules: [
          {
            id: 'custom-rule-1',
            enabled: true,
            sendFrequency: 'every-turn',
          },
        ],
      },
    });

    restoreAuth?.();
    const other = createAuthenticatedApiTestApp(OTHER_USER, settingsRoutes);
    restoreAuth = other.restore;

    const otherResponse = await other.app.handle(new Request('http://localhost/settings/app'));
    const otherPayload = (await otherResponse.json()) as AppSettings;

    expect(otherResponse.status).toBe(200);
    expect(otherPayload).toEqual(DEFAULT_APP_SETTINGS);
  });

  it('normalizes malformed persisted JSON to defaults', async () => {
    await getDb()
      .insertInto('user_app_settings')
      .values({
        id: 'malformed-app-settings-row',
        userId: 'malformed-app-settings-user',
        settingsJson: '{bad-json',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      .execute();

    const { app, restore } = createAuthenticatedApiTestApp(
      {
        id: 'malformed-app-settings-user',
        name: 'Malformed App Settings User',
        email: 'malformed-app-settings@mangostudio.test',
      },
      settingsRoutes
    );
    restoreAuth = restore;

    const response = await app.handle(new Request('http://localhost/settings/app'));
    const payload = (await response.json()) as AppSettings;

    expect(response.status).toBe(200);
    expect(payload).toEqual(DEFAULT_APP_SETTINGS);
  });

  it('accepts a PUT body missing the workspace library scope and normalizes on save', async () => {
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, settingsRoutes);
    restoreAuth = restore;

    const homeOnlyLibraryLocations = {
      home: DEFAULT_APP_SETTINGS.profileSettings.default.libraryLocations.home,
    };

    const response = await app.handle(
      new Request('http://localhost/settings/app', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...DEFAULT_APP_SETTINGS,
          profileSettings: {
            default: {
              libraryLocations: homeOnlyLibraryLocations,
            },
          },
        }),
      })
    );
    const payload = (await response.json()) as AppSettings;

    expect(response.status).toBe(200);
    expect(Value.Check(AppSettingsSchema, payload)).toBe(true);
    expect(payload.profileSettings.default.libraryLocations).toEqual(
      DEFAULT_APP_SETTINGS.profileSettings.default.libraryLocations
    );
  });
});
