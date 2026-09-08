import { describe, expect, it } from 'bun:test';
import type { AppSettingsPutBody } from '../../src/app-settings';
import {
  appSettingsPatchExcludingProfiles,
  DEFAULT_APP_SETTINGS,
  libraryLocationsPatch,
  mergeAppSettingsPatch,
  onboardingPatch,
} from '../../src/app-settings';
import { DEFAULT_ONBOARDING_STATE } from '../../src/onboarding';

describe('mergeAppSettingsPatch', () => {
  it('keeps a stored field the patch never mentions', () => {
    const merged = mergeAppSettingsPatch({ thinkingEnabled: true, reasoningEffort: 'high' }, {
      thinkingEnabled: false,
    } as AppSettingsPutBody);

    expect(merged).toEqual({ thinkingEnabled: false, reasoningEffort: 'high' });
  });

  it('merges two objects field by field rather than replacing the outer one', () => {
    const merged = mergeAppSettingsPatch(
      {
        profileSettings: {
          default: { libraryLocations: { home: {} }, onboarding: { chatId: 'c' } },
        },
      },
      {
        profileSettings: {
          default: { onboarding: { welcomeAcknowledged: true, skippedSteps: [] } },
        },
      } as AppSettingsPutBody
    );

    expect(merged).toEqual({
      profileSettings: {
        default: {
          libraryLocations: { home: {} },
          onboarding: { chatId: 'c', welcomeAcknowledged: true, skippedSteps: [] },
        },
      },
    });
  });

  it('replaces an array instead of merging it by index', () => {
    const merged = mergeAppSettingsPatch({ workspaceSettings: { recentWorkdirs: ['/a', '/b'] } }, {
      workspaceSettings: { recentWorkdirs: ['/c'] },
    } as AppSettingsPutBody);

    expect(merged).toEqual({ workspaceSettings: { recentWorkdirs: ['/c'] } });
  });

  it('replaces a stored object with an explicit null so a clear is expressible', () => {
    const merged = mergeAppSettingsPatch(
      { profileSettings: { default: { onboarding: { completedAt: 1 } } } },
      { profileSettings: { default: { onboarding: null } } } as AppSettingsPutBody
    );

    expect(merged).toEqual({ profileSettings: { default: { onboarding: null } } });
  });

  it('treats an explicitly undefined key as not supplied', () => {
    const merged = mergeAppSettingsPatch({ thinkingEnabled: true }, {
      thinkingEnabled: undefined,
    } as AppSettingsPutBody);

    expect(merged).toEqual({ thinkingEnabled: true });
  });

  it('takes the patch whole when nothing is stored yet', () => {
    expect(
      mergeAppSettingsPatch(undefined, { thinkingEnabled: true } as AppSettingsPutBody)
    ).toEqual({
      thinkingEnabled: true,
    });
    expect(
      mergeAppSettingsPatch('{bad-json', { thinkingEnabled: true } as AppSettingsPutBody)
    ).toEqual({ thinkingEnabled: true });
  });
});

describe('patch builders', () => {
  it('addresses only the library locations of one profile', () => {
    const patch = libraryLocationsPatch({ home: { 'claude-skills': true }, workspace: {} });

    expect(patch).toEqual({
      profileSettings: {
        default: { libraryLocations: { home: { 'claude-skills': true }, workspace: {} } },
      },
    });
  });

  it('addresses only the onboarding record of one profile', () => {
    expect(onboardingPatch(DEFAULT_ONBOARDING_STATE)).toEqual({
      profileSettings: { default: { onboarding: DEFAULT_ONBOARDING_STATE } },
    });
  });

  it('carries an explicit null through so a reset is expressible', () => {
    expect(onboardingPatch(null)).toEqual({ profileSettings: { default: { onboarding: null } } });
  });

  it('drops profile-scoped settings from a whole-object save', () => {
    const patch = appSettingsPatchExcludingProfiles(DEFAULT_APP_SETTINGS);

    expect(patch).not.toHaveProperty('profileSettings');
    expect(patch.thinkingEnabled).toBe(DEFAULT_APP_SETTINGS.thinkingEnabled);
  });
});
