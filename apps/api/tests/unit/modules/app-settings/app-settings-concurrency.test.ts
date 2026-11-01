import { describe, expect, it, spyOn } from 'bun:test';

import {
  DEFAULT_APP_SETTINGS,
  libraryLocationsFor,
  libraryLocationsPatch,
  onboardingFor,
  onboardingPatch,
} from '@mangostudio/shared/app-settings';

import { getDb } from '../../../../src/db/database';
import {
  getSavedAppSettings,
  patchAppSettings,
} from '../../../../src/modules/app-settings/infrastructure/app-settings-repository';
import { grantWorkspaceTrust } from '../../../../src/modules/external-agents/application/external-workspace-trust';
import { holdFirstAppSettingsRead } from '../../../support/app-settings-read-barrier';
import { makeTestIdentity } from '../../../support/factories';

describe('atomic app-settings patches', () => {
  for (const existing of [false, true]) {
    it(`reports a disjoint writer conflict on ${existing ? 'an existing' : 'a new'} row and permits a fresh patch`, async () => {
      const user = makeTestIdentity('settings-concurrency', 'Settings concurrency');
      const db = getDb();
      if (existing) await patchAppSettings(db, user.id, { reasoningEffort: 'high' });
      const barrier = holdFirstAppSettingsRead();
      const stale = patchAppSettings(db.withPlugin(barrier.plugin), user.id, {
        thinkingEnabled: true,
      }).then(
        () => null,
        (error: unknown) => error
      );
      try {
        await barrier.read;
        await patchAppSettings(db, user.id, { globalImageQuality: '4K' });
      } finally {
        barrier.release();
      }
      expect(await stale).toBeInstanceOf(Error);
      expect(await stale).toMatchObject({ message: expect.stringContaining('Settings changed') });
      const winner = await getSavedAppSettings(db, user.id);
      expect(winner.globalImageQuality).toBe('4K');
      expect(winner.thinkingEnabled).toBe(false);

      // A new invocation re-reads the winner and applies only the requested
      // field. Replaying a normalized whole settings object would lose 4K.
      const retried = await patchAppSettings(db, user.id, { thinkingEnabled: true });
      expect(retried.globalImageQuality).toBe('4K');
      expect(retried.thinkingEnabled).toBe(true);
      expect(retried.reasoningEffort).toBe(
        existing ? 'high' : DEFAULT_APP_SETTINGS.reasoningEffort
      );
    });
  }

  it('does not let a stale same-field writer roll onboarding progress back', async () => {
    const user = makeTestIdentity('settings-progress-race', 'Settings progress race');
    const db = getDb();
    const initial = onboardingFor(DEFAULT_APP_SETTINGS);
    await patchAppSettings(db, user.id, onboardingPatch(initial));
    const barrier = holdFirstAppSettingsRead();
    const stale = patchAppSettings(
      db.withPlugin(barrier.plugin),
      user.id,
      onboardingPatch(initial)
    ).then(
      () => null,
      (error: unknown) => error
    );
    try {
      await barrier.read;
      await patchAppSettings(db, user.id, onboardingPatch({ ...initial, completedAt: 1234 }));
    } finally {
      barrier.release();
    }
    expect(await stale).toMatchObject({ name: 'AppSettingsConflict' });
    expect(onboardingFor(await getSavedAppSettings(db, user.id)).completedAt).toBe(1234);
  });

  it('preserves an explicit reset against a stale in-flight progress update', async () => {
    const user = makeTestIdentity('settings-reset-race', 'Settings reset race');
    const db = getDb();
    const initial = onboardingFor(DEFAULT_APP_SETTINGS);
    await patchAppSettings(db, user.id, onboardingPatch({ ...initial, completedAt: 1234 }));
    const barrier = holdFirstAppSettingsRead();
    const stale = patchAppSettings(
      db.withPlugin(barrier.plugin),
      user.id,
      onboardingPatch({ ...initial, completedAt: 9999 })
    ).then(
      () => null,
      (error: unknown) => error
    );
    try {
      await barrier.read;
      await patchAppSettings(db, user.id, onboardingPatch(null));
    } finally {
      barrier.release();
    }
    expect(await stale).toMatchObject({ name: 'AppSettingsConflict' });
    expect(onboardingFor(await getSavedAppSettings(db, user.id))).toEqual(initial);
  });

  it('rejects an ABA write even when preferences and timestamps return to the read value', async () => {
    const user = makeTestIdentity('settings-aba', 'Settings ABA');
    const db = getDb();
    const clock = spyOn(Date, 'now').mockReturnValue(1234);
    const barrier = holdFirstAppSettingsRead();
    let stale: Promise<unknown> | undefined;
    try {
      await patchAppSettings(db, user.id, { thinkingEnabled: false });
      stale = patchAppSettings(db.withPlugin(barrier.plugin), user.id, {
        globalImageQuality: '4K',
      }).then(
        () => null,
        (error: unknown) => error
      );
      await barrier.read;
      await patchAppSettings(db, user.id, { thinkingEnabled: true });
      await patchAppSettings(db, user.id, { thinkingEnabled: false });
    } finally {
      barrier.release();
      clock.mockRestore();
    }
    expect(await stale).toMatchObject({ name: 'AppSettingsConflict' });
    expect((await getSavedAppSettings(db, user.id)).globalImageQuality).toBe(
      DEFAULT_APP_SETTINGS.globalImageQuality
    );
  });

  it('does not carry an older app snapshot through a workspace trust grant', async () => {
    const user = makeTestIdentity('settings-trust-patch', 'Settings trust patch');
    const db = getDb();
    const barrier = holdFirstAppSettingsRead();
    const grant = grantWorkspaceTrust(
      {
        userId: user.id,
        targetId: 'cursor',
        environmentId: 'local',
        workspacePath: '/work/repo',
      },
      db.withPlugin(barrier.plugin)
    );
    try {
      await barrier.read;
      await patchAppSettings(db, user.id, {
        globalImageQuality: '4K',
        ...onboardingPatch({ ...onboardingFor(DEFAULT_APP_SETTINGS), completedAt: 1234 }),
      });
    } finally {
      barrier.release();
    }
    await grant;
    const saved = await getSavedAppSettings(db, user.id);
    expect(saved.globalImageQuality).toBe('4K');
    expect(onboardingFor(saved).completedAt).toBe(1234);
    expect(saved.externalAgentSettings.workspaceTrust).toHaveLength(1);
  });

  it('keeps legacy mirrors, unknown stored fields, and explicit resets when CAS updates a legacy row', async () => {
    const user = makeTestIdentity('settings-legacy-cas', 'Settings legacy CAS');
    const db = getDb();
    await db
      .insertInto('user_app_settings')
      .values({
        id: `legacy-${user.id}`,
        userId: user.id,
        settingsJson: JSON.stringify({ futurePreference: { enabled: true } }),
        createdAt: 10,
        updatedAt: 10,
      })
      .execute();
    const locations = libraryLocationsFor(DEFAULT_APP_SETTINGS);
    await patchAppSettings(db, user.id, {
      ...libraryLocationsPatch({
        ...locations,
        home: { ...locations.home, 'claude-skills': true },
      }),
      reasoningEffort: 'high',
    });
    const saved = await patchAppSettings(db, user.id, onboardingPatch(null));
    expect(saved.reasoningEffort).toBe('high');
    expect(onboardingFor(saved)).toEqual(onboardingFor(DEFAULT_APP_SETTINGS));
    expect(libraryLocationsFor(saved).home['claude-skills']).toBe(true);
    expect('_writeVersion' in saved).toBe(false);
    const row = await db
      .selectFrom('user_app_settings')
      .selectAll()
      .where('userId', '=', user.id)
      .executeTakeFirstOrThrow();
    const stored: unknown = JSON.parse(row.settingsJson);
    expect(row.id).toBe(`legacy-${user.id}`);
    expect(row.createdAt).toBe(10);
    expect(stored).toMatchObject({
      futurePreference: { enabled: true },
      libraryLocations: libraryLocationsFor(saved).home,
      skillSources: { claude: true },
      _writeVersion: expect.any(String),
    });
  });
});
