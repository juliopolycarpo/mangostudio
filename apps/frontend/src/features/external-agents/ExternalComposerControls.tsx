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
import { Cpu } from 'lucide-react';
import { useEffect, useRef } from 'react';
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
        <label className="composer-chip max-w-[13rem]">
          <span className="composer-chip-key text-on-surface-variant/70">{`${t.chat.input.modelLabel}:`}</span>
          <select
            value={selectedModel?.id ?? ''}
            disabled={disabled}
            onChange={(event) => {
              onModelChange(event.target.value || null);
              // The effort vocabulary belongs to the model, so a model change
              // invalidates it rather than carrying a value the new model may
              // not offer.
              onEffortChange(null);
            }}
            aria-label={labels.model.label}
            className="composer-chip-value composer-chip-runner min-w-0 max-w-[9rem] appearance-none bg-transparent outline-none disabled:opacity-60"
          >
            {models.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.displayName ?? candidate.id}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      {efforts.length > 0 ? (
        <label className="composer-chip max-w-[11rem]">
          <span className="composer-chip-key text-on-surface-variant/70">{`${t.chat.input.effortLabel}:`}</span>
          <select
            value={effort ?? selectedModel?.defaultReasoningEffort ?? ''}
            disabled={disabled}
            onChange={(event) => onEffortChange(event.target.value || null)}
            aria-label={labels.model.effortLabel}
            className="composer-chip-value min-w-0 max-w-[7rem] appearance-none bg-transparent text-inherit outline-none disabled:opacity-60"
          >
            {efforts.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.displayName ?? candidate.id}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      <PermissionSelector
        configurations={descriptor.supportedConfigurations}
        level={level}
        routing={routing}
        disabled={disabled}
        onChange={onPermissionsChange}
      />

      {/* The quiet line the user should never have to guess at: MangoStudio's
          own tool settings do not apply to a turn it is not running. */}
      <span className="flex min-w-0 items-center gap-1 font-mono text-[11px] text-on-surface-variant/50">
        <Cpu size={11} className="shrink-0" />
        <span className="truncate">
          {labels.selector.ownership.replace('{vendor}', labels.target[descriptor.targetId])}
        </span>
      </span>

      {models.length === 0 ? (
        // Nothing to pick, so nothing is shown — but a reader deserves to know
        // the model was not simply omitted.
        <span className="sr-only">{labels.model.vendorDefault}</span>
      ) : null}
    </>
  );
}
