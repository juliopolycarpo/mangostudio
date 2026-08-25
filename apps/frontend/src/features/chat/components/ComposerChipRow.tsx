/**
 * The composer's status line: who runs this turn, with what model, under what
 * permissions. The session's identity — which machine and which folder — lives
 * in the header instead, so the strip carries only the per-turn controls.
 *
 * Rendered as `key: value` chips separated by `·` rather than as a toolbar of
 * bordered pills, because that is what it is — a line you read left to right
 * before you type, whose parts happen to be clickable.
 *
 * Below `sm` it collapses behind a summary chip. The alternative the plan
 * suggested — an overflow menu — puts half the controls two taps away on the
 * device where changing the model matters most; a single disclosure keeps
 * everything one tap from the surface and hides nothing permanently.
 */

import type {
  ModelCatalogResponse,
  ModelOption,
  ProviderType,
  ReasoningEffort,
} from '@mangostudio/shared';
import type { AgentProfile } from '@mangostudio/shared/agents';
import type {
  ExternalAgentDescriptor,
  ExternalApprovalRouting,
  ExternalPermissionLevel,
  ExternalThreadUsage,
} from '@mangostudio/shared/external-agents';
import { ChevronDown } from 'lucide-react';
import { Fragment, type ReactNode, useState } from 'react';
import { ModelSelector } from '@/components/layout/ModelSelector';
import { ThinkingToggle } from '@/components/layout/ThinkingToggle';
import { ChipSelect } from '@/components/ui/ChipSelect';
import { ExternalComposerControls } from '@/features/external-agents/ExternalComposerControls';
import { ExternalUsageDisplay } from '@/features/external-agents/ExternalUsageDisplay';
import type { ContextInfo } from '@/features/generation/types';
import { useI18n } from '@/hooks/use-i18n';
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
    <div className="composer-statusline flex min-w-0 flex-wrap items-center gap-x-1 gap-y-1 px-2 py-1.5">
      <button
        type="button"
        onClick={() => setExpanded((open) => !open)}
        aria-expanded={expanded}
        className="composer-chip min-w-0 flex-1 sm:hidden"
      >
        <span className="composer-chip-value flex-1 text-left">{summaryText(props, t)}</span>
        <ChevronDown
          size={11}
          className={`shrink-0 transition-transform ${expanded ? 'rotate-180' : ''}`}
        />
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

/**
 * The narrow-screen stand-in: the two facts that decide what a turn will do.
 * Deliberately not every chip abbreviated — a summary nobody can read is worse
 * than a shorter one that is true.
 */
function summaryText(props: ComposerChipRowProps, t: ReturnType<typeof useI18n>['t']): string {
  // `??` is not enough: `activeModel` is `''` before a catalog loads, and an
  // empty string is a value — the summary rendered as a bare "· folder".
  const model =
    (props.isExternalRunner
      ? props.externalModel
      : props.activeModels?.find((option) => option.modelId === props.activeModel)?.displayName) ||
    (props.isExternalRunner ? t.externalAgents.model.vendorDefault : t.models.loading);
  const folder = workdirLabel(props.workdir);
  return folder ? `${model} · ${folder}` : model;
}

function buildChips(props: ComposerChipRowProps, t: ReturnType<typeof useI18n>['t']): Chip[] {
  const chips: Chip[] = [];
  const labels = t.chat.input;

  if (!props.isExternalRunner && props.onSelectedAgentIdChange) {
    const selectable = (props.agents ?? []).filter(
      (agent) => agent.role === 'primary' || agent.role === 'both'
    );
    chips.push({
      key: 'agent',
      node: (
        <ChipSelect
          value={props.selectedAgentId}
          options={selectable.map((agent) => ({ value: agent.id, label: agent.name }))}
          onChange={(agentId) => props.onSelectedAgentIdChange?.(agentId)}
          label={labels.agentLabel}
          ariaLabel={labels.selectAgent}
          disabled={props.disabled || props.isAgentListLoading || selectable.length === 0}
          // The chip renders before the listing lands, and the id it was given
          // is not a name anyone would recognise.
          placeholder={props.isAgentListLoading ? labels.agentsLoading : props.selectedAgentId}
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

  if (
    props.isExternalRunner &&
    props.onExternalModelChange &&
    props.onExternalEffortChange &&
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
