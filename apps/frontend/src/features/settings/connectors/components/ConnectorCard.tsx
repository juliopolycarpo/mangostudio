import type { Connector } from '@mangostudio/shared/connectors';
import { isDeprecatedProvider } from '@mangostudio/shared/provider-settings';
import { Link } from '@tanstack/react-router';
import {
  BarChart3,
  CircleCheck,
  CircleX,
  Database,
  FileCode,
  ListChecks,
  RefreshCw,
  ShieldCheck,
  Trash2,
  TriangleAlert,
} from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Button, buttonClassName } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { Card } from '@/components/ui/Card';
import { useI18n } from '@/hooks/use-i18n';
import { ICON_MD, ICON_SM } from '@/lib/icon-sizes';
import { cn } from '@/lib/utils';
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

/**
 * The `·` between meta items. Below `sm` the item after it can start a line of
 * its own, and a dot left at the end of the line above would point at nothing,
 * so there `collapsible` drops it and the line break does the separating.
 */
function MetaDot({ collapsible = false }: { collapsible?: boolean }) {
  return (
    <span aria-hidden="true" className={collapsible ? 'hidden sm:inline' : undefined}>
      ·
    </span>
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
      {/* One row at every width: the actions belong to this connector, so they
          stay on its right edge instead of dropping onto a row of their own. */}
      <div className="flex items-start justify-between gap-2 sm:gap-4">
        <div className="min-w-0 flex-1 space-y-1">
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
            <MetaDot />
            <span className="inline-flex items-center gap-1">
              {c.source === 'bun-secrets' && <ShieldCheck size={ICON_SM} />}
              {c.source === 'config-file' && <FileCode size={ICON_SM} />}
              {c.source === 'environment' && <Database size={ICON_SM} />}
              {sourceLabel}
            </span>
            <MetaDot collapsible />
            {/* Its own wrap unit below `sm`: status and source stay on one line and
                the credential identity takes the next, so the line never breaks
                mid-item. */}
            {isChatGpt ? (
              <span className="inline-flex basis-full flex-wrap items-center gap-x-2 gap-y-1 sm:basis-auto">
                <span>
                  {s.chatgptSignedInAs.replace(
                    '{account}',
                    c.accountLabel ?? c.maskedSuffix ?? s.chatgptAccountUnknown
                  )}
                </span>
                <MetaDot collapsible />
                <Badge>{s.chatgptPlanBadge.replace('{plan}', planLabel)}</Badge>
              </span>
            ) : (
              <span className="basis-full font-mono sm:basis-auto">{c.maskedSuffix ?? '****'}</span>
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {isChatGpt && !c.needsReauth ? (
            // Icon-only below `sm`: with its label this link and two buttons would
            // leave the name and badges about a third of the card.
            <Link
              to="/settings/metrics"
              aria-label={s.chatgptSeeMetrics}
              className={cn(buttonClassName('subtle', 'icon'), 'sm:w-auto sm:px-3')}
            >
              <BarChart3 size={ICON_MD} />
              <span className="hidden sm:inline">{s.chatgptSeeMetrics}</span>
            </Link>
          ) : null}
          {/* The card's main operation is choosing its models, so it is named: a bare
              gear reads as the connector's own settings. Icon-only below `sm`, as
              the metrics link is, and the trash stays the only unlabelled action. */}
          <Button
            variant="secondary"
            size="sm"
            onClick={() => onConfigure(c)}
            title={s.configureModels}
            aria-label={s.configureModels}
            className="max-sm:w-7 max-sm:px-0"
          >
            <ListChecks size={ICON_SM} aria-hidden="true" />
            <span className="hidden sm:inline">{s.modelsButton}</span>
          </Button>
          <Button
            variant="subtle-danger"
            size="icon"
            onClick={() => onDelete(c)}
            title={isReadOnlyShared ? s.sharedDeleteBlocked : s.deleteConnector}
            aria-label={s.deleteConnector}
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
                  <RefreshCw size={ICON_SM} />
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
