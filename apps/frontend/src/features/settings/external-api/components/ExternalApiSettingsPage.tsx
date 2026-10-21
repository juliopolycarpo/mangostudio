/**
 * External API settings: enable toggle, key table, create, and revoke.
 */

import { API_KEY_MAX_PER_USER, type ApiKeySummary } from '@mangostudio/shared/api-keys';
import type { ExternalApiSettings } from '@mangostudio/shared/app-settings';
import { KeyRound, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { SettingsPage } from '@/components/settings/SettingsPage';
import { SettingsSection } from '@/components/settings/SettingsSection';
import { SettingToggle } from '@/components/settings/SettingToggle';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { EmptyState } from '@/components/ui/EmptyState';
import { Skeleton } from '@/components/ui/Skeleton';
import { useToast } from '@/components/ui/Toast';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';
import { ICON_LG, ICON_MD } from '@/lib/icon-sizes';
import { cn, resolveApiErrorMessage } from '@/lib/utils';
import {
  displayKeyName,
  formatApiKeyDate,
  formatKeyHint,
  hasKeyHint,
  isKeyActive,
  isKeyExpired,
  scopeLabel,
} from '../format';
import { useRevokeApiKey } from '../hooks/use-api-key-mutations';
import { useApiKeys } from '../queries';
import { CreateApiKeyDialog } from './CreateApiKeyDialog';
import { RevokeApiKeyDialog } from './RevokeApiKeyDialog';

interface ExternalApiSettingsPageProps {
  readonly settings: ExternalApiSettings;
  readonly setExternalApiEnabled: (value: boolean) => void;
}

export function ExternalApiSettingsPage({
  settings,
  setExternalApiEnabled,
}: ExternalApiSettingsPageProps) {
  const { t, locale } = useI18n();
  const s = t.settings.externalApi;
  const { toast } = useToast();
  const { keys, isLoading, error, refetch } = useApiKeys();
  const revokeMutation = useRevokeApiKey();

  const [createOpen, setCreateOpen] = useState(false);
  const [keyToRevoke, setKeyToRevoke] = useState<ApiKeySummary | null>(null);

  const activeCount = keys.filter((key) => isKeyActive(key)).length;
  // Keys created before the hint carried random characters all store the bare
  // prefix. A column of identical dashes says nothing, so it appears only once
  // some key has a hint that tells it apart.
  const showKeyColumn = keys.some((key) => hasKeyHint(key.start));
  const atCap = activeCount >= API_KEY_MAX_PER_USER;
  const atCapMessage = formatMessage(s.createDisabledAtCap, {
    max: String(API_KEY_MAX_PER_USER),
  });
  const enabled = settings.enabled;

  const handleRevoke = (apiKey: ApiKeySummary) => {
    revokeMutation.mutate(apiKey.id, {
      onSuccess: () => toast(s.revokeSuccess, 'success'),
      onError: (err) => toast(resolveApiErrorMessage(err, s.failedToRevoke), 'error'),
      onSettled: () => setKeyToRevoke(null),
    });
  };

  return (
    <SettingsPage title={s.title} description={s.description}>
      {/* The toggle is the kill switch for every key on the account, so it stays
          reachable even when the key list is still loading or failed to load. */}
      <SettingsSection
        notice={!enabled ? <Callout tone="warning">{s.disabledNotice}</Callout> : undefined}
      >
        <SettingToggle
          label={s.enableLabel}
          description={s.enableDescription}
          checked={enabled}
          onChange={setExternalApiEnabled}
        />
      </SettingsSection>

      <SettingsSection
        padded
        title={s.keysTitle}
        description={atCap ? atCapMessage : undefined}
        action={
          <Button
            variant="secondary"
            size="sm"
            disabled={atCap || isLoading || Boolean(error)}
            title={atCap ? atCapMessage : undefined}
            onClick={() => setCreateOpen(true)}
          >
            <Plus size={ICON_MD} />
            {s.createKey}
          </Button>
        }
      >
        {isLoading ? (
          <div role="status" className="space-y-2">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
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
        ) : keys.length === 0 ? (
          <EmptyState icon={<KeyRound size={ICON_LG} />} title={s.empty} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[40rem] border-collapse text-left text-sm">
              <thead>
                <tr className="border-b border-stroke text-xs text-fg-muted">
                  <th scope="col" className="px-2 py-2 font-medium">
                    {s.columns.name}
                  </th>
                  <th scope="col" className="px-2 py-2 font-medium">
                    {s.columns.scope}
                  </th>
                  {showKeyColumn && (
                    <th scope="col" className="px-2 py-2 font-medium">
                      {s.columns.key}
                    </th>
                  )}
                  <th scope="col" className="px-2 py-2 font-medium">
                    {s.columns.created}
                  </th>
                  <th scope="col" className="px-2 py-2 font-medium">
                    {s.columns.expires}
                  </th>
                  <th scope="col" className="px-2 py-2 font-medium">
                    {s.columns.lastUsed}
                  </th>
                  <th scope="col" className="px-2 py-2 font-medium">
                    <span className="sr-only">{s.columns.actions}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {keys.map((apiKey) => {
                  const expired = isKeyExpired(apiKey);
                  const inactive = !enabled || expired;
                  return (
                    <tr key={apiKey.id} className="border-b border-stroke last:border-b-0">
                      <td className="px-2 py-3 align-baseline">
                        <div className="space-y-1">
                          <span
                            className={cn('font-medium', inactive ? 'text-fg-muted' : 'text-fg')}
                          >
                            {displayKeyName(t, apiKey.name)}
                          </span>
                          {inactive && (
                            <span className="block">
                              <Badge variant={!enabled ? 'neutral' : 'warning'}>
                                {!enabled ? s.inactive : s.expired}
                              </Badge>
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-2 py-3 align-baseline">
                        <Badge>{scopeLabel(t, apiKey.scope)}</Badge>
                      </td>
                      {showKeyColumn && (
                        <td className="whitespace-nowrap px-2 py-3 align-baseline font-mono text-xs text-fg-muted">
                          {formatKeyHint(apiKey.start)}
                        </td>
                      )}
                      <td className="px-2 py-3 align-baseline text-fg-muted">
                        {formatApiKeyDate(apiKey.createdAt, locale, '—')}
                      </td>
                      <td className="px-2 py-3 align-baseline text-fg-muted">
                        {formatApiKeyDate(apiKey.expiresAt, locale, s.neverExpires)}
                      </td>
                      <td className="px-2 py-3 align-baseline text-fg-muted">
                        {formatApiKeyDate(apiKey.lastUsedAt, locale, s.neverUsed)}
                      </td>
                      <td className="px-2 py-2 text-right align-top">
                        <Button
                          variant="subtle"
                          size="icon"
                          aria-label={`${s.revoke.confirmButton}: ${displayKeyName(t, apiKey.name)}`}
                          className="text-danger enabled:hover:bg-danger-subtle"
                          onClick={() => setKeyToRevoke(apiKey)}
                        >
                          <Trash2 size={ICON_MD} />
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </SettingsSection>

      {createOpen && <CreateApiKeyDialog onClose={() => setCreateOpen(false)} />}

      {keyToRevoke && (
        <RevokeApiKeyDialog
          apiKey={keyToRevoke}
          isPending={revokeMutation.isPending}
          onConfirm={() => handleRevoke(keyToRevoke)}
          onCancel={() => setKeyToRevoke(null)}
        />
      )}
    </SettingsPage>
  );
}
