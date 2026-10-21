/**
 * The composer's status line: who runs this turn, with what model, under what
 * permissions. The session's identity — which machine and which folder — lives
 * in the header instead, so the strip carries only the per-turn controls.
 *
 * Rendered as `key: value` chips separated by `·` rather than as a toolbar of
 * bordered chips, because that is what it is — a line you read left to right
 * before you type, whose parts happen to be clickable. The stylesheet draws the
 * `·` (`.composer-chip-row`), and only from `sm` up: on a phone the strip wraps
 * and each chip is a 44px target that separates itself.
 *
 * Below `sm` it collapses behind a summary chip. The alternative the plan
 * suggested — an overflow menu — puts half the controls two taps away on the
 * device where changing the model matters most; a single disclosure keeps
 * everything one tap from the surface and hides nothing permanently.
 *
 * The summary says what the controls underneath would say, so it gives way when
 * they are showing: open, it keeps only the folder (the one fact the controls do
 * not carry), and closed it also carries the context ring, the one figure that
 * changes during a session.
 */

import type { AgentProfile } from '@mangostudio/shared/agents';
import type { ModelCatalogResponse, ModelOption } from '@mangostudio/shared/catalog';
import type {
  ExternalAgentDescriptor,
  ExternalApprovalRouting,
  ExternalPermissionLevel,
  ExternalThreadUsage,
} from '@mangostudio/shared/external-agents';
import type { ProviderType, ReasoningEffort } from '@mangostudio/shared/types';
import { ChevronDown } from 'lucide-react';
import { Fragment, type ReactNode, useState } from 'react';
import { ModelSelector } from '@/components/layout/ModelSelector';
import { ThinkingToggle } from '@/components/layout/ThinkingToggle';
import { ChipSelect } from '@/components/ui/ChipSelect';
import { ContextRing } from '@/components/ui/ContextRing';
import { LockedChip } from '@/components/ui/LockedChip';
import {
  ExternalComposerControls,
  hasExternalComposerControls,
} from '@/features/external-agents/ExternalComposerControls';
import { ExternalUsageDisplay } from '@/features/external-agents/ExternalUsageDisplay';
import type { ContextInfo } from '@/features/generation/types';
import { useI18n } from '@/hooks/use-i18n';
import { ICON_SM } from '@/lib/icon-sizes';
import { workdirLabel } from '@/lib/paths';
import { ContextBadge } from './ContextBadge';

/** Shared empty list, so an absent catalog does not allocate per render. */
const NO_MODELS: ModelOption[] = [];

export interface ComposerChipRowProps {
  disabled?: boolean;
  isGenerating?: boolean;
  isExternalRunner: boolean;
  thinkingEnabled: boolean;
  reasoningEffort: ReasoningEffort;
  onThinkingToggle?: (enabled: boolean) => void;
  onReasoningEffortChange?: (effort: ReasoningEffort) => void;
  reasoningVisible: boolean;
  contextInfo?: ContextInfo | null;
  threadUsage?: ExternalThreadUsage | null;
  activeModel: string | null;
  selectedAgentId: string;
  /**
   * Optional because a spread forwards an explicitly-`undefined` key rather
   * than falling back to a default, and both of the arrays here are
   * dereferenced without a guard.
   */
  agents?: ReadonlyArray<AgentProfile>;
  isAgentListLoading: boolean;
  onSelectedAgentIdChange?: (agentId: string) => void;
  /**
   * True once the chat has turns, which turns the agent chip from a choice into
   * a statement: the first prompt settles who runs this chat, and switching from
   * here on means continuing in a new chat — an offer the header's runner
   * selector makes, not this strip.
   */
  hasTurns: boolean;
  /**
   * Not a control anymore — the header's breadcrumb owns changing it. Still
   * read here because the collapsed narrow-screen summary is the one surface
   * naming the folder on a phone, where that breadcrumb is hidden.
   */
  workdir: string | null;
  activeModels?: ModelOption[];
  modelCatalog?: ModelCatalogResponse;
  lockedProvider?: ProviderType | null;
  isModelSelectorDisabled: boolean;
  onModelChange?: (model: string) => void;
  externalDescriptor?: ExternalAgentDescriptor;
  externalModel: string | null;
  externalEffort: string | null;
  externalLevel: ExternalPermissionLevel;
  externalRouting: ExternalApprovalRouting;
  onExternalModelChange?: (model: string | null) => void;
  onExternalEffortChange?: (effort: string | null) => void;
  onExternalSelectionGone?: () => void;
  onExternalPermissionsChange?: (next: {
    level: ExternalPermissionLevel;
    routing: ExternalApprovalRouting;
  }) => void;
}

export function ComposerChipRow(props: ComposerChipRowProps) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const chips = buildChips(props, t);
  if (chips.length === 0) return null;

  return (
    <div className="composer-statusline flex min-w-0 flex-wrap items-center gap-1 px-2 py-1.5">
      <button
        type="button"
        onClick={() => setExpanded((open) => !open)}
        aria-expanded={expanded}
        className="composer-chip min-w-0 flex-1 sm:hidden"
      >
        <span className="composer-chip-value flex-1 text-left">
          {summaryText(props, t, expanded)}
        </span>
        {!expanded && props.contextInfo ? <SummaryContext info={props.contextInfo} /> : null}
        <ChevronDown size={ICON_SM} className={`shrink-0 ${expanded ? 'rotate-180' : ''}`} />
        <span className="sr-only">
          {expanded ? t.chat.input.hideControls : t.chat.input.showControls}
        </span>
      </button>

      {/* Fragments, not wrappers: `ExternalComposerControls` returns three
          chips, and a wrapper would make the strip's separators skip past two
          of them. */}
      <div className={`composer-chip-row ${expanded ? '' : 'max-sm:hidden'}`}>
        {chips.map((chip) => (
          <Fragment key={chip.key}>{chip.node}</Fragment>
        ))}
      </div>
    </div>
  );
}

interface Chip {
  readonly key: string;
  readonly node: ReactNode;
}

/** The collapsed summary's ring and figure; the full breakdown is in the chip it stands in for. */
function SummaryContext({ info }: { info: ContextInfo }) {
  return (
    <span className="flex shrink-0 items-center gap-1 tabular-nums text-fg-muted">
      <ContextRing ratio={info.estimatedUsageRatio} severity={info.severity} showValue={false} />
      {`${Math.round(info.estimatedUsageRatio * 100)}%`}
    </span>
  );
}

/**
 * The narrow-screen stand-in: the two facts that decide what a turn will do.
 * Deliberately not every chip abbreviated — a summary nobody can read is worse
 * than a shorter one that is true.
 *
 * Expanded, the model chip is on screen right under it, so only the folder stays.
 */
function summaryText(
  props: ComposerChipRowProps,
  t: ReturnType<typeof useI18n>['t'],
  expanded: boolean
): string {
  const folder = workdirLabel(props.workdir);
  if (expanded) return folder ?? '';
  // `??` is not enough: `activeModel` is `''` before a catalog loads, and an
  // empty string is a value — the summary rendered as a bare "· folder".
  const model =
    (props.isExternalRunner
      ? props.externalModel
      : props.activeModels?.find((option) => option.modelId === props.activeModel)?.displayName) ||
    (props.isExternalRunner ? t.externalAgents.model.vendorDefault : t.models.loading);
  return folder ? `${model} · ${folder}` : model;
}

function buildChips(props: ComposerChipRowProps, t: ReturnType<typeof useI18n>['t']): Chip[] {
  const chips: Chip[] = [];
  const labels = t.chat.input;

  if (!props.isExternalRunner && props.onSelectedAgentIdChange) {
    const selectable = (props.agents ?? []).filter(
      (agent) => agent.role === 'primary' || agent.role === 'both'
    );
    // The chip renders before the listing lands, and the id it was given is not
    // a name anyone would recognise.
    const placeholder = props.isAgentListLoading ? labels.agentsLoading : props.selectedAgentId;
    chips.push({
      key: 'agent',
      node: props.hasTurns ? (
        <LockedChip
          label={labels.agentLabel}
          // Looked up in the whole listing, not just the selectable agents: this
          // is who *did* answer, and a chat can outlive the agent's role.
          value={
            props.agents?.find((agent) => agent.id === props.selectedAgentId)?.name ?? placeholder
          }
          reason={labels.agentLocked}
        />
      ) : (
        <ChipSelect
          value={props.selectedAgentId}
          options={selectable.map((agent) => ({ value: agent.id, label: agent.name }))}
          onChange={(agentId) => props.onSelectedAgentIdChange?.(agentId)}
          label={labels.agentLabel}
          ariaLabel={labels.selectAgent}
          disabled={props.disabled || props.isAgentListLoading || selectable.length === 0}
          placeholder={placeholder}
        />
      ),
    });
  }

  if (!props.isExternalRunner && props.modelCatalog && props.onModelChange) {
    chips.push({
      key: 'model',
      node: (
        <ModelSelector
          activeModel={props.activeModel ?? ''}
          activeModels={props.activeModels ?? NO_MODELS}
          isDisabled={props.isModelSelectorDisabled || props.disabled === true}
          onSelect={props.onModelChange}
          modelCatalog={props.modelCatalog}
          lockedProvider={props.lockedProvider}
        />
      ),
    });
  }

  // Only when the controls have something to draw. Pushed regardless, an
  // uninstalled runner (no catalog, no permission pairs) kept the strip alive
  // around nothing: twelve pixels of padding and a hairline above the prompt,
  // which read as a broken composer under the warning that explains it.
  if (
    props.isExternalRunner &&
    hasExternalComposerControls(props.externalDescriptor) &&
    props.onExternalModelChange &&
    props.onExternalEffortChange &&
    props.onExternalSelectionGone &&
    props.onExternalPermissionsChange
  ) {
    chips.push({
      key: 'external-controls',
      node: (
        // A nested strip, not a plain wrapper: these three read as `key: value`
        // exactly like the chips around them, and without the row class they
        // were the only run on the line with no `·` between them.
        <span className="composer-chip-row">
          <ExternalComposerControls
            descriptor={props.externalDescriptor}
            model={props.externalModel}
            effort={props.externalEffort}
            level={props.externalLevel}
            routing={props.externalRouting}
            disabled={props.disabled || props.isGenerating}
            onModelChange={props.onExternalModelChange}
            onEffortChange={props.onExternalEffortChange}
            onSelectionGone={props.onExternalSelectionGone}
            onPermissionsChange={props.onExternalPermissionsChange}
          />
        </span>
      ),
    });
  }

  // MangoStudio's own thinking control. An external agent's effort comes from
  // its vendor's per-model catalog instead.
  if (
    !props.isExternalRunner &&
    props.reasoningVisible &&
    props.onThinkingToggle &&
    props.onReasoningEffortChange
  ) {
    chips.push({
      key: 'thinking',
      node: (
        <ThinkingToggle
          enabled={props.thinkingEnabled}
          effort={props.reasoningEffort}
          onToggle={props.onThinkingToggle}
          onEffortChange={props.onReasoningEffortChange}
        />
      ),
    });
  }

  if (props.contextInfo) {
    chips.push({ key: 'context', node: <ContextBadge info={props.contextInfo} /> });
  }

  if (props.threadUsage) {
    chips.push({
      key: 'usage',
      node: <ExternalUsageDisplay turn={props.threadUsage.last} thread={props.threadUsage} />,
    });
  }

  return chips;
}
