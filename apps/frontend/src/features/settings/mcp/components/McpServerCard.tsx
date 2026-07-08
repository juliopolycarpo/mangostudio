/**
 * Card for one MCP server: identity, transport chip, last-known status badge,
 * explicit test-connection action with inline result, and expandable tools.
 */

import type { McpServer, McpServerStatus, TestMcpServerResponse } from '@mangostudio/shared/mcp';
import { ChevronDown, ChevronRight, Pencil, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Toggle } from '@/components/ui/Toggle';
import { useI18n } from '@/hooks/use-i18n';
import { useTestMcpServer, useUpdateMcpServer } from '../hooks/use-mcp-servers';
import { McpServerResources } from './McpServerResources';
import { McpServerTools } from './McpServerTools';

interface McpServerCardProps {
  server: McpServer;
  onEdit: (server: McpServer) => void;
  onDelete: (server: McpServer) => void;
}

const statusStyles: Record<McpServerStatus, string> = {
  connected: 'bg-primary/10 text-primary',
  connecting: 'bg-on-surface-variant/10 text-on-surface-variant',
  error: 'bg-error/10 text-error',
  disconnected: 'bg-on-surface-variant/10 text-on-surface-variant/70',
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

  const handleTest = () => {
    setTestResult(null);
    setTestError(null);
    testMutation.mutate(server.id, {
      onSuccess: (result) => setTestResult(result),
      onError: (error) => setTestError(error.message),
    });
  };

  const handleToggleEnabled = (enabled: boolean) => {
    updateMutation.mutate({ id: server.id, body: { enabled } });
  };

  return (
    <Card variant="solid" className="space-y-3 p-4 sm:p-6">
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="text-sm font-bold text-on-surface">{server.name}</h4>
            <span className="rounded-full bg-surface-container-highest px-2 py-0.5 text-xs text-on-surface-variant">
              {s.transports[server.transport]}
            </span>
            <span
              className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusStyles[server.status]}`}
              title={server.status === 'error' ? server.statusError : undefined}
            >
              {s.status[server.status]}
            </span>
          </div>
          <p className="text-xs text-on-surface-variant/70 break-all">
            {server.transport === 'stdio'
              ? [server.command, ...server.args].filter(Boolean).join(' ')
              : server.url}
          </p>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <Toggle
            id={`mcp-server-enabled-${server.id}`}
            label={server.enabled ? s.enabledLabel : s.disabledLabel}
            checked={server.enabled}
            disabled={updateMutation.isPending}
            onChange={(e) => handleToggleEnabled(e.target.checked)}
          />
          <Button
            variant="ghost"
            size="sm"
            aria-label={s.editButton}
            onClick={() => onEdit(server)}
          >
            <Pencil size={14} />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            aria-label={s.deleteServer}
            className="text-error hover:text-error"
            onClick={() => onDelete(server)}
          >
            <Trash2 size={14} />
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button variant="secondary" size="sm" loading={testMutation.isPending} onClick={handleTest}>
          {testMutation.isPending ? s.testingButton : s.testButton}
        </Button>
        {testResult &&
          (testResult.ok ? (
            <span className="text-xs text-primary" role="status">
              {s.testSuccess.replace('{count}', String(testResult.tools?.length ?? 0))}
            </span>
          ) : (
            <span className="text-xs text-error" role="status">
              {testResult.error ?? s.testFailed}
            </span>
          ))}
        {testError && (
          <span className="text-xs text-error" role="status">
            {testError}
          </span>
        )}
      </div>

      <button
        type="button"
        onClick={() => setToolsOpen((open) => !open)}
        className="flex items-center gap-1.5 text-xs font-medium text-on-surface-variant hover:text-on-surface transition-colors"
        aria-expanded={toolsOpen}
      >
        {toolsOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        {toolsOpen ? s.hideTools : s.showTools}
      </button>

      {toolsOpen && (
        <div className="border-t border-outline-variant/10">
          <McpServerTools server={server} />
        </div>
      )}

      <button
        type="button"
        onClick={() => setResourcesOpen((open) => !open)}
        className="flex items-center gap-1.5 text-xs font-medium text-on-surface-variant hover:text-on-surface transition-colors"
        aria-expanded={resourcesOpen}
      >
        {resourcesOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        {resourcesOpen ? s.resources.hide : s.resources.show}
      </button>

      {resourcesOpen && (
        <div className="border-t border-outline-variant/10">
          <McpServerResources server={server} />
        </div>
      )}
    </Card>
  );
}
