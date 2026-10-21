/**
 * Card for one MCP server: identity, transport chip, hosting environment,
 * last-known status badge, explicit test-connection action with inline result,
 * and expandable tools.
 */

import type { McpServer, McpServerStatus, TestMcpServerResponse } from '@mangostudio/shared/mcp';
import { ChevronDown, ChevronRight, Pencil, Server, Trash2 } from 'lucide-react';
import { type ComponentProps, useState } from 'react';
import { StatusNote } from '@/components/settings/StatusNote';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Toggle } from '@/components/ui/Toggle';
import { ToolAvatar } from '@/components/ui/ToolAvatar';
import { ToolIdentityMenu } from '@/features/environments/identity/ToolIdentityMenu';
import { useToolIdentities } from '@/features/environments/identity/use-tool-identities';
import { useEnvironmentEntitiesQuery } from '@/features/environments/queries';
import { useI18n } from '@/hooks/use-i18n';
import { ICON_MD, ICON_SM } from '@/lib/icon-sizes';
import { resolveApiErrorMessage } from '@/lib/utils';
import { useTestMcpServer, useUpdateMcpServer } from '../hooks/use-mcp-servers';
import { McpServerResources } from './McpServerResources';
import { McpServerTools } from './McpServerTools';

interface McpServerCardProps {
  server: McpServer;
  onEdit: (server: McpServer) => void;
  onDelete: (server: McpServer) => void;
}

const STATUS_VARIANT: Record<
  McpServerStatus,
  NonNullable<ComponentProps<typeof Badge>['variant']>
> = {
  connected: 'success',
  connecting: 'neutral',
  error: 'error',
  disconnected: 'neutral',
};

export function McpServerCard({ server, onEdit, onDelete }: McpServerCardProps) {
  const { t } = useI18n();
  const s = t.settings.mcp;

  const [toolsOpen, setToolsOpen] = useState(false);
  const [resourcesOpen, setResourcesOpen] = useState(false);
  const [testResult, setTestResult] = useState<TestMcpServerResponse | null>(null);
  const [testError, setTestError] = useState<string | null>(null);

  const testMutation = useTestMcpServer();
  const updateMutation = useUpdateMcpServer();
  // The server's configured name is the default here; the registry only decides
  // what this card and every other surface *call* it.
  const { resolve } = useToolIdentities();
  const identity = resolve('mcp', server.slug, server.name);
  // The id is the fallback rather than a blank: an environment that was
  // removed still tells the user which one this server is waiting for.
  const environments = useEnvironmentEntitiesQuery();
  const environmentName =
    environments.data?.find((environment) => environment.id === server.environmentId)?.name ??
    server.environmentId;

  const handleTest = () => {
    setTestResult(null);
    setTestError(null);
    testMutation.mutate(server.id, {
      onSuccess: (result) => setTestResult(result),
      onError: (error) => setTestError(resolveApiErrorMessage(error, s.testFailed)),
    });
  };

  const handleToggleEnabled = (enabled: boolean) => {
    updateMutation.mutate({ id: server.id, body: { enabled } });
  };

  // One line for whichever answer the last test produced; a new test clears both.
  const testOutcome: { ok: boolean; message: string } | null = testError
    ? { ok: false, message: testError }
    : testResult
      ? testResult.ok
        ? {
            ok: true,
            message: s.testSuccess.replace('{count}', String(testResult.tools?.length ?? 0)),
          }
        : { ok: false, message: testResult.error ?? s.testFailed }
      : null;

  return (
    <Card className="space-y-3">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <ToolAvatar
              subjectKey={identity.subjectKey}
              monogram={identity.monogram}
              name={identity.name}
              image={identity.image}
              size="sm"
            />
            <h3 className="text-sm font-semibold text-fg">{identity.name}</h3>
            <Badge>{s.transports[server.transport]}</Badge>
            <Badge title={`${s.environmentLabel}: ${environmentName}`}>
              <Server size={ICON_SM} aria-hidden="true" />
              {environmentName}
            </Badge>
            <Badge
              variant={STATUS_VARIANT[server.status]}
              title={server.status === 'error' ? server.statusError : undefined}
            >
              {s.status[server.status]}
            </Badge>
          </div>
          <p className="break-all font-mono text-xs text-fg-muted">
            {server.transport === 'stdio'
              ? [server.command, ...server.args].filter(Boolean).join(' ')
              : server.url}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <Toggle
            id={`mcp-server-enabled-${server.id}`}
            label={server.enabled ? s.enabledLabel : s.disabledLabel}
            checked={server.enabled}
            disabled={updateMutation.isPending}
            onChange={(e) => handleToggleEnabled(e.target.checked)}
          />
          <Button
            variant="subtle"
            size="icon"
            className="size-7"
            aria-label={s.editButton}
            onClick={() => onEdit(server)}
          >
            <Pencil size={ICON_MD} />
          </Button>
          <ToolIdentityMenu identity={identity} defaultName={server.name} />
          <Button
            variant="subtle"
            size="icon"
            className="size-7 text-danger"
            aria-label={s.deleteServer}
            onClick={() => onDelete(server)}
          >
            <Trash2 size={ICON_MD} />
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button variant="secondary" size="sm" loading={testMutation.isPending} onClick={handleTest}>
          {testMutation.isPending ? s.testingButton : s.testButton}
        </Button>
        {testOutcome && (
          <StatusNote tone={testOutcome.ok ? 'success' : 'danger'} role="status">
            {testOutcome.message}
          </StatusNote>
        )}
      </div>

      <div className="flex flex-wrap gap-1 border-t border-stroke pt-3">
        <Button
          variant="subtle"
          size="sm"
          aria-expanded={toolsOpen}
          onClick={() => setToolsOpen((open) => !open)}
        >
          {toolsOpen ? <ChevronDown size={ICON_SM} /> : <ChevronRight size={ICON_SM} />}
          {toolsOpen ? s.hideTools : s.showTools}
        </Button>
        <Button
          variant="subtle"
          size="sm"
          aria-expanded={resourcesOpen}
          onClick={() => setResourcesOpen((open) => !open)}
        >
          {resourcesOpen ? <ChevronDown size={ICON_SM} /> : <ChevronRight size={ICON_SM} />}
          {resourcesOpen ? s.resources.hide : s.resources.show}
        </Button>
      </div>

      {toolsOpen && <McpServerTools server={server} />}
      {resourcesOpen && <McpServerResources server={server} />}
    </Card>
  );
}
