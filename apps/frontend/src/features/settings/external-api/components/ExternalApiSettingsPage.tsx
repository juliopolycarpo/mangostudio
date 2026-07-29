/**
 * External API settings: enable toggle, key table, create, and revoke.
 */

import { API_KEY_MAX_PER_USER, type ApiKeySummary } from '@mangostudio/shared/api-keys';
import type { ExternalApiSettings } from '@mangostudio/shared/app-settings';
import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { useToast } from '@/components/ui/Toast';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';
import { resolveApiErrorMessage } from '@/lib/utils';
import {
  displayKeyName,
  formatApiKeyDate,
  formatKeyHint,
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
  const atCap = activeCount >= API_KEY_MAX_PER_USER;
  const enabled = settings.enabled;

  const handleRevoke = (apiKey: ApiKeySummary) => {
    revokeMutation.mutate(apiKey.id, {
      onSuccess: () => toast(s.revokeSuccess, 'success'),
      onError: (err) => toast(resolveApiErrorMessage(err, s.failedToRevoke), 'error'),
      onSettled: () => setKeyToRevoke(null),
    });
  };

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
        <p className="text-sm text-error">{s.loadError}</p>
        <Button variant="ghost" size="sm" onClick={() => void refetch()}>
          {t.common.retry}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Card variant="solid" className="space-y-3 p-4 sm:p-6">
        <h2 className="text-lg font-bold text-on-surface">{s.title}</h2>
        <p className="text-sm text-on-surface-variant/70">{s.description}</p>
      </Card>

      <Card variant="solid" className="space-y-5 p-4 sm:p-6">
        <SettingToggle
          label={s.enableLabel}
          description={s.enableDescription}
          checked={enabled}
          onChange={setExternalApiEnabled}
        />
        {!enabled && (
          <p className="rounded-xl border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-on-surface">
            {s.disabledNotice}
          </p>
        )}
      </Card>

      <Card variant="solid" className="space-y-4 p-4 sm:p-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1">
            <h3 className="text-base font-bold text-on-surface">{s.columns.key}</h3>
            {atCap && (
              <p className="text-xs text-on-surface-variant/60">
                {formatMessage(s.createDisabledAtCap, { max: String(API_KEY_MAX_PER_USER) })}
              </p>
            )}
          </div>
          <Button
            size="sm"
            disabled={atCap}
            title={
              atCap
                ? formatMessage(s.createDisabledAtCap, { max: String(API_KEY_MAX_PER_USER) })
                : undefined
            }
            onClick={() => setCreateOpen(true)}
          >
            <Plus size={14} />
            {s.createKey}
          </Button>
        </div>

        {keys.length === 0 ? (
          <p className="py-8 text-center text-sm text-on-surface-variant/60">{s.empty}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[40rem] border-collapse text-left text-sm">
              <thead>
                <tr className="border-b border-outline-variant/20 text-xs uppercase tracking-wide text-on-surface-variant/60">
                  <th className="px-2 py-2 font-semibold">{s.columns.name}</th>
                  <th className="px-2 py-2 font-semibold">{s.columns.scope}</th>
                  <th className="px-2 py-2 font-semibold">{s.columns.key}</th>
                  <th className="px-2 py-2 font-semibold">{s.columns.created}</th>
                  <th className="px-2 py-2 font-semibold">{s.columns.expires}</th>
                  <th className="px-2 py-2 font-semibold">{s.columns.lastUsed}</th>
                  <th className="px-2 py-2 font-semibold">
                    <span className="sr-only">{s.columns.actions}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {keys.map((apiKey) => {
                  const expired = isKeyExpired(apiKey);
                  const inactive = !enabled || expired;
                  return (
                    <tr
                      key={apiKey.id}
                      className={`border-b border-outline-variant/10 ${
                        inactive ? 'opacity-60' : ''
                      }`}
                    >
                      <td className="px-2 py-3 align-top">
                        <div className="space-y-1">
                          <span className="font-medium text-on-surface">
                            {displayKeyName(t, apiKey.name)}
                          </span>
                          {inactive && (
                            <span className="block text-xs text-on-surface-variant/70">
                              {!enabled ? s.inactive : s.expired}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-2 py-3 align-top">
                        <span className="inline-flex rounded-full bg-surface-container-high px-2 py-0.5 text-xs font-medium text-on-surface-variant">
                          {scopeLabel(t, apiKey.scope)}
                        </span>
                      </td>
                      <td className="px-2 py-3 align-top font-mono text-xs text-on-surface-variant">
                        {formatKeyHint(apiKey.start)}
                      </td>
                      <td className="px-2 py-3 align-top text-on-surface-variant">
                        {formatApiKeyDate(apiKey.createdAt, locale, '—')}
                      </td>
                      <td className="px-2 py-3 align-top text-on-surface-variant">
                        {formatApiKeyDate(apiKey.expiresAt, locale, s.neverExpires)}
                      </td>
                      <td className="px-2 py-3 align-top text-on-surface-variant">
                        {formatApiKeyDate(apiKey.lastUsedAt, locale, s.neverUsed)}
                      </td>
                      <td className="px-2 py-3 align-top text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={`${s.revoke.confirmButton}: ${displayKeyName(t, apiKey.name)}`}
                          onClick={() => setKeyToRevoke(apiKey)}
                        >
                          <Trash2 size={14} />
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {createOpen && <CreateApiKeyDialog onClose={() => setCreateOpen(false)} />}

      {keyToRevoke && (
        <RevokeApiKeyDialog
          apiKey={keyToRevoke}
          isPending={revokeMutation.isPending}
          onConfirm={() => handleRevoke(keyToRevoke)}
          onCancel={() => setKeyToRevoke(null)}
        />
      )}
    </div>
  );
}

function SettingToggle({
  label,
  description,
  checked,
  onChange,
}: {
  readonly label: string;
  readonly description: string;
  readonly checked: boolean;
  readonly onChange: (value: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-4">
      <span className="space-y-1">
        <span className="block text-sm font-semibold text-on-surface">{label}</span>
        <span className="block text-sm text-on-surface-variant/60">{description}</span>
      </span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        aria-label={label}
        className="mt-1 h-4 w-4 shrink-0 rounded border-outline-variant/30 accent-primary"
      />
    </label>
  );
}
