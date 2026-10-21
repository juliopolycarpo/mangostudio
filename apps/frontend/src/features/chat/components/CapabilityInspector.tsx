/**
 * Composer affordance for the read-only capability inspector: a popover
 * showing the exact effective capability set (built-in tools, MCP servers and
 * tools, Skills) the current chat/model/agent selection would hand to
 * generation, with typed reasons for anything disabled or unavailable. All
 * eligibility is resolved server-side — this component only renders it.
 *
 * The normal state is quiet: a row that is simply enabled carries no mark, and
 * only a disabled or unavailable one draws its dot and its reason. A section
 * opens by itself when it holds one of those, so what the panel opens on is the
 * thing worth reading, not a column of identical rows.
 */

import type {
  CapabilityMcpServerEntry,
  CapabilityReasonCode,
  CapabilitySkillEntry,
  CapabilityState,
  CapabilityToolEntry,
  ChatCapabilitiesResponse,
} from '@mangostudio/shared/capabilities';
import type { ModelOption } from '@mangostudio/shared/catalog';
import { LOCAL_ENVIRONMENT_ID } from '@mangostudio/shared/environments';
import type { Messages } from '@mangostudio/shared/i18n';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ListChecks, SlidersHorizontal } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { Callout } from '@/components/ui/Callout';
import { Chip } from '@/components/ui/Chip';
import { MicroLabel } from '@/components/ui/MicroLabel';
import { StatusDot, type StatusDotTone } from '@/components/ui/StatusDot';
import { ToolAvatar } from '@/components/ui/ToolAvatar';
import { useToolIdentities } from '@/features/environments/identity/use-tool-identities';
import { useDismissable } from '@/hooks/use-dismissable';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';
import { ICON_SM } from '@/lib/icon-sizes';
import { cn } from '@/lib/utils';
import type { ChatCapabilitiesSelection } from '../hooks/use-chat-capabilities';
import { chatCapabilitiesQueryOptions } from '../hooks/use-chat-capabilities';
import { ComposerPopover } from './ComposerPopover';
import { DisclosureChevron } from './DisclosureChevron';

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

/**
 * Only the states that need explaining get a dot. `enabled` is the normal case:
 * a column of eighteen green dots said nothing the header's `18/21 enabled`
 * did not, and made the rows that did matter the quietest thing in the panel.
 */
const STATE_DOT_TONE: Record<Exclude<CapabilityState, 'enabled'>, StatusDotTone> = {
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
  /**
   * The composer's model list, for the name the status line already shows. The
   * response names the model by id; without this the panel would print
   * `claude-sonnet-4-5-20250929` two inches under a chip that says
   * `Claude Sonnet 4.5`.
   */
  models?: readonly ModelOption[];
}

export function CapabilityInspector({
  chatId,
  disabled,
  activeModel,
  selectedAgentId,
  models,
}: CapabilityInspectorProps) {
  const { t } = useI18n();
  const labels = t.chat.capabilities;
  const [open, setOpen] = useState(false);
  const { containerRef, triggerRef, onKeyDown } = useDismissable(open, () => setOpen(false));

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
    // Not `relative`: the panel is anchored to the composer, not to this chip.
    // biome-ignore lint/a11y/noStaticElementInteractions: Escape is handled for the trigger and the panel it owns, both inside this wrapper.
    <div ref={containerRef} onKeyDown={onKeyDown}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((value) => !value)}
        disabled={disabled}
        aria-expanded={open}
        className="composer-chip composer-tool-chip"
        title={labels.title}
      >
        <SlidersHorizontal size={ICON_SM} className="shrink-0" />
        <span className="hidden sm:inline">{labels.button}</span>
      </button>

      {open && (
        <ComposerPopover
          anchor={triggerRef}
          className="app-scrollbar max-h-96 space-y-3 overflow-y-auto p-3"
        >
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
            <CapabilityPanel
              capabilities={capabilitiesQuery.data}
              labels={labels}
              models={models}
            />
          )}
        </ComposerPopover>
      )}
    </div>
  );
}

/** Exceptions first: a stable sort, so the rest keep the order the hub gave them. */
function exceptionsFirst<Entry extends { state: CapabilityState }>(
  entries: readonly Entry[]
): Entry[] {
  return [...entries].sort(
    (left, right) => Number(left.state === 'enabled') - Number(right.state === 'enabled')
  );
}

function hasException(entries: ReadonlyArray<{ state: CapabilityState }>): boolean {
  return entries.some((entry) => entry.state !== 'enabled');
}

function CapabilityPanel({
  capabilities,
  labels,
  models,
}: {
  capabilities: ChatCapabilitiesResponse;
  labels: CapabilityLabels;
  models: readonly ModelOption[] | undefined;
}) {
  const builtinTools = capabilities.tools.filter((tool) => tool.source === 'builtin');
  const mcpToolsByServer = new Map<string, CapabilityToolEntry[]>();
  for (const tool of capabilities.tools) {
    if (tool.source !== 'mcp' || !tool.serverSlug) continue;
    const group = mcpToolsByServer.get(tool.serverSlug) ?? [];
    group.push(tool);
    mcpToolsByServer.set(tool.serverSlug, group);
  }
  const modelId = capabilities.model.modelId;
  const modelName = models?.find((option) => option.modelId === modelId)?.displayName ?? modelId;
  const mcpHasException =
    hasException(capabilities.mcpServers) ||
    hasException(capabilities.tools.filter((tool) => tool.source === 'mcp'));

  return (
    <>
      {/* The same `key: value` dialect as the status line the panel rose from. */}
      <div className="flex flex-wrap gap-1.5">
        <Chip label={labels.modelLabel} title={modelId} className="max-w-full">
          {modelName}
        </Chip>
        <Chip label={labels.agentLabel} className="max-w-full">
          {capabilities.agent.name}
        </Chip>
        {capabilities.contextInfo && (
          <Chip label={labels.contextLabel}>
            {Math.round(capabilities.contextInfo.estimatedUsageRatio * 100)}%
          </Chip>
        )}
      </div>

      <div className="divide-y divide-stroke">
        <CapabilitySection
          heading={labels.builtinsSection}
          countLabel={enabledCountLabel(labels, builtinTools)}
          manageLabel={labels.manageTools}
          manageTo="/settings/tools"
          defaultOpen={hasException(builtinTools)}
        >
          {exceptionsFirst(builtinTools).map((tool) => (
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
              capabilities.mcpServers.reduce(
                (total, server) => total + server.effectiveToolCount,
                0
              )
            )
          )}
          manageLabel={labels.manageMcp}
          manageTo="/settings/mcp"
          // An empty section is one line of text, and the line is the answer.
          defaultOpen={mcpHasException || capabilities.mcpServers.length === 0}
        >
          {capabilities.mcpServers.length === 0 && (
            <p className="px-2 text-xs text-fg-muted">{labels.mcpEmpty}</p>
          )}
          {exceptionsFirst(capabilities.mcpServers).map((server) => (
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
          defaultOpen={hasException(capabilities.skills) || capabilities.skills.length === 0}
        >
          {capabilities.skills.length === 0 && (
            <p className="px-2 text-xs text-fg-muted">{labels.skillsEmpty}</p>
          )}
          {exceptionsFirst(capabilities.skills).map((skill: CapabilitySkillEntry) => (
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
      </div>
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
      {exceptionsFirst(tools).map((tool) => (
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

/**
 * One group of the inventory, collapsed to its count line.
 *
 * The line is the answer for a group where everything is on; the rows are there
 * to be opened when something is not. `defaultOpen` is read again whenever it
 * turns true, so a tool switched off while the panel is up opens its group
 * rather than only changing a number.
 */
function CapabilitySection({
  heading,
  countLabel,
  manageLabel,
  manageTo,
  defaultOpen,
  children,
}: {
  heading: string;
  countLabel: string;
  manageLabel: string;
  manageTo: string;
  defaultOpen: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const bodyId = useId();
  useEffect(() => {
    if (defaultOpen) setOpen(true);
  }, [defaultOpen]);

  return (
    <section className="space-y-1 py-2 first:pt-0 last:pb-0">
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen((value) => !value)}
          className="flex h-7 min-w-0 flex-1 cursor-pointer items-center gap-1 rounded-sm px-1 text-left text-xs font-medium text-fg-muted transition-colors hover:bg-fill-hover hover:text-fg"
        >
          <DisclosureChevron expanded={open} />
          <span className="truncate">
            {heading} · {countLabel}
          </span>
        </button>
        <Link to={manageTo} className="shrink-0 text-xs text-accent-fg hover:underline">
          {manageLabel}
        </Link>
      </div>
      {open ? (
        <div id={bodyId} className="space-y-0.5">
          {children}
        </div>
      ) : null}
    </section>
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
      {/* The slot is held for an enabled row too, so titles keep one left edge. */}
      {state === 'enabled' ? (
        <span aria-hidden="true" className="mt-1 size-2 shrink-0" />
      ) : (
        <StatusDot tone={STATE_DOT_TONE[state]} className="mt-1" />
      )}
      {avatar}
      <span className="min-w-0">
        <span
          className={cn(
            'block truncate text-xs',
            state === 'enabled' ? 'text-fg' : 'text-fg-muted'
          )}
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
