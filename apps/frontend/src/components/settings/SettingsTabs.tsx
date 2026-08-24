import { TabNav } from '@/components/ui/TabNav';
import { useI18n } from '@/hooks/use-i18n';
import { settingsNavEntries } from './settings-nav';

/**
 * Top-level navigation for the settings surface.
 */
export function SettingsTabs() {
  const { t } = useI18n();

  return <TabNav label={t.common.settingsNavigation} tabs={settingsNavEntries(t.settings.tabs)} />;
}
