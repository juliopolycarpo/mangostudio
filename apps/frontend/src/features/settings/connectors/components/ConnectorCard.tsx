import type { Connector } from '@mangostudio/shared';
import { isDeprecatedProvider } from '@mangostudio/shared/provider-settings';
import { Link } from '@tanstack/react-router';
import {
  BarChart3,
  CheckCircle2,
  Database,
  FileCode,
  RefreshCw,
  Settings,
  ShieldCheck,
  Trash2,
  TriangleAlert,
  XCircle,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useI18n } from '@/hooks/use-i18n';
import { useChatGptOAuth } from '../hooks/use-chatgpt-oauth';
import { formatPlan } from '../lib/format-plan';
import { ChatGptPromoChip } from './ChatGptPromoChip';

interface ConnectorCardProps {
  connector: Connector;
  onConfigure: (connector: Connector) => void;
  onDelete: (connector: Connector) => void;
  onReauthenticated: (connector: Connector) => void | Promise<void>;
}

function isReadOnlySharedConnector(connector: Connector): boolean {
  return (
    connector.userId === null &&
    connector.source !== 'config-file' &&
    connector.source !== 'environment'
  );
}

export function ConnectorCard({
  connector: c,
  onConfigure,
  onDelete,
  onReauthenticated,
}: ConnectorCardProps) {
  const { t } = useI18n();
  const s = t.settings.connectors;
  const isReadOnlyShared = isReadOnlySharedConnector(c);
  const isChatGpt = c.provider === 'chatgpt';
  // Legacy, not broken. The card stays fully operable — models, delete, the
  // stored key — because the deprecation closes new setup and execution, not
  // the connector someone already owns.
  const isDeprecated = isDeprecatedProvider(c.provider);
  const chatGptOAuth = useChatGptOAuth({
    messages: s,
    onSuccess: async () => {
      await onReauthenticated(c);
    },
  });
  const planLabel = formatPlan(c.planType, s);

  const handleReauthenticate = () => {
    const popup = window.open('about:blank', '_blank');
    void chatGptOAuth.start({ name: c.name, connectorId: c.id, popup });
  };

  return (
    <div
      className={`bg-surface-container-lowest border rounded-2xl p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 sm:gap-4 ${
        c.needsReauth ? 'border-amber-500/30' : 'border-outline-variant/10'
      }`}
    >
      <div className="flex items-start gap-4">
        <div
          className={`p-2.5 rounded-xl ${
            c.needsReauth
              ? 'bg-amber-500/10 text-amber-200'
              : c.configured
                ? 'bg-primary/10 text-primary'
                : 'bg-error/10 text-error/80'
          }`}
        >
          {c.needsReauth ? (
            <TriangleAlert size={20} />
          ) : c.configured ? (
            <CheckCircle2 size={20} />
          ) : (
            <XCircle size={20} />
          )}
        </div>
        <div className="space-y-0.5">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="font-bold text-on-surface">{c.name}</h3>
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-surface-container-high text-on-surface-variant border border-outline-variant/20">
              {t.providers[c.provider]}
            </span>
            {isReadOnlyShared && (
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-200 border border-amber-500/20">
                {s.sharedConnector}
              </span>
            )}
            {isDeprecated && (
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-200 border border-amber-500/20">
                {s.deprecatedBadge}
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
            {isChatGpt ? (
              <>
                <span className="text-on-surface-variant/60">
                  {s.chatgptSignedInAs.replace(
                    '{account}',
                    c.accountLabel ?? c.maskedSuffix ?? s.chatgptAccountUnknown
                  )}
                </span>
                <span className="text-outline-variant">•</span>
                <span className="rounded-full border border-outline-variant/20 bg-surface-container-high px-2 py-0.5 text-[10px] text-on-surface-variant">
                  {s.chatgptPlanBadge.replace('{plan}', planLabel)}
                </span>
              </>
            ) : (
              <span className="font-mono text-on-surface-variant/60">
                {c.maskedSuffix ?? '****'}
              </span>
            )}
          </div>
          {isChatGpt && c.needsReauth ? (
            <p className="text-[11px] leading-relaxed text-amber-200/80">
              {s.chatgptReauthWarning}
            </p>
          ) : null}
          {isChatGpt && !c.needsReauth && c.usage?.promoMessage ? (
            <ChatGptPromoChip connectorId={c.id} message={c.usage.promoMessage} />
          ) : null}
          {chatGptOAuth.error ? (
            <p className="text-[11px] leading-relaxed text-error">{chatGptOAuth.error}</p>
          ) : null}
          {isDeprecated && (
            <p className="text-[11px] leading-relaxed text-amber-200/80">
              {s.deprecatedConnectorNote}
            </p>
          )}
          {isReadOnlyShared && (
            <p className="text-[10px] text-on-surface-variant/50">{s.managedExternally}</p>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2">
        {isChatGpt && !c.needsReauth ? (
          <Link
            to="/settings/metrics"
            className="inline-flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-bold text-on-surface/70 transition-all duration-200 hover:bg-surface-container-high hover:text-on-surface active:scale-95"
          >
            <BarChart3 size={15} />
            {s.chatgptSeeMetrics}
          </Link>
        ) : null}
        {isChatGpt && c.needsReauth ? (
          <Button
            variant="secondary"
            size="sm"
            onClick={handleReauthenticate}
            disabled={chatGptOAuth.isBusy}
          >
            {chatGptOAuth.isBusy ? (
              <>
                <RefreshCw size={15} className="animate-spin" />
                {s.chatgptReauthenticating}
              </>
            ) : (
              <>
                <RefreshCw size={15} />
                {s.chatgptReauthenticate}
              </>
            )}
          </Button>
        ) : null}
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
