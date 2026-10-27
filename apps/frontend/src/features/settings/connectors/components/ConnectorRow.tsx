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
import { useI18n } from '@/hooks/use-i18n';
import { ICON_MD, ICON_SM } from '@/lib/icon-sizes';

import { useChatGptOAuth } from '../hooks/use-chatgpt-oauth';
import { formatPlan } from '../lib/format-plan';
import { isReadOnlySharedConnector } from '../lib/shared-connector';
import { ChatGptPromoChip } from './ChatGptPromoChip';

interface ConnectorRowProps {
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

/**
 * One connector as a row of the page's connector card: the same `px-4 py-3`
 * inset as a `SettingsRow`, with the `stroke` between rows drawn by the
 * `SettingsSection` that holds them. Notes about this connector (sign in again,
 * deprecated) stay inside its row, under the line they qualify.
 */
export function ConnectorRow({
  connector: c,
  onConfigure,
  onDelete,
  onReauthenticated,
}: ConnectorRowProps) {
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
    <div className="space-y-3 px-4 py-3">
      {/* Side by side from `sm`. Below it the actions take a row under the
          metadata, so "Models" keeps its word instead of shrinking to a bare
          glyph beside a trash can, and the name and badges keep the full width. */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
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

        <div className="flex items-center gap-1 sm:shrink-0">
          {isChatGpt && !c.needsReauth ? (
            <Link to="/settings/metrics" className={buttonClassName('subtle', 'sm')}>
              <BarChart3 size={ICON_SM} aria-hidden="true" />
              {s.chatgptSeeMetrics}
            </Link>
          ) : null}
          {/* The card's main operation is choosing its models, so it is named: a bare
              gear reads as the connector's own settings. */}
          <Button
            variant="secondary"
            size="sm"
            onClick={() => onConfigure(c)}
            title={s.configureModels}
            aria-label={s.configureModels}
          >
            <ListChecks size={ICON_SM} aria-hidden="true" />
            {s.modelsButton}
          </Button>
          <Button
            variant="subtle-danger"
            size="icon"
            onClick={() => onDelete(c)}
            title={isReadOnlyShared ? s.sharedDeleteBlocked : s.deleteConnector}
            aria-label={s.deleteConnector}
            disabled={isReadOnlyShared}
            className="max-sm:ml-auto"
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
    </div>
  );
}
