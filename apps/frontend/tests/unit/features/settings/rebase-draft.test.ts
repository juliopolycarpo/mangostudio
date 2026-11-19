import { describe, expect, it } from 'bun:test';

import { type AppSettings, DEFAULT_APP_SETTINGS } from '@mangostudio/shared/app-settings';

import { rebaseAppSettingsDraft } from '@/features/settings/app/rebase-draft';

const BASE: AppSettings = DEFAULT_APP_SETTINGS;

function withPrompt(settings: AppSettings, textSystemPrompt: string): AppSettings {
  return { ...settings, promptSettings: { ...settings.promptSettings, textSystemPrompt } };
}

describe('rebaseAppSettingsDraft', () => {
  it('lays the edited field over the fetched value and keeps the fetched rest', () => {
    const draft = withPrompt(BASE, 'typed');
    const fetched: AppSettings = { ...BASE, globalImageQuality: '4K' };

    const rebased = rebaseAppSettingsDraft(BASE, draft, fetched);

    expect(rebased.promptSettings.textSystemPrompt).toBe('typed');
    expect(rebased.globalImageQuality).toBe('4K');
  });

  it('lets the edit win a field both sides changed', () => {
    const draft = withPrompt(BASE, 'mine');
    const fetched = withPrompt(BASE, 'theirs');

    expect(rebaseAppSettingsDraft(BASE, draft, fetched).promptSettings.textSystemPrompt).toBe(
      'mine'
    );
  });

  it('returns the fetched settings when nothing was edited', () => {
    const fetched: AppSettings = { ...BASE, globalImageQuality: '4K' };

    expect(rebaseAppSettingsDraft(BASE, { ...BASE }, fetched)).toEqual(fetched);
  });

  it('never carries the draft profile settings, which this surface does not own', () => {
    const draft: AppSettings = { ...BASE, profileSettings: {} };
    const fetched: AppSettings = { ...BASE };

    expect(rebaseAppSettingsDraft(BASE, draft, fetched).profileSettings).toBe(
      fetched.profileSettings
    );
  });

  it('does not mutate its inputs', () => {
    const draft = withPrompt(BASE, 'typed');
    const fetched: AppSettings = { ...BASE, globalImageQuality: '4K' };
    const fetchedBefore = structuredClone(fetched);

    rebaseAppSettingsDraft(BASE, draft, fetched);

    expect(fetched).toEqual(fetchedBefore);
  });
});
