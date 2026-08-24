/**
 * Top-level navigation for the environments umbrella: everything about the
 * user's tooling, library included. The library tab opens a section that
 * renders a second strip of its own.
 */

import { TabNav } from '@/components/ui/TabNav';
import { useI18n } from '@/hooks/use-i18n';
import { environmentNavEntries } from '../environments-nav';

export function EnvironmentTabs() {
  const { t } = useI18n();

  return <TabNav label={t.environments.title} tabs={environmentNavEntries(t.environments.tabs)} />;
}
