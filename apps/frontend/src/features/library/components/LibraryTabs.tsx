/**
 * Second-level navigation for the library section of the environments umbrella.
 *
 * A resource's own page (`/library/skill:git-hygiene`) is not under any tab's
 * path, so the router lights none of them there and the strip says nothing
 * about where the person is. The tab of the resource's kind is marked current
 * instead, hooks with settings, as the page's back link already treats them.
 */

import { parseResourceKey } from '@mangostudio/shared/library/values';
import { useParams } from '@tanstack/react-router';

import { TabNav } from '@/components/ui/TabNav';
import { useEnvironmentScope } from '@/features/environments/use-environment-scope';
import { useI18n } from '@/hooks/use-i18n';

import { libraryKindPath } from '../format';
import { libraryEnvironmentSearch } from '../queries';

const TABS = [
  { to: '/environments/library/skills', id: 'skills' },
  { to: '/environments/library/subagents', id: 'subagents' },
  { to: '/environments/library/commands', id: 'commands' },
  { to: '/environments/library/instructions', id: 'instructions' },
  { to: '/environments/library/settings', id: 'settings' },
  { to: '/environments/library/locations', id: 'locations' },
] as const;

export function LibraryTabs() {
  const { t } = useI18n();
  const scope = useEnvironmentScope();
  const search = libraryEnvironmentSearch(scope.environmentId);
  // The layout renders above every child route, so the child's param is read
  // loosely: it is only there on a resource's page.
  const { resourceKey } = useParams({ strict: false });
  const kind = resourceKey ? parseResourceKey(resourceKey)?.kind : undefined;
  const currentTo = kind ? libraryKindPath(kind) : undefined;

  return (
    <TabNav
      label={t.library.title}
      tabs={TABS.map(({ to, id }) => ({
        to,
        label: t.library.tabs[id],
        search,
        current: to === currentTo,
      }))}
    />
  );
}
