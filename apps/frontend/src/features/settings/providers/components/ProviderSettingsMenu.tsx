/**
 * Provider settings menu — lists all providers with their status.
 */

import { Link } from '@tanstack/react-router';
import { SettingsPage } from '@/components/settings/SettingsPage';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { EmptyState } from '@/components/ui/EmptyState';
import { Skeleton } from '@/components/ui/Skeleton';
import { useI18n } from '@/hooks/use-i18n';
import { useProviderSettingsList } from '../hooks/use-provider-settings';
import { ProviderSettingsCard } from './ProviderSettingsCard';

export function ProviderSettingsMenu() {
  const { t } = useI18n();
  const s = t.settings.providers;
  const { providers, isLoading, error, refetch } = useProviderSettingsList();

  return (
    <SettingsPage title={s.title} description={s.perProviderSettings}>
      {isLoading ? (
        <div role="status" className="space-y-3">
          <Skeleton className="h-20 w-full rounded-md" />
          <Skeleton className="h-20 w-full rounded-md" />
          <span className="sr-only">{t.common.loading}</span>
        </div>
      ) : error ? (
        <Callout
          tone="danger"
          action={
            <Button variant="secondary" size="sm" onClick={() => void refetch()}>
              {t.common.retry}
            </Button>
          }
        >
          {s.loadError}
        </Callout>
      ) : providers.length === 0 ? (
        <EmptyState title={s.noProviders} />
      ) : (
        <div className="grid grid-cols-1 gap-3">
          {providers.map((descriptor) => (
            <Link
              key={descriptor.provider}
              to="/settings/providers/$provider"
              params={{ provider: descriptor.provider }}
              className="group block rounded-md"
            >
              <ProviderSettingsCard descriptor={descriptor} />
            </Link>
          ))}
        </div>
      )}
    </SettingsPage>
  );
}
