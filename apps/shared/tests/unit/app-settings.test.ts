import { describe, expect, it } from 'vitest';
import {
  DEFAULT_APP_SETTINGS,
  DEFAULT_CHAT_TITLE_SETTINGS,
  normalizeAppSettings,
  normalizeChatTitleSettings,
} from '../../src/app-settings';

describe('normalizeChatTitleSettings', () => {
  it('falls back to prompt-prefix auto rename by default', () => {
    expect(normalizeChatTitleSettings(undefined)).toEqual(DEFAULT_CHAT_TITLE_SETTINGS);
  });

  it('preserves user decisions and clamps the prompt prefix length', () => {
    expect(
      normalizeChatTitleSettings({ autoRenameEnabled: false, promptPrefixLength: 120 })
    ).toEqual({
      autoRenameEnabled: false,
      promptPrefixLength: 80,
    });
  });
});

describe('normalizeAppSettings', () => {
  it('normalizes missing chat title settings to the shared defaults', () => {
    expect(normalizeAppSettings({}).chatTitleSettings).toEqual(
      DEFAULT_APP_SETTINGS.chatTitleSettings
    );
  });
});
