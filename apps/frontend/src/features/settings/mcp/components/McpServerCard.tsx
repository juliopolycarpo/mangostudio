/**
 * Card for one MCP server: identity with its last-known status, transport and
 * hosting environment as quiet metadata, then the row's actions on the right —
 * Test and the enabled switch inline, and one overflow menu holding Edit, the
 * rename pair and Delete — and expandable tools and resources. Under the command,
 * a failure is a danger `Callout` that says which server could not be reached and
 * what to do, with the raw transport error as its detail; a passing test is one
 * quiet `StatusNote`. The failure is the last test's answer, or until there is
 * one the cause the server last reported.
 */

import type { McpServer, McpServerStatus, TestMcpServerResponse } from '@mangostudio/shared/mcp';
import { ChevronDown, ChevronRight, Pencil, RefreshCw, Server, Trash2 } from 'lucide-react';
import { type ComponentProps, useState } from 'react';

import { StatusNote } from '@/components/settings/StatusNote';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { Card } from '@/components/ui/Card';
import { MenuItem } from '@/components/ui/Menu';
import { StatusDot, type StatusDotTone } from '@/components/ui/StatusDot';
import { Toggle } from '@/components/ui/Toggle';
import { ToolAvatar } from '@/components/ui/ToolAvatar';
import { ToolIdentityMenu } from '@/features/environments/identity/ToolIdentityMenu';
import { useToolIdentities } from '@/features/environments/identity/use-tool-identities';
import { useEnvironmentEntitiesQuery } from '@/features/environments/queries';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';
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

interface StatusPresentation {
  readonly variant: NonNullable<ComponentProps<typeof Badge>['variant']>;
  readonly tone: StatusDotTone;
  /** Overrides the tone's fill where the badge's colour has no dot tone of its own. */
  readonly dotClassName?: string;
}

/**
 * Only the status badge wears a dot, so it never reads as the transport or
 * environment badge beside it. `connecting` is `info` rather than `neutral` for
 * the same reason, and it gets no pulse: the status is the last known state, not
 * work in flight. `StatusDot` has no `info` tone, so the dot takes the badge's
 * own colour through `dotClassName` and never reads as a second state.
 */
const STATUS_PRESENTATION: Record<McpServerStatus, StatusPresentation> = {
  connected: { variant: 'success', tone: 'success' },
  connecting: { variant: 'info', tone: 'neutral', dotClassName: 'bg-info' },
  error: { variant: 'error', tone: 'error' },
  disconnected: { variant: 'neutral', tone: 'neutral' },
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
  // A fresh test answer replaces the stored cause, so the card never shows two
  // lines. The stored cause is state rather than something the user just
  // asked for, which is why it is not announced.
  const note =
    testOutcome ??
    (server.status === 'error' && server.statusError
      ? { ok: false, message: server.statusError }
      : null);

  const status = STATUS_PRESENTATION[server.status];
  const expanded = toolsOpen || resourcesOpen;

  return (
    <Card padded={false} className="space-y-3 p-4">
      <div className="space-y-1">
        <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <ToolAvatar
              subjectKey={identity.subjectKey}
              monogram={identity.monogram}
              name={identity.name}
              image={identity.image}
              size="sm"
            />
            <h3 className="text-sm font-semibold text-fg">{identity.name}</h3>
            <Badge
              variant={status.variant}
              title={server.status === 'error' ? server.statusError : undefined}
            >
              <StatusDot tone={status.tone} className={status.dotClassName} />
              {s.status[server.status]}
            </Badge>
            <Badge>{s.transports[server.transport]}</Badge>
            <Badge title={`${s.environmentLabel}: ${environmentName}`}>
              <Server size={ICON_SM} aria-hidden="true" />
              {environmentName}
            </Badge>
          </div>

          <div className="flex flex-wrap items-center gap-2 sm:shrink-0 sm:flex-nowrap">
            {/* First in the cluster: "Testing…" is wider than "Test", and growing
                leftwards moves nothing else. */}
            <Button
              variant="subtle"
              size="sm"
              loading={testMutation.isPending}
              onClick={handleTest}
            >
              {!testMutation.isPending && <RefreshCw size={ICON_SM} />}
              {testMutation.isPending ? s.testingButton : s.testButton}
            </Button>
            {/* "Enabled" and "Disabled" are different widths, and the cluster sits on the
                right edge, so a narrower word would slide this switch (and the Test
                button before it) sideways and the switches of a list would zig-zag.
                The slot is as wide for either word, in either language. */}
            <div className="flex items-center sm:w-32">
              <Toggle
                id={`mcp-server-enabled-${server.id}`}
                label={server.enabled ? s.enabledLabel : s.disabledLabel}
                checked={server.enabled}
                disabled={updateMutation.isPending}
                onChange={(e) => handleToggleEnabled(e.target.checked)}
              />
            </div>
            {/* Everything else the server offers is one overflow menu, so the ⋮ is
                the usual "more actions" and not a second, unexplained menu between
                two icon buttons. Delete is last, after a separator. */}
            <ToolIdentityMenu
              identity={identity}
              defaultName={server.name}
              size="icon-sm"
              label={formatMessage(s.moreActions, { name: identity.name })}
              before={(close) => (
                <MenuItem
                  icon={<Pencil size={ICON_MD} />}
                  onSelect={() => {
                    close();
                    onEdit(server);
                  }}
                >
                  {s.editButton}
                </MenuItem>
              )}
              after={(close) => (
                <MenuItem
                  tone="danger"
                  icon={<Trash2 size={ICON_MD} />}
                  onSelect={() => {
                    close();
                    onDelete(server);
                  }}
                >
                  {s.deleteServer}
                </MenuItem>
              )}
            />
          </div>
        </div>

        <p className="min-w-0 break-all font-mono text-xs text-fg-muted">
          {server.transport === 'stdio'
            ? [server.command, ...server.args].filter(Boolean).join(' ')
            : server.url}
        </p>
        {/* What the command reveals sits under it, on the card's own left edge (the
            button's 8px padding is pulled back), so the right column holds only the
            row's actions. */}
        <div className="-ml-2 flex flex-wrap gap-1 pt-1">
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
      </div>

      {note ? (
        note.ok ? (
          <StatusNote
            tone="success"
            // eslint-disable-next-line jsx-a11y/prefer-tag-over-role -- The status live region announces changes without implying a calculation output.
            role="status"
          >
            {note.message}
          </StatusNote>
        ) : (
          // A failure is something to act on: which server, what to do, and the
          // way to do it, with the transport's own words as the detail.
          <Callout
            tone="danger"
            role={testOutcome ? 'status' : undefined}
            title={formatMessage(s.testFailedTitle, { name: identity.name })}
            action={
              <Button variant="secondary" size="sm" onClick={() => onEdit(server)}>
                {s.editButton}
              </Button>
            }
          >
            <p>{s.testFailedHint}</p>
            <p className="mt-1 break-all font-mono text-xs text-fg-muted">{note.message}</p>
          </Callout>
        )
      ) : null}

      {expanded && (
        <div className="space-y-3 border-t border-stroke pt-3">
          {toolsOpen && <McpServerTools server={server} />}
          {resourcesOpen && <McpServerResources server={server} />}
        </div>
      )}
    </Card>
  );
}
