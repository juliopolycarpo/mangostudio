/**
 * Second-level navigation for the library section of the environments umbrella.
 */

import { TabNav } from '@/components/ui/TabNav';
import { useI18n } from '@/hooks/use-i18n';

export function LibraryTabs() {
  const { t } = useI18n();

  return (
    <TabNav
      label={t.library.title}
      tabs={[
        { to: '/environments/library/skills', label: t.library.tabs.skills },
        { to: '/environments/library/subagents', label: t.library.tabs.subagents },
        { to: '/environments/library/instructions', label: t.library.tabs.instructions },
        { to: '/environments/library/settings', label: t.library.tabs.settings },
      ]}
    />
  );
}
