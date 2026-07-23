import {
  type ChatDisplaySettings,
  DEFAULT_APP_SETTINGS,
  DEFAULT_CHAT_DISPLAY_SETTINGS,
} from '@mangostudio/shared/app-settings';
import { useQuery } from '@tanstack/react-query';
import { appSettingsQueryOptions } from '@/features/settings/app/queries';

/**
 * Read-only view of the chat display preferences for chat-feed rendering.
 * Falls back to the shared defaults while settings load.
 *
 * // Usage: const { diffPreviewsEnabled, diffPreviewMode } = useChatDisplaySettings();
 */
export function useChatDisplaySettings(): ChatDisplaySettings {
  const { data } = useQuery({
    ...appSettingsQueryOptions(),
    placeholderData: DEFAULT_APP_SETTINGS,
  });
  return data?.chatDisplaySettings ?? DEFAULT_CHAT_DISPLAY_SETTINGS;
}
