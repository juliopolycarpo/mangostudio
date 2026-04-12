import type { Connector } from '@mangostudio/shared';
import {
  Settings,
  Trash2,
  ShieldCheck,
  FileCode,
  Database,
  CheckCircle2,
  XCircle,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useI18n } from '@/hooks/use-i18n';

interface ConnectorCardProps {
  connector: Connector;
  onConfigure: (connector: Connector) => void;
  onDelete: (connector: Connector) => void;
}

function isReadOnlySharedConnector(connector: Connector): boolean {
  return (
    connector.userId === null &&
    connector.source !== 'config-file' &&
    connector.source !== 'environment'
  );
}

export function ConnectorCard({ connector: c, onConfigure, onDelete }: ConnectorCardProps) {
  const { t } = useI18n();
  const s = t.settings.connectors;
  const isReadOnlyShared = isReadOnlySharedConnector(c);

  return (
    <div className="bg-surface-container-lowest border border-outline-variant/10 rounded-2xl p-4 flex items-center justify-between gap-4">
      <div className="flex items-center gap-4">
        <div
          className={`p-2.5 rounded-xl ${c.configured ? 'bg-primary/10 text-primary' : 'bg-error/10 text-error/80'}`}
        >
          {c.configured ? <CheckCircle2 size={20} /> : <XCircle size={20} />}
        </div>
        <div className="space-y-0.5">
          <div className="flex items-center gap-2">
            <h3 className="font-bold text-on-surface">{c.name}</h3>
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-surface-container-high text-on-surface-variant border border-outline-variant/20">
              {t.providers[c.provider]}
            </span>
            {isReadOnlyShared && (
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-200 border border-amber-500/20">
                {s.sharedConnector}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 text-xs">
            <span className="flex items-center gap-1 text-on-surface-variant/60">
              {c.source === 'bun-secrets' && <ShieldCheck size={12} />}
              {c.source === 'config-file' && <FileCode size={12} />}
              {c.source === 'environment' && <Database size={12} />}
              {c.source.replace('-', ' ')}
            </span>
            <span className="text-outline-variant">•</span>
            <span className="font-mono text-on-surface-variant/60">{c.maskedSuffix ?? '****'}</span>
          </div>
          {isReadOnlyShared && (
            <p className="text-[10px] text-on-surface-variant/50">{s.managedExternally}</p>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onConfigure(c)}
          title={s.configureModels}
          className="p-2"
        >
          <Settings size={18} />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onDelete(c)}
          title={isReadOnlyShared ? s.sharedDeleteBlocked : s.deleteConnector}
          className="p-2 text-error/70 hover:text-error hover:bg-error/10 disabled:opacity-40 disabled:hover:bg-transparent"
          disabled={isReadOnlyShared}
        >
          <Trash2 size={18} />
        </Button>
      </div>
    </div>
  );
}
