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
 *
 * A runner with neither a catalog nor a permission pair — one that is not
 * installed, or whose descriptor has not landed — renders nothing visible at
 * all, which is why {@link hasExternalComposerControls} sits in this file: the
 * status line asks it before drawing a strip for these controls, and it must
 * agree with what the component below will actually draw.
 */

import type {
  ExternalAgentDescriptor,
  ExternalApprovalRouting,
  ExternalPermissionLevel,
} from '@mangostudio/shared/external-agents';
import type { Messages } from '@mangostudio/shared/i18n';
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
  /**
   * The selection went away with the catalog rather than with a pick, so this
   * is separate from the two above: it is a display correction, and the caller
   * is expected to reconcile without storing anything.
   */
  onSelectionGone: () => void;
  onPermissionsChange: (next: {
    level: ExternalPermissionLevel;
    routing: ExternalApprovalRouting;
  }) => void;
}

/** The efforts MangoStudio's own menu already names, so both runners read the same words. */
const KNOWN_EFFORT_LABELS = {
  low: 'effortLow',
  medium: 'effortMedium',
  high: 'effortHigh',
  xhigh: 'effortXHigh',
  max: 'effortMax',
} as const satisfies Record<string, keyof Messages['thinking']>;

function sentenceCase(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * What a vendor's model is called in the menu.
 *
 * A name the vendor gave wins. A missing one (or one that is just the id again)
 * falls back to a sentence-case word, so `sonnet` reads `Sonnet` like the rest
 * of the menus; a versioned id such as `gpt-5.1-codex` is an identifier, not a
 * word, and is shown as sent.
 */
function modelLabel(candidate: { id: string; displayName?: string | undefined }): string {
  if (candidate.displayName && candidate.displayName !== candidate.id) return candidate.displayName;
  return /^[a-z]+$/.test(candidate.id) ? sentenceCase(candidate.id) : candidate.id;
}

/**
 * What a reasoning effort is called in the menu: the vendor's name, else the
 * words MangoStudio's own effort menu uses (`Low`, `Extra high`), else the id in
 * sentence case.
 */
function effortLabel(
  candidate: { id: string; displayName?: string | undefined },
  t: Messages
): string {
  if (candidate.displayName && candidate.displayName !== candidate.id) return candidate.displayName;
  const known = KNOWN_EFFORT_LABELS[candidate.id as keyof typeof KNOWN_EFFORT_LABELS];
  if (known) return t.thinking[known];
  return sentenceCase(candidate.id.replace(/[-_]+/g, ' '));
}

/** What the vendor advertised and did not mark `hidden`: the catalog the picker offers. */
function visibleModels(descriptor: ExternalAgentDescriptor | undefined) {
  return (descriptor?.models ?? []).filter((candidate) => candidate.hidden !== true);
}

/**
 * Whether {@link ExternalComposerControls} has anything to draw for this runner.
 *
 * Decided from the descriptor's data alone, not from `installed`: the hub already
 * answers `supportedConfigurations: []` and no models for a target that is not
 * there, and a vendor that is there but advertises neither would be an empty strip
 * all the same. An effort picker needs a visible model to belong to, so the
 * efforts add nothing to the test.
 */
export function hasExternalComposerControls(
  descriptor: ExternalAgentDescriptor | undefined
): boolean {
  return (
    visibleModels(descriptor).length > 0 || (descriptor?.supportedConfigurations.length ?? 0) > 0
  );
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
  onSelectionGone,
  onPermissionsChange,
}: ExternalComposerControlsProps) {
  const { t } = useI18n();
  const labels = t.externalAgents;

  const models = visibleModels(descriptor);
  const selectedModel =
    models.find((candidate) => candidate.id === model) ??
    models.find((candidate) => candidate.isDefault);
  const efforts = selectedModel?.supportedReasoningEfforts ?? [];
  const effortValue = effort ?? selectedModel?.defaultReasoningEffort ?? '';

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
   *
   * Reported as its own event rather than as two clears, because nobody picked
   * anything: a catalog this render happens to disagree with — another
   * account's, a vendor downgrade — must not make the chat forget the model the
   * user stored.
   */
  const selectionIsGone =
    model !== null && models.length > 0 && !models.some((candidate) => candidate.id === model);
  // Held in a ref because the call site is an inline closure: depending on it
  // directly would re-run this on every parent render.
  const goneRef = useRef(onSelectionGone);
  goneRef.current = onSelectionGone;
  useEffect(() => {
    if (!selectionIsGone) return;
    // Both halves at once: the effort vocabulary belonged to the model that
    // just went away.
    goneRef.current();
  }, [selectionIsGone]);

  if (!descriptor) return null;

  return (
    <>
      {models.length > 0 ? (
        <ChipSelect
          value={selectedModel?.id ?? ''}
          options={models.map((candidate) => ({
            value: candidate.id,
            label: modelLabel(candidate),
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
          value={effortValue}
          options={efforts.map((candidate) => ({
            value: candidate.id,
            label: effortLabel(candidate, t),
          }))}
          // A default the vendor did not list among the efforts still reads as a
          // word rather than as its id.
          placeholder={effortLabel({ id: effortValue }, t)}
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
        targetId={descriptor.targetId}
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
