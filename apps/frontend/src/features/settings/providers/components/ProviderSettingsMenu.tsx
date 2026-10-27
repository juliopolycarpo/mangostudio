/**
 * Provider settings menu — every provider as a row that opens its own page.
 */

import { SlidersHorizontal } from 'lucide-react';

import { SettingsPage } from '@/components/settings/SettingsPage';
import { SettingsLoadError, SettingsLoading } from '@/components/settings/SettingsStates';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { useI18n } from '@/hooks/use-i18n';
import { ICON_LG } from '@/lib/icon-sizes';

import { useProviderSettingsList } from '../hooks/use-provider-settings';
import { ProviderSettingsRow } from './ProviderSettingsRow';

/**
 * The providers are one divided card, not a card each: a row here only
 * navigates and carries no action of its own, so it is a settings row that
 * leads to a page, and a card per row would draw eight boxes to list eight
 * names. `overflow-hidden` clips each row's hover fill to the card's corners.
 */
export function ProviderSettingsMenu() {
  const { t } = useI18n();
  const s = t.settings.providers;
  const { providers, isLoading, error, refetch } = useProviderSettingsList();

  return (
    <SettingsPage title={s.title} description={s.perProviderSettings}>
      {isLoading ? (
        <SettingsLoading />
      ) : error ? (
        <SettingsLoadError message={s.loadError} onRetry={() => void refetch()} />
      ) : providers.length === 0 ? (
        <Card padded={false}>
          <EmptyState icon={<SlidersHorizontal size={ICON_LG} />} title={s.noProviders} />
        </Card>
      ) : (
        <Card padded={false} className="overflow-hidden">
          <ul className="divide-y divide-stroke">
            {providers.map((descriptor) => (
              <li key={descriptor.provider}>
                <ProviderSettingsRow descriptor={descriptor} />
              </li>
            ))}
          </ul>
        </Card>
      )}
    </SettingsPage>
  );
}
