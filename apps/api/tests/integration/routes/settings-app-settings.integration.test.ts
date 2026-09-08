import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  type AppSettings,
  AppSettingsSchema,
  DEFAULT_APP_SETTINGS,
  onboardingFor,
} from '@mangostudio/shared/app-settings';
import { DEFAULT_ONBOARDING_STATE } from '@mangostudio/shared/onboarding';
import Value from 'typebox/value';
import { getDb } from '../../../src/db/database';
import { settingsRoutes } from '../../../src/routes/settings';
import { makeTestIdentity, type UserFixture } from '../../support/factories';
import { createAuthenticatedApiTestApp } from '../../support/harness/create-api-test-app';

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
 * `makeTestIdentity` (tests/support/factories) mints them, so the namespacing
 * rule is one helper rather than a per-file counter.
 */
let testUser: UserFixture;
let otherUser: UserFixture;

let restoreAuth: (() => void) | null = null;

beforeEach(() => {
  testUser = makeTestIdentity('app-settings-user', 'App Settings User');
  otherUser = makeTestIdentity('app-settings-other-user', 'Other App Settings User');
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
              panelOrder: ['todos', 'git', 'github', 'terminal'],
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
          panelOrder: ['todos', 'git', 'github', 'terminal'],
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
    const malformedUser = makeTestIdentity(
      'malformed-app-settings-user',
      'Malformed App Settings User'
    );
    await getDb()
      .insertInto('user_app_settings')
      .values({
        id: `malformed-app-settings-row-${malformedUser.id}`,
        userId: malformedUser.id,
        settingsJson: '{bad-json',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      .execute();

    const { app, restore } = createAuthenticatedApiTestApp(malformedUser, settingsRoutes);
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

describe('settings app settings partial updates', () => {
  const put = (app: { handle: (request: Request) => Promise<Response> }, body: unknown) =>
    app.handle(
      new Request('http://localhost/settings/app', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    );

  it('leaves omitted fields at their stored value', async () => {
    const user = makeTestIdentity('partial-app-settings-user', 'Partial App Settings User');
    const { app, restore } = createAuthenticatedApiTestApp(user, settingsRoutes);
    restoreAuth = restore;

    await put(app, { globalImageQuality: '4K', reasoningEffort: 'high' });
    const response = await put(app, { thinkingEnabled: true });
    const payload = (await response.json()) as AppSettings;

    expect(response.status).toBe(200);
    expect(payload.globalImageQuality).toBe('4K');
    expect(payload.reasoningEffort).toBe('high');
    expect(payload.thinkingEnabled).toBe(true);
  });

  it('requires a supplied subtree to be complete', async () => {
    const user = makeTestIdentity('nested-app-settings-user', 'Nested App Settings User');
    const { app, restore } = createAuthenticatedApiTestApp(user, settingsRoutes);
    restoreAuth = restore;

    // The unit of a patch is a whole top-level field. Half a subtree is
    // refused rather than quietly defaulted, so "I only sent one threshold"
    // can never silently reset the other three.
    const response = await put(app, { contextSettings: { compactionBehavior: 'off' } });

    expect(response.status).toBe(422);
  });

  it('replaces an array rather than merging it element by element', async () => {
    const user = makeTestIdentity('array-app-settings-user', 'Array App Settings User');
    const { app, restore } = createAuthenticatedApiTestApp(user, settingsRoutes);
    restoreAuth = restore;

    await put(app, {
      workspaceSettings: {
        ...DEFAULT_APP_SETTINGS.workspaceSettings,
        recentWorkdirs: ['/a', '/b'],
      },
    });
    const response = await put(app, {
      workspaceSettings: { ...DEFAULT_APP_SETTINGS.workspaceSettings, recentWorkdirs: ['/c'] },
    });
    const payload = (await response.json()) as AppSettings;

    expect(payload.workspaceSettings.recentWorkdirs).toEqual(['/c']);
  });

  it('persists onboarding progress on its own', async () => {
    const user = makeTestIdentity('onboarding-app-settings-user', 'Onboarding App Settings User');
    const { app, restore } = createAuthenticatedApiTestApp(user, settingsRoutes);
    restoreAuth = restore;

    const response = await put(app, {
      profileSettings: {
        default: {
          onboarding: {
            welcomeAcknowledged: true,
            skippedSteps: ['service'],
            workdir: '/home/dev/project',
          },
        },
      },
    });
    const payload = (await response.json()) as AppSettings;

    expect(response.status).toBe(200);
    expect(onboardingFor(payload)).toEqual({
      welcomeAcknowledged: true,
      skippedSteps: ['service'],
      workdir: '/home/dev/project',
    });
    expect(payload.profileSettings.default.libraryLocations).toEqual(
      DEFAULT_APP_SETTINGS.profileSettings.default.libraryLocations
    );
  });

  it('does not let a stale full snapshot roll back completed onboarding', async () => {
    const user = makeTestIdentity('stale-app-settings-user', 'Stale App Settings User');
    const { app, restore } = createAuthenticatedApiTestApp(user, settingsRoutes);
    restoreAuth = restore;

    // A settings tab that loaded before the wizard finished still holds the
    // pre-completion object. Its next save must carry only what it edits.
    const { profileSettings: _staleProfiles, ...staleSnapshot } = {
      ...DEFAULT_APP_SETTINGS,
      thinkingEnabled: true,
    };

    await put(app, {
      profileSettings: {
        default: { onboarding: { welcomeAcknowledged: true, skippedSteps: [], completedAt: 42 } },
      },
    });
    const response = await put(app, staleSnapshot);
    const payload = (await response.json()) as AppSettings;

    expect(payload.thinkingEnabled).toBe(true);
    expect(onboardingFor(payload).completedAt).toBe(42);
  });

  it('resets onboarding to "never started" when it is explicitly cleared', async () => {
    const user = makeTestIdentity('reset-app-settings-user', 'Reset App Settings User');
    const { app, restore } = createAuthenticatedApiTestApp(user, settingsRoutes);
    restoreAuth = restore;

    await put(app, {
      profileSettings: {
        default: { onboarding: { welcomeAcknowledged: true, skippedSteps: [], completedAt: 42 } },
      },
    });
    const response = await put(app, {
      profileSettings: { default: { onboarding: null } },
    });
    const payload = (await response.json()) as AppSettings;

    expect(onboardingFor(payload)).toEqual(DEFAULT_ONBOARDING_STATE);
  });

  it('rejects a step id that is not part of the flow', async () => {
    const user = makeTestIdentity('bad-step-app-settings-user', 'Bad Step App Settings User');
    const { app, restore } = createAuthenticatedApiTestApp(user, settingsRoutes);
    restoreAuth = restore;

    const response = await put(app, {
      profileSettings: {
        default: { onboarding: { welcomeAcknowledged: true, skippedSteps: ['not-a-step'] } },
      },
    });

    expect(response.status).toBe(422);
  });

  it('keeps the progress of one user out of another account', async () => {
    const first = makeTestIdentity('isolated-first-user', 'Isolated First User');
    const second = makeTestIdentity('isolated-second-user', 'Isolated Second User');

    const firstApp = createAuthenticatedApiTestApp(first, settingsRoutes);
    restoreAuth = firstApp.restore;
    await put(firstApp.app, {
      profileSettings: {
        default: { onboarding: { welcomeAcknowledged: true, skippedSteps: [], completedAt: 7 } },
      },
    });
    firstApp.restore();

    const secondApp = createAuthenticatedApiTestApp(second, settingsRoutes);
    restoreAuth = secondApp.restore;
    const response = await secondApp.app.handle(new Request('http://localhost/settings/app'));
    const payload = (await response.json()) as AppSettings;

    expect(onboardingFor(payload)).toEqual(DEFAULT_ONBOARDING_STATE);
  });
});
