/**
 * Provider settings menu — lists all providers with their status.
 */

import { Link } from '@tanstack/react-router';
import { Card } from '@/components/ui/Card';
import { useI18n } from '@/hooks/use-i18n';
import { useProviderSettingsList } from '../hooks/use-provider-settings';
import { ProviderSettingsCard } from './ProviderSettingsCard';

export function ProviderSettingsMenu() {
  const { t } = useI18n();
  const { providers, isLoading, error, refetch } = useProviderSettingsList();

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <p className="text-sm text-on-surface-variant">{t.common.loading}</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center gap-3 py-16">
        <p className="text-sm text-destructive">{t.settings.providers.loadError}</p>
        <button
          type="button"
          onClick={() => void refetch()}
          className="text-xs text-primary underline underline-offset-2 hover:no-underline"
        >
          Retry
        </button>
      </div>
    );
  }

  if (providers.length === 0) {
    return (
      <div className="flex items-center justify-center py-16">
        <p className="text-sm text-on-surface-variant">{t.settings.providers.noProviders}</p>
      </div>
    );
  }

  return (
    <Card variant="solid" className="p-4 sm:p-6 space-y-4">
      <h2 className="text-xs uppercase tracking-widest font-bold text-on-surface">
        {t.settings.providers.title}
      </h2>
      <p className="text-xs text-on-surface-variant">{t.settings.providers.perProviderSettings}</p>
      <div className="grid grid-cols-1 gap-3">
        {providers.map((descriptor) => (
          <Link
            key={descriptor.provider}
            to="/settings/providers/$provider"
            params={{ provider: descriptor.provider }}
            className="block"
          >
            <ProviderSettingsCard descriptor={descriptor} />
          </Link>
        ))}
      </div>
    </Card>
  );
}
