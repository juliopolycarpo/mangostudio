/**
 * The controls that only exist while an external agent is the runner.
 *
 * All three render from what the adapter actually returned:
 *
 * - the model picker appears only when the vendor advertised a **non-empty**
 *   catalog, so an empty dropdown never appears — the gate is the catalog's
 *   contents, not the `modelCatalog` capability flag;
 * - the effort picker is derived from the *selected model's* own
 *   `supportedReasoningEfforts` and is re-derived when the model changes, since
 *   the two are per-model in Codex rather than global;
 * - the permission pair comes from `supportedConfigurations`.
 *
 * Model display uses `displayName` when the vendor gave one, and `hidden`
 * entries are left out. The old Cursor provider's mistake was flattening a rich
 * catalog into bare ids; nothing here asserts how many models there should be.
 */

import type {
  ExternalAgentDescriptor,
  ExternalApprovalRouting,
  ExternalPermissionLevel,
} from '@mangostudio/shared/external-agents';
import { useEffect, useRef } from 'react';
import { ChipSelect } from '@/components/ui/ChipSelect';
import { PermissionSelector } from '@/features/chat/components/PermissionSelector';
import { useI18n } from '@/hooks/use-i18n';

export interface ExternalComposerControlsProps {
  descriptor: ExternalAgentDescriptor | undefined;
  model: string | null;
  effort: string | null;
  level: ExternalPermissionLevel;
  routing: ExternalApprovalRouting;
  disabled?: boolean;
  onModelChange: (model: string | null) => void;
  onEffortChange: (effort: string | null) => void;
  onPermissionsChange: (next: {
    level: ExternalPermissionLevel;
    routing: ExternalApprovalRouting;
  }) => void;
}

export function ExternalComposerControls({
  descriptor,
  model,
  effort,
  level,
  routing,
  disabled = false,
  onModelChange,
  onEffortChange,
  onPermissionsChange,
}: ExternalComposerControlsProps) {
  const { t } = useI18n();
  const labels = t.externalAgents;

  const models = (descriptor?.models ?? []).filter((candidate) => candidate.hidden !== true);
  const selectedModel =
    models.find((candidate) => candidate.id === model) ??
    models.find((candidate) => candidate.isDefault);
  const efforts = selectedModel?.supportedReasoningEfforts ?? [];

  /**
   * A selection the refreshed catalog no longer offers is dropped, not merely
   * hidden.
   *
   * Falling back to the default for *display* while the request still names the
   * old model is the case that matters: the hub honours an explicitly requested
   * model even when the vendor marked it `hidden`, so a model that goes hidden
   * between two turns would keep running while the picker shows the default —
   * the turn and the control disagreeing about what is running it.
   *
   * A catalog that is momentarily empty is a refetch, not a removal, so it
   * reconciles nothing.
   */
  const selectionIsGone =
    model !== null && models.length > 0 && !models.some((candidate) => candidate.id === model);
  // Held in a ref because the call sites are inline closures: depending on them
  // directly would re-run this on every parent render.
  const changeRef = useRef({ onModelChange, onEffortChange });
  changeRef.current = { onModelChange, onEffortChange };
  useEffect(() => {
    if (!selectionIsGone) return;
    changeRef.current.onModelChange(null);
    // The effort vocabulary belonged to the model that just went away.
    changeRef.current.onEffortChange(null);
  }, [selectionIsGone]);

  if (!descriptor) return null;

  return (
    <>
      {models.length > 0 ? (
        <ChipSelect
          value={selectedModel?.id ?? ''}
          options={models.map((candidate) => ({
            value: candidate.id,
            label: candidate.displayName ?? candidate.id,
          }))}
          onChange={(next) => {
            onModelChange(next || null);
            // The effort vocabulary belongs to the model, so a model change
            // invalidates it rather than carrying a value the new model may
            // not offer.
            onEffortChange(null);
          }}
          label={t.chat.input.modelLabel}
          ariaLabel={labels.model.label}
          disabled={disabled}
          valueClassName="composer-chip-runner"
          panelClassName="w-64"
        />
      ) : null}

      {efforts.length > 0 ? (
        <ChipSelect
          value={effort ?? selectedModel?.defaultReasoningEffort ?? ''}
          options={efforts.map((candidate) => ({
            value: candidate.id,
            label: candidate.displayName ?? candidate.id,
          }))}
          onChange={(next) => onEffortChange(next || null)}
          label={t.chat.input.effortLabel}
          ariaLabel={labels.model.effortLabel}
          disabled={disabled}
          className="max-w-[11rem]"
          panelClassName="w-44"
        />
      ) : null}

      <PermissionSelector
        configurations={descriptor.supportedConfigurations}
        level={level}
        routing={routing}
        disabled={disabled}
        onChange={onPermissionsChange}
      />

      {models.length === 0 ? (
        // Nothing to pick, so nothing is shown — but a reader deserves to know
        // the model was not simply omitted.
        <span className="sr-only">{labels.model.vendorDefault}</span>
      ) : null}
    </>
  );
}
