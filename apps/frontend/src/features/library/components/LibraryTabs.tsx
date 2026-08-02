/**
 * Second-level navigation for the library section of the environments umbrella.
 */

import { TabNav } from '@/components/ui/TabNav';
import { useEnvironmentScope } from '@/features/environments/use-environment-scope';
import { useI18n } from '@/hooks/use-i18n';
import { libraryEnvironmentSearch } from '../queries';

export function LibraryTabs() {
  const { t } = useI18n();
  const scope = useEnvironmentScope();
  const search = libraryEnvironmentSearch(scope.environmentId);

  return (
    <TabNav
      label={t.library.title}
      tabs={[
        { to: '/environments/library/skills', label: t.library.tabs.skills, search },
        { to: '/environments/library/subagents', label: t.library.tabs.subagents, search },
        { to: '/environments/library/instructions', label: t.library.tabs.instructions, search },
        { to: '/environments/library/settings', label: t.library.tabs.settings, search },
      ]}
    />
  );
}
