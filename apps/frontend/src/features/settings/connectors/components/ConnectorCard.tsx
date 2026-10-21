import type { Connector } from '@mangostudio/shared/connectors';
import { isDeprecatedProvider } from '@mangostudio/shared/provider-settings';
import { Link } from '@tanstack/react-router';
import {
  BarChart3,
  CircleCheck,
  CircleX,
  Database,
  FileCode,
  RefreshCw,
  Settings,
  ShieldCheck,
  Trash2,
  TriangleAlert,
} from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { Card } from '@/components/ui/Card';
import { useI18n } from '@/hooks/use-i18n';
import { ICON_MD, ICON_SM } from '@/lib/icon-sizes';
import { useChatGptOAuth } from '../hooks/use-chatgpt-oauth';
import { formatPlan } from '../lib/format-plan';
import { isReadOnlySharedConnector } from '../lib/shared-connector';
import { ChatGptPromoChip } from './ChatGptPromoChip';

interface ConnectorCardProps {
  connector: Connector;
  onConfigure: (connector: Connector) => void;
  onDelete: (connector: Connector) => void;
  onReauthenticated: (connector: Connector) => void | Promise<void>;
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

  const status = c.needsReauth
    ? { Icon: TriangleAlert, tone: 'text-warning', label: s.statusNeedsSignIn }
    : c.configured
      ? { Icon: CircleCheck, tone: 'text-success', label: s.statusConnected }
      : { Icon: CircleX, tone: 'text-danger', label: s.statusNotConfigured };
  const sourceLabel = {
    'bun-secrets': s.sources.bunSecrets,
    'config-file': s.sources.configFile,
    environment: s.sources.envFile,
    none: s.sources.none,
  }[c.source];

  return (
    <Card padded={false} className="space-y-3 p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate text-sm font-semibold text-fg">{c.name}</h3>
            <Badge>{t.providers[c.provider]}</Badge>
            {isReadOnlyShared && <Badge>{s.sharedConnector}</Badge>}
            {isDeprecated && <Badge variant="warning">{s.deprecatedBadge}</Badge>}
          </div>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-fg-muted">
            {/* The glyph carries the tone and the word names it: colour alone is
                  never the signal. */}
            <span className="inline-flex items-center gap-1">
              <status.Icon size={ICON_SM} className={status.tone} />
              {status.label}
            </span>
            <span aria-hidden="true">·</span>
            <span className="inline-flex items-center gap-1">
              {c.source === 'bun-secrets' && <ShieldCheck size={ICON_SM} />}
              {c.source === 'config-file' && <FileCode size={ICON_SM} />}
              {c.source === 'environment' && <Database size={ICON_SM} />}
              {sourceLabel}
            </span>
            <span aria-hidden="true">·</span>
            {isChatGpt ? (
              <>
                <span>
                  {s.chatgptSignedInAs.replace(
                    '{account}',
                    c.accountLabel ?? c.maskedSuffix ?? s.chatgptAccountUnknown
                  )}
                </span>
                <span aria-hidden="true">·</span>
                <Badge>{s.chatgptPlanBadge.replace('{plan}', planLabel)}</Badge>
              </>
            ) : (
              <span className="font-mono">{c.maskedSuffix ?? '****'}</span>
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {isChatGpt && !c.needsReauth ? (
            <Link
              to="/settings/metrics"
              className="inline-flex h-7 items-center gap-1.5 rounded-sm px-2 text-xs font-medium text-fg transition-colors hover:bg-fill-hover active:bg-fill-pressed"
            >
              <BarChart3 size={ICON_MD} />
              {s.chatgptSeeMetrics}
            </Link>
          ) : null}
          <Button
            variant="subtle"
            size="icon"
            onClick={() => onConfigure(c)}
            title={s.configureModels}
            aria-label={s.configureModels}
          >
            <Settings size={ICON_MD} />
          </Button>
          <Button
            variant="subtle"
            size="icon"
            onClick={() => onDelete(c)}
            title={isReadOnlyShared ? s.sharedDeleteBlocked : s.deleteConnector}
            aria-label={s.deleteConnector}
            className="text-danger enabled:hover:bg-danger-subtle"
            disabled={isReadOnlyShared}
          >
            <Trash2 size={ICON_MD} />
          </Button>
        </div>
      </div>

      {isChatGpt && c.needsReauth ? (
        <Callout
          tone="warning"
          action={
            <Button
              variant="secondary"
              size="sm"
              onClick={handleReauthenticate}
              loading={chatGptOAuth.isBusy}
            >
              {chatGptOAuth.isBusy ? (
                s.chatgptReauthenticating
              ) : (
                <>
                  <RefreshCw size={ICON_MD} />
                  {s.chatgptReauthenticate}
                </>
              )}
            </Button>
          }
        >
          {s.chatgptReauthWarning}
        </Callout>
      ) : null}
      {isChatGpt && !c.needsReauth && c.usage?.promoMessage ? (
        <ChatGptPromoChip connectorId={c.id} message={c.usage.promoMessage} />
      ) : null}
      {chatGptOAuth.error ? <Callout tone="danger">{chatGptOAuth.error}</Callout> : null}
      {isDeprecated && <Callout tone="warning">{s.deprecatedConnectorNote}</Callout>}
      {isReadOnlyShared && <p className="text-xs text-fg-subtle">{s.managedExternally}</p>}
    </Card>
  );
}
