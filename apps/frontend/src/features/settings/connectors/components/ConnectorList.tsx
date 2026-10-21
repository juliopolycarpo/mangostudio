import type { Connector } from '@mangostudio/shared/connectors';
import { KeyRound, Plus } from 'lucide-react';
import { SettingsPage } from '@/components/settings/SettingsPage';
import { SettingsRow } from '@/components/settings/SettingsRow';
import { SettingsSection } from '@/components/settings/SettingsSection';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Select } from '@/components/ui/Select';
import { useI18n } from '@/hooks/use-i18n';
import { ICON_LG, ICON_SM } from '@/lib/icon-sizes';
import { USAGE_ALERT_THRESHOLDS, type UsageAlertThreshold } from '../lib/usage-alerts';
import { ConnectorRow } from './ConnectorRow';

interface ConnectorListProps {
  connectors: Connector[];
  alertThreshold: UsageAlertThreshold;
  onAlertThresholdChange: (threshold: UsageAlertThreshold) => void;
  onAddConnector: () => void;
  onConfigureConnector: (connector: Connector) => void;
  onDeleteConnector: (connector: Connector) => void;
  onReauthenticatedConnector: (connector: Connector) => void | Promise<void>;
}

export function ConnectorList({
  connectors,
  alertThreshold,
  onAlertThresholdChange,
  onAddConnector,
  onConfigureConnector,
  onDeleteConnector,
  onReauthenticatedConnector,
}: ConnectorListProps) {
  const { t } = useI18n();
  const s = t.settings.connectors;
  const hasChatGpt = connectors.some((c) => c.provider === 'chatgpt');
  // The empty state carries its own Add, so the header's is not drawn beside it.
  const addAction =
    connectors.length === 0 ? undefined : (
      <Button variant="secondary" size="sm" onClick={onAddConnector}>
        <Plus size={ICON_SM} />
        {s.addButton}
      </Button>
    );

  return (
    <SettingsPage title={s.title} description={s.description} actions={addAction}>
      {connectors.length === 0 ? (
        <Card padded={false}>
          <EmptyState
            icon={<KeyRound size={ICON_LG} />}
            title={s.emptyTitle}
            hint={s.emptyDescription}
            action={
              <Button variant="secondary" size="sm" onClick={onAddConnector}>
                <Plus size={ICON_SM} />
                {s.addConnectorButton}
              </Button>
            }
          />
        </Card>
      ) : (
        <SettingsSection>
          {connectors.map((c) => (
            <ConnectorRow
              key={c.id}
              connector={c}
              onConfigure={onConfigureConnector}
              onDelete={onDeleteConnector}
              onReauthenticated={onReauthenticatedConnector}
            />
          ))}
        </SettingsSection>
      )}

      {hasChatGpt && (
        <SettingsSection>
          <SettingsRow label={s.chatgptAlertThresholdLabel} layout="field">
            <Select
              value={alertThreshold === null ? 'off' : String(alertThreshold)}
              onChange={(value) =>
                onAlertThresholdChange(value === 'off' ? null : (Number(value) as 75 | 90))
              }
              ariaLabel={s.chatgptAlertThresholdLabel}
              options={[
                { value: 'off', label: s.chatgptAlertThresholdOff },
                ...USAGE_ALERT_THRESHOLDS.map((percent) => ({
                  value: String(percent),
                  label: s.chatgptAlertThresholdOption.replace('{percent}', String(percent)),
                })),
              ]}
            />
          </SettingsRow>
        </SettingsSection>
      )}
    </SettingsPage>
  );
}
