import type { Connector } from '@mangostudio/shared';
import { KeyRound } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Select } from '@/components/ui/Select';
import { useI18n } from '@/hooks/use-i18n';
import { USAGE_ALERT_THRESHOLDS, type UsageAlertThreshold } from '../lib/usage-alerts';
import { ConnectorCard } from './ConnectorCard';

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

  return (
    <Card variant="solid" className="p-4 sm:p-6 space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h2 className="text-xs uppercase tracking-widest font-bold text-on-surface-variant/80 font-label">
          {s.title}
        </h2>
        <div className="flex items-center gap-3">
          {hasChatGpt && (
            <div className="flex items-center gap-1.5 text-[10px] text-on-surface-variant/60">
              {s.chatgptAlertThresholdLabel}
              <Select
                value={alertThreshold === null ? 'off' : String(alertThreshold)}
                onChange={(value) =>
                  onAlertThresholdChange(value === 'off' ? null : (Number(value) as 75 | 90))
                }
                ariaLabel={s.chatgptAlertThresholdLabel}
                className="w-32"
                options={[
                  { value: 'off', label: s.chatgptAlertThresholdOff },
                  ...USAGE_ALERT_THRESHOLDS.map((percent) => ({
                    value: String(percent),
                    label: s.chatgptAlertThresholdOption.replace('{percent}', String(percent)),
                  })),
                ]}
              />
            </div>
          )}
          <Button variant="secondary" size="sm" onClick={onAddConnector} className="gap-1.5">
            <span className="text-base leading-none">+</span>
            {s.addButton}
          </Button>
        </div>
      </div>

      {connectors.length === 0 ? (
        <div className="bg-surface-container-lowest border border-dashed border-outline-variant/30 rounded-2xl p-8 text-center space-y-4">
          <div className="p-4 bg-surface-container-high rounded-full w-fit mx-auto text-on-surface-variant/40">
            <KeyRound size={32} />
          </div>
          <div className="space-y-1">
            <p className="text-on-surface font-bold">{s.emptyTitle}</p>
            <p className="text-sm text-on-surface-variant/60">{s.emptyDescription}</p>
          </div>
          <Button variant="primary" onClick={onAddConnector}>
            {s.addConnectorButton}
          </Button>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3">
          {connectors.map((c) => (
            <ConnectorCard
              key={c.id}
              connector={c}
              onConfigure={onConfigureConnector}
              onDelete={onDeleteConnector}
              onReauthenticated={onReauthenticatedConnector}
            />
          ))}
        </div>
      )}
    </Card>
  );
}
