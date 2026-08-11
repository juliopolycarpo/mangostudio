import { TabNav } from '@/components/ui/TabNav';
import { useI18n } from '@/hooks/use-i18n';

/**
 * Top-level navigation for the settings surface.
 */
export function SettingsTabs() {
  const { t } = useI18n();

  return (
    <TabNav
      label={t.common.settingsNavigation}
      tabs={[
        { to: '/settings/general', label: t.settings.tabs.general },
        { to: '/settings/connectors', label: t.settings.tabs.connectors },
        { to: '/settings/providers', label: t.settings.tabs.providers },
        { to: '/settings/agents', label: t.settings.tabs.agents },
        { to: '/settings/prompts', label: t.settings.tabs.prompts },
        { to: '/settings/appearance', label: t.settings.tabs.appearance },
        { to: '/settings/context', label: t.settings.tabs.context },
        { to: '/settings/git', label: t.settings.tabs.git },
        { to: '/settings/tools', label: t.settings.tabs.tools },
        { to: '/settings/skills', label: t.settings.tabs.skills },
        { to: '/settings/mcp', label: t.settings.tabs.mcp },
        { to: '/settings/external-api', label: t.settings.tabs.externalApi },
        { to: '/settings/external-agents', label: t.settings.tabs.externalAgents },
        { to: '/settings/metrics', label: t.settings.tabs.metrics },
        { to: '/settings/logs', label: t.settings.tabs.logs },
      ]}
    />
  );
}
