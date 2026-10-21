/**
 * Composer affordance for the read-only capability inspector: a popover
 * showing the exact effective capability set (built-in tools, MCP servers and
 * tools, Skills) the current chat/model/agent selection would hand to
 * generation, with typed reasons for anything disabled or unavailable. All
 * eligibility is resolved server-side — this component only renders it.
 */

import type {
  CapabilityMcpServerEntry,
  CapabilityReasonCode,
  CapabilitySkillEntry,
  CapabilityState,
  CapabilityToolEntry,
  ChatCapabilitiesResponse,
} from '@mangostudio/shared/capabilities';
import { LOCAL_ENVIRONMENT_ID } from '@mangostudio/shared/environments';
import type { Messages } from '@mangostudio/shared/i18n';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ListChecks, SlidersHorizontal } from 'lucide-react';
import { useState } from 'react';
import { Callout } from '@/components/ui/Callout';
import { MicroLabel } from '@/components/ui/MicroLabel';
import { StatusDot, type StatusDotTone } from '@/components/ui/StatusDot';
import { ToolAvatar } from '@/components/ui/ToolAvatar';
import { useToolIdentities } from '@/features/environments/identity/use-tool-identities';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';
import { ICON_SM } from '@/lib/icon-sizes';
import type { ChatCapabilitiesSelection } from '../hooks/use-chat-capabilities';
import { chatCapabilitiesQueryOptions } from '../hooks/use-chat-capabilities';
import { ComposerPopover } from './ComposerPopover';

type CapabilityLabels = Messages['chat']['capabilities'];

const REASON_LABEL_KEY: Record<CapabilityReasonCode, keyof CapabilityLabels['reasons']> = {
  'agent-tools-disabled': 'agent-tools-disabled',
  'agent-allowlist': 'agent-allowlist',
  'tool-setting-disabled': 'tool-setting-disabled',
  'name-over-provider-limit': 'name-over-provider-limit',
  'environment-unsupported': 'environment-unsupported',
  'runtime-denied': 'runtime-denied',
  'server-disabled': 'server-disabled',
  'server-unavailable': 'server-unavailable',
  'delegation-disabled': 'delegation-disabled',
  'skill-invalid': 'skill-invalid',
  'skill-disabled': 'skill-disabled',
  'skill-shadowed': 'skill-shadowed',
  'skill-tool-disabled': 'skill-tool-disabled',
};

const STATE_DOT_TONE: Record<CapabilityState, StatusDotTone> = {
  enabled: 'success',
  disabled: 'neutral',
  unavailable: 'warning',
};

/** The dot is decorative; this label is what carries state to assistive tech. */
const STATE_LABEL_KEY: Record<
  CapabilityState,
  'stateEnabled' | 'stateDisabled' | 'stateUnavailable'
> = {
  enabled: 'stateEnabled',
  disabled: 'stateDisabled',
  unavailable: 'stateUnavailable',
};

const AGENT_SETTINGS_REASONS = new Set<CapabilityReasonCode>([
  'agent-tools-disabled',
  'agent-allowlist',
]);

interface CapabilityInspectorProps {
  chatId: string | null;
  disabled?: boolean;
  activeModel?: string | null;
  selectedAgentId?: string;
}

export function CapabilityInspector({
  chatId,
  disabled,
  activeModel,
  selectedAgentId,
}: CapabilityInspectorProps) {
  const { t } = useI18n();
  const labels = t.chat.capabilities;
  const [open, setOpen] = useState(false);

  const selection: ChatCapabilitiesSelection = {
    chatId: chatId ?? '',
    ...(activeModel ? { model: activeModel } : {}),
    ...(selectedAgentId ? { agentId: selectedAgentId } : {}),
  };
  const capabilitiesQuery = useQuery({
    ...chatCapabilitiesQueryOptions(selection),
    enabled: open && !!chatId,
  });

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        disabled={disabled}
        aria-expanded={open}
        className="terminal-chip composer-tool-chip"
        title={labels.title}
      >
        <SlidersHorizontal size={ICON_SM} className="shrink-0" />
        <span className="hidden sm:inline">{labels.button}</span>
      </button>

      {open && (
        <ComposerPopover className="max-h-96 space-y-3 overflow-y-auto p-3">
          <MicroLabel as="p" className="flex items-center gap-1.5">
            <ListChecks size={ICON_SM} />
            {labels.title}
          </MicroLabel>

          {!chatId && <p className="text-xs text-fg-muted">{labels.needsChat}</p>}
          {chatId && capabilitiesQuery.isLoading && (
            <p className="text-xs text-fg-muted">{t.common.loading}</p>
          )}
          {chatId && capabilitiesQuery.isError && (
            <Callout tone="danger" role="alert" title={labels.loadError} />
          )}
          {chatId && capabilitiesQuery.data && (
            <CapabilityPanel capabilities={capabilitiesQuery.data} labels={labels} />
          )}
        </ComposerPopover>
      )}
    </div>
  );
}

function CapabilityPanel({
  capabilities,
  labels,
}: {
  capabilities: ChatCapabilitiesResponse;
  labels: CapabilityLabels;
}) {
  const builtinTools = capabilities.tools.filter((tool) => tool.source === 'builtin');
  const mcpToolsByServer = new Map<string, CapabilityToolEntry[]>();
  for (const tool of capabilities.tools) {
    if (tool.source !== 'mcp' || !tool.serverSlug) continue;
    const group = mcpToolsByServer.get(tool.serverSlug) ?? [];
    group.push(tool);
    mcpToolsByServer.set(tool.serverSlug, group);
  }

  return (
    <>
      <div className="space-y-0.5 text-xs text-fg-muted">
        <p className="truncate">
          {labels.modelLabel}: <span className="text-fg">{capabilities.model.modelId}</span>
        </p>
        <p className="truncate">
          {labels.agentLabel}: <span className="text-fg">{capabilities.agent.name}</span>
        </p>
        {capabilities.contextInfo && (
          <p>
            {labels.contextLabel}:{' '}
            <span className="text-fg">
              {Math.round(capabilities.contextInfo.estimatedUsageRatio * 100)}%
            </span>
          </p>
        )}
      </div>

      <CapabilitySection
        heading={labels.builtinsSection}
        countLabel={enabledCountLabel(labels, builtinTools)}
        manageLabel={labels.manageTools}
        manageTo="/settings/tools"
      >
        {builtinTools.map((tool) => (
          <CapabilityRow
            key={tool.name}
            labels={labels}
            title={tool.title}
            state={tool.state}
            reasonText={reasonText(labels, tool.reason, {
              name: tool.environmentName,
              id: tool.environmentId,
            })}
            reasonManageTo={reasonManageTo(tool.reason)}
          />
        ))}
      </CapabilitySection>

      <CapabilitySection
        heading={labels.mcpSection}
        countLabel={labels.toolCount.replace(
          '{count}',
          String(
            capabilities.mcpServers.reduce((total, server) => total + server.effectiveToolCount, 0)
          )
        )}
        manageLabel={labels.manageMcp}
        manageTo="/settings/mcp"
      >
        {capabilities.mcpServers.length === 0 && (
          <p className="px-2 text-xs text-fg-muted">{labels.mcpEmpty}</p>
        )}
        {capabilities.mcpServers.map((server) => (
          <McpServerRows
            key={server.slug}
            server={server}
            tools={mcpToolsByServer.get(server.slug) ?? []}
            labels={labels}
          />
        ))}
      </CapabilitySection>

      <CapabilitySection
        heading={labels.skillsSection}
        countLabel={enabledCountLabel(labels, capabilities.skills)}
        manageLabel={labels.manageSkills}
        manageTo="/settings/skills"
      >
        {capabilities.skills.length === 0 && (
          <p className="px-2 text-xs text-fg-muted">{labels.skillsEmpty}</p>
        )}
        {capabilities.skills.map((skill: CapabilitySkillEntry) => (
          <CapabilityRow
            key={skill.key}
            labels={labels}
            title={skill.name}
            subtitle={skill.source}
            state={skill.state}
            reasonText={reasonText(labels, skill.reason)}
            reasonManageTo={reasonManageTo(skill.reason)}
          />
        ))}
      </CapabilitySection>
    </>
  );
}

function McpServerRows({
  server,
  tools,
  labels,
}: {
  server: CapabilityMcpServerEntry;
  tools: CapabilityToolEntry[];
  labels: CapabilityLabels;
}) {
  // Read-only surface: the inspector shows what the user calls a server, but
  // the tool names it contributes to the turn are untouched by any rename.
  const { resolve } = useToolIdentities();
  const identity = resolve('mcp', server.slug, server.name);

  return (
    <div className="space-y-0.5">
      <CapabilityRow
        labels={labels}
        title={identity.name}
        avatar={
          <ToolAvatar
            subjectKey={identity.subjectKey}
            monogram={identity.monogram}
            name={identity.name}
            image={identity.image}
            size="xs"
          />
        }
        subtitle={labels.health[server.health]}
        state={server.state}
        reasonText={reasonText(labels, server.reason, {
          name: server.environmentName,
          id: server.environmentId,
        })}
        reasonManageTo={reasonManageTo(server.reason)}
      />
      {tools.map((tool) => (
        <div key={tool.name} className="pl-4">
          <CapabilityRow
            labels={labels}
            title={tool.title}
            state={tool.state}
            reasonText={reasonText(labels, tool.reason, {
              name: tool.environmentName,
              id: tool.environmentId,
            })}
            reasonManageTo={reasonManageTo(tool.reason)}
          />
        </div>
      ))}
    </div>
  );
}

function CapabilitySection({
  heading,
  countLabel,
  manageLabel,
  manageTo,
  children,
}: {
  heading: string;
  countLabel: string;
  manageLabel: string;
  manageTo: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium text-fg-muted">
          {heading} · {countLabel}
        </p>
        <Link to={manageTo} className="shrink-0 text-xs text-accent-fg hover:underline">
          {manageLabel}
        </Link>
      </div>
      {children}
    </div>
  );
}

function CapabilityRow({
  labels,
  title,
  avatar,
  subtitle,
  state,
  reasonText,
  reasonManageTo,
}: {
  labels: CapabilityLabels;
  title: string;
  /** Identity chip for rows that stand for a tool rather than one capability. */
  avatar?: React.ReactNode;
  subtitle?: string;
  state: CapabilityState;
  reasonText?: string;
  reasonManageTo?: '/settings/agents';
}) {
  return (
    <div className="flex items-start gap-2 px-2 py-1">
      <StatusDot tone={STATE_DOT_TONE[state]} className="mt-1" />
      {avatar}
      <span className="min-w-0">
        <span
          className={`block truncate text-xs ${state === 'enabled' ? 'text-fg' : 'text-fg-muted'}`}
        >
          {title}
          <span className="sr-only"> · {labels[STATE_LABEL_KEY[state]]}</span>
          {subtitle && <span className="text-fg-subtle"> · {subtitle}</span>}
        </span>
        {reasonText && reasonManageTo && (
          <Link
            to={reasonManageTo}
            className="block truncate text-xs text-accent-fg hover:underline"
          >
            {reasonText}
          </Link>
        )}
        {reasonText && !reasonManageTo && (
          <span className="block truncate text-xs text-fg-muted">{reasonText}</span>
        )}
      </span>
    </div>
  );
}

function reasonText(
  labels: CapabilityLabels,
  reason: CapabilityReasonCode | undefined,
  environment?: { name?: string; id?: string }
): string | undefined {
  if (!reason) return undefined;
  const template = labels.reasons[REASON_LABEL_KEY[reason]];
  // The hub reports its own machine under a fixed English name, the same way
  // it reports any environment's name. Printing it inside a translated
  // sentence would leave "recusada por Local" for a pt-BR reader, so the one
  // environment whose name the UI can speak for is resolved from its id.
  const environmentName =
    environment?.id === LOCAL_ENVIRONMENT_ID ? labels.localEnvironment : environment?.name;
  return environmentName ? formatMessage(template, { environmentName }) : template;
}

function reasonManageTo(reason: CapabilityReasonCode | undefined): '/settings/agents' | undefined {
  return reason && AGENT_SETTINGS_REASONS.has(reason) ? '/settings/agents' : undefined;
}

function enabledCountLabel(
  labels: CapabilityLabels,
  entries: ReadonlyArray<{ state: CapabilityState }>
): string {
  const enabled = entries.filter((entry) => entry.state === 'enabled').length;
  return formatMessage(labels.enabledCount, {
    enabled: String(enabled),
    total: String(entries.length),
  });
}
