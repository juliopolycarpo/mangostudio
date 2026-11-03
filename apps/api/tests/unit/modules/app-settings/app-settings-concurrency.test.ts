import { describe, expect, it, spyOn } from 'bun:test';

import {
  DEFAULT_APP_SETTINGS,
  libraryLocationsFor,
  libraryLocationsPatch,
  onboardingFor,
  onboardingPatch,
} from '@mangostudio/shared/app-settings';

import { getDb } from '../../../../src/db/database';
import { AppSettingsConflict } from '../../../../src/modules/app-settings/domain/app-settings-conflict';
import {
  getSavedAppSettings,
  getSavedAppSettingsSnapshot,
  patchAppSettings,
  patchAppSettingsSnapshot,
} from '../../../../src/modules/app-settings/infrastructure/app-settings-repository';
import { grantWorkspaceTrust } from '../../../../src/modules/external-agents/application/external-workspace-trust';
import { holdFirstAppSettingsRead } from '../../../support/app-settings-read-barrier';
import { makeTestIdentity } from '../../../support/factories';

describe('atomic app-settings patches', () => {
  it('rejects an older client token after preferences return to the same value', async () => {
    const user = makeTestIdentity('settings-client-aba', 'Settings client ABA');
    const db = getDb();
    const initial = await patchAppSettingsSnapshot(db, user.id, { thinkingEnabled: false });
    await patchAppSettingsSnapshot(db, user.id, { thinkingEnabled: true });
    const returned = await patchAppSettingsSnapshot(db, user.id, { thinkingEnabled: false });
    expect(returned.settings).toEqual(initial.settings);
    expect(returned.revision).not.toBe(initial.revision);
    await expect(
      patchAppSettingsSnapshot(
        db,
        user.id,
        { globalImageQuality: '4K' },
        undefined,
        initial.revision
      )
    ).rejects.toMatchObject({ name: 'AppSettingsConflict' });
  });

  it('keeps a legacy row revision stable without writing and rejects it after a change', async () => {
    const user = makeTestIdentity('settings-legacy-revision', 'Settings legacy revision');
    const db = getDb();
    await patchAppSettings(db, user.id, { thinkingEnabled: false });
    const legacy = JSON.stringify({ ...DEFAULT_APP_SETTINGS, thinkingEnabled: false });
    await db
      .updateTable('user_app_settings')
      .set({ settingsJson: legacy })
      .where('userId', '=', user.id)
      .execute();
    const initial = await getSavedAppSettingsSnapshot(db, user.id);
    expect((await getSavedAppSettingsSnapshot(db, user.id)).revision).toBe(initial.revision);
    expect(
      (
        await db
          .selectFrom('user_app_settings')
          .select('settingsJson')
          .where('userId', '=', user.id)
          .executeTakeFirstOrThrow()
      ).settingsJson
    ).toBe(legacy);
    await db
      .updateTable('user_app_settings')
      .set({ settingsJson: JSON.stringify({ ...DEFAULT_APP_SETTINGS, thinkingEnabled: true }) })
      .where('userId', '=', user.id)
      .execute();
    await expect(
      patchAppSettingsSnapshot(
        db,
        user.id,
        { globalImageQuality: '4K' },
        undefined,
        initial.revision
      )
    ).rejects.toMatchObject({ name: 'AppSettingsConflict' });
    expect((await getSavedAppSettings(db, user.id)).globalImageQuality).toBe(
      DEFAULT_APP_SETTINGS.globalImageQuality
    );
  });

  it('rejects an initial revision after another client creates the row', async () => {
    const user = makeTestIdentity('settings-initial-revision', 'Settings initial revision');
    const db = getDb();
    const initial = await getSavedAppSettingsSnapshot(db, user.id);
    const saved = await patchAppSettingsSnapshot(
      db,
      user.id,
      { thinkingEnabled: true },
      undefined,
      initial.revision
    );
    expect(saved.revision).not.toBe(initial.revision);
    await expect(
      patchAppSettingsSnapshot(db, user.id, { thinkingEnabled: false }, undefined, initial.revision)
    ).rejects.toMatchObject({ name: 'AppSettingsConflict' });
    expect((await getSavedAppSettings(db, user.id)).thinkingEnabled).toBe(true);
  });

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

  it('rejects a workspace trust grant built before another workspace was revoked', async () => {
    const user = makeTestIdentity('settings-trust-revocation', 'Settings trust revocation');
    const db = getDb();
    const scope = {
      userId: user.id,
      targetId: 'cursor' as const,
      environmentId: 'local',
      workspacePath: '/work/revoked',
    };
    await grantWorkspaceTrust(scope, db);
    const barrier = holdFirstAppSettingsRead();
    const stale = grantWorkspaceTrust(
      { ...scope, workspacePath: '/work/new' },
      db.withPlugin(barrier.plugin)
    ).then(
      () => null,
      (error: unknown) => error
    );
    try {
      await barrier.read;
      const current = await getSavedAppSettings(db, user.id);
      await patchAppSettings(db, user.id, {
        externalAgentSettings: { ...current.externalAgentSettings, workspaceTrust: [] },
      });
    } finally {
      barrier.release();
    }
    expect(await stale).toBeInstanceOf(AppSettingsConflict);
    expect((await getSavedAppSettings(db, user.id)).externalAgentSettings.workspaceTrust).toEqual(
      []
    );
    await grantWorkspaceTrust({ ...scope, workspacePath: '/work/new' }, db);
    expect(
      (await getSavedAppSettings(db, user.id)).externalAgentSettings.workspaceTrust.map(
        (grant) => grant.workspacePath
      )
    ).toEqual(['/work/new']);
  });

  it('rejects a competing workspace grant without replacing the winning grant', async () => {
    const user = makeTestIdentity('settings-trust-competing', 'Settings trust competing');
    const db = getDb();
    const scope = {
      userId: user.id,
      targetId: 'cursor' as const,
      environmentId: 'local',
      workspacePath: '/work/first',
    };
    const barrier = holdFirstAppSettingsRead();
    const stale = grantWorkspaceTrust(scope, db.withPlugin(barrier.plugin)).then(
      () => null,
      (error: unknown) => error
    );
    try {
      await barrier.read;
      await grantWorkspaceTrust({ ...scope, workspacePath: '/work/winner' }, db);
    } finally {
      barrier.release();
    }
    expect(await stale).toBeInstanceOf(AppSettingsConflict);
    expect(
      (await getSavedAppSettings(db, user.id)).externalAgentSettings.workspaceTrust.map(
        (grant) => grant.workspacePath
      )
    ).toEqual(['/work/winner']);
    await grantWorkspaceTrust(scope, db);
    expect(
      (await getSavedAppSettings(db, user.id)).externalAgentSettings.workspaceTrust
        .map((grant) => grant.workspacePath)
        .sort()
    ).toEqual(['/work/first', '/work/winner']);
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
    ).then(
      () => null,
      (error: unknown) => error
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
    expect(await grant).toBeInstanceOf(AppSettingsConflict);
    await grantWorkspaceTrust(
      { userId: user.id, targetId: 'cursor', environmentId: 'local', workspacePath: '/work/repo' },
      db
    );
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
