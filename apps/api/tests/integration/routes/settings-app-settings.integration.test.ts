import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  type AppSettings,
  AppSettingsSchema,
  DEFAULT_APP_SETTINGS,
} from '@mangostudio/shared/app-settings';
import Value from 'typebox/value';
import { getDb } from '../../../src/db/database';
import { settingsRoutes } from '../../../src/routes/settings';
import { createAuthenticatedApiTestApp } from '../../support/harness/create-api-test-app';

interface TestIdentity {
  readonly id: string;
  readonly name: string;
  readonly email: string;
}

/**
 * Fresh identities per test, because `user_app_settings` is keyed by user and
 * nothing truncates it in between: `setupTestEnvironment()` migrates the
 * shared in-memory database once per process, and `--isolate` only gives each
 * *file* a fresh module graph, not each test. With a fixed `TEST_USER.id` the
 * file was order-dependent — "persists app settings per user" saves a
 * non-default settings blob for that id, and if it runs before "returns
 * defaults for a new user" the latter reads back the former's rows instead of
 * `DEFAULT_APP_SETTINGS`. Reproduced with `bun test --randomize --seed=1`
 * (also seed=2).
 *
 * A fresh id per test namespaces the rows instead of enumerating the tables
 * to truncate, so a test that starts writing a new one cannot reopen the hole.
 */
let identitySeq = 0;
let testUser: TestIdentity;
let otherUser: TestIdentity;

let restoreAuth: (() => void) | null = null;

beforeEach(() => {
  identitySeq += 1;
  testUser = {
    id: `app-settings-user-${identitySeq}`,
    name: 'App Settings User',
    email: `app-settings-${identitySeq}@mangostudio.test`,
  };
  otherUser = {
    id: `app-settings-other-user-${identitySeq}`,
    name: 'Other App Settings User',
    email: `other-app-settings-${identitySeq}@mangostudio.test`,
  };
});

afterEach(() => {
  restoreAuth?.();
  restoreAuth = null;
});

describe('settings app settings routes', () => {
  it('returns defaults for a new user', async () => {
    const { app, restore } = createAuthenticatedApiTestApp(testUser, settingsRoutes);
    restoreAuth = restore;

    const response = await app.handle(new Request('http://localhost/settings/app'));
    const payload = (await response.json()) as AppSettings;

    expect(response.status).toBe(200);
    expect(Value.Check(AppSettingsSchema, payload)).toBe(true);
    expect(payload).toEqual(DEFAULT_APP_SETTINGS);
  });

  it('persists app settings per user', async () => {
    const { app, restore } = createAuthenticatedApiTestApp(testUser, settingsRoutes);
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
    const other = createAuthenticatedApiTestApp(otherUser, settingsRoutes);
    restoreAuth = other.restore;

    const otherResponse = await other.app.handle(new Request('http://localhost/settings/app'));
    const otherPayload = (await otherResponse.json()) as AppSettings;

    expect(otherResponse.status).toBe(200);
    expect(otherPayload).toEqual(DEFAULT_APP_SETTINGS);
  });

  it('normalizes malformed persisted JSON to defaults', async () => {
    const malformedUserId = `malformed-app-settings-user-${identitySeq}`;
    await getDb()
      .insertInto('user_app_settings')
      .values({
        id: `malformed-app-settings-row-${identitySeq}`,
        userId: malformedUserId,
        settingsJson: '{bad-json',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      .execute();

    const { app, restore } = createAuthenticatedApiTestApp(
      {
        id: malformedUserId,
        name: 'Malformed App Settings User',
        email: `malformed-app-settings-${identitySeq}@mangostudio.test`,
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
    const { app, restore } = createAuthenticatedApiTestApp(testUser, settingsRoutes);
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
