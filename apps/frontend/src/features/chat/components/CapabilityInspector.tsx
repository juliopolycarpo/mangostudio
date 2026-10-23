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
import { LOCAL_ENVIRONMENT_ID } from '@mangostudio/shared/environments/values';
import type { Messages } from '@mangostudio/shared/i18n';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ListChecks, SlidersHorizontal } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { Callout } from '@/components/ui/Callout';
import { ComposerPopover } from '@/components/ui/ComposerPopover';
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

/**
 * The dot for a server, and for the tools it is the reason for: a server whose
 * own status word is `error` is a fault, not a thing to fix, so the glyph says
 * so too. "GitHub · error" on a warning dot told the reader two different things.
 */
function mcpDotTone(server: CapabilityMcpServerEntry): StatusDotTone | undefined {
  return server.state !== 'enabled' && server.health === 'error' ? 'error' : undefined;
}

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
            <CapabilityPanel capabilities={capabilitiesQuery.data} labels={labels} />
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
  const mcpHasException =
    hasException(capabilities.mcpServers) ||
    hasException(capabilities.tools.filter((tool) => tool.source === 'mcp'));

  return (
    <div className="divide-y divide-stroke">
      <CapabilitySection
        heading={labels.builtinsSection}
        countLabel={enabledCountLabel(labels, builtinTools)}
        manageLabel={labels.manageTools}
        manageTo="/settings/tools"
        managesAgent={builtinTools.some((tool) => isAgentSettingsReason(tool.reason))}
        defaultOpen={hasException(builtinTools)}
      >
        <ExceptionsAndEnabled
          entries={builtinTools}
          labels={labels}
          renderRow={(tool) => (
            <CapabilityRow
              key={tool.name}
              labels={labels}
              title={tool.title}
              state={tool.state}
              reasonText={reasonText(labels, tool.reason, {
                name: tool.environmentName,
                id: tool.environmentId,
              })}
            />
          )}
        />
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
        managesAgent={
          capabilities.mcpServers.some((server) => isAgentSettingsReason(server.reason)) ||
          capabilities.tools.some(
            (tool) => tool.source === 'mcp' && isAgentSettingsReason(tool.reason)
          )
        }
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
        managesAgent={capabilities.skills.some((skill) => isAgentSettingsReason(skill.reason))}
        defaultOpen={hasException(capabilities.skills) || capabilities.skills.length === 0}
      >
        {capabilities.skills.length === 0 && (
          <p className="px-2 text-xs text-fg-muted">{labels.skillsEmpty}</p>
        )}
        <ExceptionsAndEnabled
          entries={capabilities.skills}
          labels={labels}
          renderRow={(skill: CapabilitySkillEntry) => (
            <CapabilityRow
              key={skill.key}
              labels={labels}
              title={skill.name}
              subtitle={skill.source}
              state={skill.state}
              reasonText={reasonText(labels, skill.reason)}
            />
          )}
        />
      </CapabilitySection>
    </div>
  );
}

/**
 * A flat group's rows: what needs explaining first, and the rest behind a line
 * that counts them.
 *
 * A group that opened because three of its twenty-one rows are off would
 * otherwise push every section under it out of the popover, and the sections
 * are the part nobody scrolling for a row would find. The enabled rows are not
 * dropped — the line opens them — so the panel still holds the exact effective
 * set. A group with nothing to explain was opened by hand and lists all of it.
 */
function ExceptionsAndEnabled<Entry extends { state: CapabilityState }>({
  entries,
  labels,
  renderRow,
}: {
  entries: readonly Entry[];
  labels: CapabilityLabels;
  renderRow: (entry: Entry) => React.ReactNode;
}) {
  const [showEnabled, setShowEnabled] = useState(false);
  const bodyId = useId();
  const exceptions = entries.filter((entry) => entry.state !== 'enabled');
  const enabled = entries.filter((entry) => entry.state === 'enabled');
  if (exceptions.length === 0) return enabled.map(renderRow);

  const count = String(enabled.length);
  return (
    <>
      {exceptions.map(renderRow)}
      {enabled.length > 0 && (
        <>
          <button
            type="button"
            aria-expanded={showEnabled}
            aria-controls={bodyId}
            onClick={() => setShowEnabled((value) => !value)}
            className="flex h-7 w-full cursor-pointer items-center gap-1 rounded-sm px-1 text-left text-xs text-fg-muted transition-colors hover:bg-fill-hover hover:text-fg"
          >
            <DisclosureChevron expanded={showEnabled} />
            <span className="truncate">
              {formatMessage(showEnabled ? labels.hideEnabled : labels.showEnabled, { count })}
            </span>
          </button>
          {showEnabled ? (
            <div id={bodyId} className="space-y-0.5">
              {enabled.map(renderRow)}
            </div>
          ) : null}
        </>
      )}
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
  const serverTone = mcpDotTone(server);

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
        tone={serverTone}
        reasonText={reasonText(labels, server.reason, {
          name: server.environmentName,
          id: server.environmentId,
        })}
      />
      {exceptionsFirst(tools).map((tool) => (
        <div key={tool.name} className="pl-4">
          <CapabilityRow
            labels={labels}
            title={tool.title}
            state={tool.state}
            // A tool that is off *because* its server failed carries the server's dot.
            tone={tool.reason === 'server-unavailable' ? serverTone : undefined}
            reasonText={reasonText(labels, tool.reason, {
              name: tool.environmentName,
              id: tool.environmentId,
            })}
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
 *
 * The ways out sit on the heading's line, once each: the section's own settings
 * page, and — when a row is off because of the agent profile — the agent's
 * settings. A link under every such row repeated one mango sentence down the
 * panel and made it the loudest thing in it.
 */
function CapabilitySection({
  heading,
  countLabel,
  manageLabel,
  manageTo,
  managesAgent,
  defaultOpen,
  children,
}: {
  heading: string;
  countLabel: string;
  manageLabel: string;
  manageTo: string;
  /** True when a row in the section is off because of the agent profile. */
  managesAgent: boolean;
  defaultOpen: boolean;
  children: React.ReactNode;
}) {
  const { t } = useI18n();
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
        {managesAgent ? (
          <Link to="/settings/agents" className="shrink-0 text-xs text-accent-fg hover:underline">
            {t.chat.capabilities.manageAgent}
          </Link>
        ) : null}
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
  tone,
  reasonText,
}: {
  labels: CapabilityLabels;
  title: string;
  /** Identity chip for rows that stand for a tool rather than one capability. */
  avatar?: React.ReactNode;
  subtitle?: string;
  state: CapabilityState;
  /** Overrides the state's own dot when the row knows more (a server in error). */
  tone?: StatusDotTone;
  /** Plain words: the section heading carries the way to change it. */
  reasonText?: string;
}) {
  return (
    <div className="flex items-start gap-2 px-2 py-1">
      {/* The slot is held for an enabled row too, so titles keep one left edge. */}
      {state === 'enabled' ? (
        <span aria-hidden="true" className="mt-1 size-2 shrink-0" />
      ) : (
        <StatusDot tone={tone ?? STATE_DOT_TONE[state]} className="mt-1" />
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
        {reasonText && <span className="block truncate text-xs text-fg-muted">{reasonText}</span>}
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

/** A reason the agent profile owns, so the agent's settings are where it changes. */
function isAgentSettingsReason(reason: CapabilityReasonCode | undefined): boolean {
  return reason !== undefined && AGENT_SETTINGS_REASONS.has(reason);
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
