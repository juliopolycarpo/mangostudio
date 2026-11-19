import { describe, expect, it } from 'bun:test';

import type { AppSettingsPutBody } from '../../src/app-settings';
import {
  appSettingsPatchExcludingProfiles,
  DEFAULT_APP_SETTINGS,
  libraryLocationsPatch,
  mergeAppSettingsPatch,
  normalizeAppSettings,
  onboardingPatch,
  preserveServerOwnedSettings,
} from '../../src/app-settings';
import { DEFAULT_ONBOARDING_STATE } from '../../src/onboarding';

describe('mergeAppSettingsPatch', () => {
  it('keeps a stored field the patch never mentions', () => {
    const merged = mergeAppSettingsPatch({ thinkingEnabled: true, reasoningEffort: 'high' }, {
      thinkingEnabled: false,
    } as AppSettingsPutBody);

    expect(merged).toEqual({ thinkingEnabled: false, reasoningEffort: 'high' });
  });

  it('merges the containers above an owned field so a sibling writer survives', () => {
    const merged = mergeAppSettingsPatch(
      {
        profileSettings: {
          default: { libraryLocations: { home: {} }, onboarding: { chatId: 'c' } },
          second: { onboarding: { chatId: 'other' } },
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
          onboarding: { welcomeAcknowledged: true, skippedSteps: [] },
        },
        second: { onboarding: { chatId: 'other' } },
      },
    });
  });

  it('replaces an owned field whole, so an absent optional member is a clear', () => {
    // The wizard sends the record it holds. Dropping `workdir` from it is how
    // "the machine changed, forget that path" is said, and merging into the
    // stored record would make it indistinguishable from never mentioning it.
    const merged = mergeAppSettingsPatch(
      {
        profileSettings: {
          default: { onboarding: { welcomeAcknowledged: true, workdir: '/old/machine' } },
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
        default: { onboarding: { welcomeAcknowledged: true, skippedSteps: [] } },
      },
    });
  });

  it('replaces a top-level field whole rather than merging into it', () => {
    const patch: AppSettingsPutBody = {
      chatDisplaySettings: { diffPreviewsEnabled: false, diffPreviewMode: 'collapsed' },
    };
    const merged = mergeAppSettingsPatch(
      {
        chatDisplaySettings: {
          diffPreviewsEnabled: true,
          diffPreviewMode: 'expanded',
          retiredOption: true,
        },
        thinkingEnabled: true,
      },
      patch
    );

    expect(merged).toEqual({
      chatDisplaySettings: { diffPreviewsEnabled: false, diffPreviewMode: 'collapsed' },
      thinkingEnabled: true,
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

describe('patching a row that predates the profileSettings nesting', () => {
  /** Library locations as an old build stored them: one flat map, no profile entry. */
  const legacyRow = {
    thinkingEnabled: true,
    libraryLocations: { 'claude-skills': true, 'agents-skills': true, 'claude-agents': true },
  };

  it('keeps the flat library mirror when a patch creates the profile entry without it', () => {
    // The first thing an upgrading account does is finish (or skip) first-run
    // setup, and that write names only `onboarding`. If creating the profile
    // entry read as "no locations stored", every toggle the person had set
    // would be silently replaced by this machine's detected defaults.
    const merged = mergeAppSettingsPatch(
      legacyRow,
      onboardingPatch({ welcomeAcknowledged: true, skippedSteps: [] })
    );

    expect(normalizeAppSettings(merged).profileSettings.default.libraryLocations.home).toEqual(
      normalizeAppSettings(legacyRow).profileSettings.default.libraryLocations.home
    );
  });

  it('still lets the nested value win once one is written', () => {
    const merged = mergeAppSettingsPatch(
      legacyRow,
      libraryLocationsPatch({ home: { 'claude-skills': false }, workspace: {} })
    );
    const home = normalizeAppSettings(merged).profileSettings.default.libraryLocations.home;

    expect(home['claude-skills']).toBe(false);
  });
});

describe('preserveServerOwnedSettings', () => {
  const storedGrant = {
    targetId: 'cursor' as const,
    environmentId: 'local',
    workspacePath: '/work/real',
    version: 1,
    acceptedAt: 5,
  };
  const forgedGrant = { ...storedGrant, workspacePath: '/etc/forged', version: 999 };
  const stored = { externalAgentSettings: { disclosures: {}, workspaceTrust: [storedGrant] } };

  it('replaces a client-supplied workspaceTrust with the stored one', () => {
    const safe = preserveServerOwnedSettings(stored, {
      externalAgentSettings: { disclosures: {}, workspaceTrust: [forgedGrant] },
    } as AppSettingsPutBody);

    expect(safe.externalAgentSettings?.workspaceTrust).toEqual([storedGrant]);
  });

  it('keeps the grants when the client sends an empty list', () => {
    const safe = preserveServerOwnedSettings(stored, {
      externalAgentSettings: { disclosures: {}, workspaceTrust: [] },
    } as AppSettingsPutBody);

    expect(safe.externalAgentSettings?.workspaceTrust).toEqual([storedGrant]);
  });

  it('fills the stored grants in when the client omits the field', () => {
    const safe = preserveServerOwnedSettings(stored, {
      externalAgentSettings: { disclosures: {} },
    } as AppSettingsPutBody);

    expect(safe.externalAgentSettings?.workspaceTrust).toEqual([storedGrant]);
  });

  it('leaves the rest of the subtree to the client', () => {
    const safe = preserveServerOwnedSettings(stored, {
      externalAgentSettings: { disclosures: {}, defaults: { cursor: { model: 'auto' } } },
    } as AppSettingsPutBody);

    expect(safe.externalAgentSettings?.defaults).toEqual({ cursor: { model: 'auto' } });
  });

  it('returns a patch without externalAgentSettings unchanged', () => {
    const patch = { thinkingEnabled: true } as AppSettingsPutBody;

    expect(preserveServerOwnedSettings(stored, patch)).toBe(patch);
  });

  it('normalizes to no grants when nothing is stored, whatever the client sent', () => {
    const merged = mergeAppSettingsPatch(
      undefined,
      preserveServerOwnedSettings(undefined, {
        externalAgentSettings: { disclosures: {}, workspaceTrust: [forgedGrant] },
      } as AppSettingsPutBody)
    );

    expect(normalizeAppSettings(merged).externalAgentSettings.workspaceTrust).toEqual([]);
  });
});
