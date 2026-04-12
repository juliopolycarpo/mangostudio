import type { Connector } from '@mangostudio/shared';
import { KeyRound } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { useI18n } from '@/hooks/use-i18n';
import { ConnectorCard } from './ConnectorCard';

interface ConnectorListProps {
  connectors: Connector[];
  onAddConnector: () => void;
  onConfigureConnector: (connector: Connector) => void;
  onDeleteConnector: (connector: Connector) => void;
}

export function ConnectorList({
  connectors,
  onAddConnector,
  onConfigureConnector,
  onDeleteConnector,
}: ConnectorListProps) {
  const { t } = useI18n();
  const s = t.settings.connectors;

  return (
    <Card variant="solid" className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xs uppercase tracking-widest font-bold text-on-surface-variant/80 font-label">
          {s.title}
        </h2>
        <Button variant="secondary" size="sm" onClick={onAddConnector} className="gap-1.5">
          <span className="text-base leading-none">+</span>
          {s.addButton}
        </Button>
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
            />
          ))}
        </div>
      )}
    </Card>
  );
}
