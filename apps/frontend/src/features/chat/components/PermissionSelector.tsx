/**
 * What the agent may do, and who answers when it asks.
 *
 * Two axes, and only the pairs the adapter said it supports. That is the whole
 * reason `supportedConfigurations` is a list of pairs rather than two
 * independent lists: Codex keeps the axes separate, Cursor exposes session modes
 * and Claude collapses both onto one account-gated flag, so two free controls
 * would happily compose a combination no vendor offers and then send it.
 *
 * A pair the vendor refuses renders **disabled with its reason**, not hidden.
 * For Codex those include profiles the machine's own config forbids, and that
 * has to read as a policy refusal — the user is not looking at a MangoStudio
 * limitation, they are looking at something their admin decided.
 *
 * The unattended warning applies to `full-access` *and* to `auto-review`. Both
 * mean the agent proceeds without the user; softening either would be the one
 * place in this UI where understating the risk is actively dangerous.
 *
 * **Presets sit above the matrix, and the matrix moves behind a disclosure.**
 * Two axes is an honest model and also two questions a non-expert did not ask;
 * what they want to say is how much the agent should bother them. The matrix is
 * not removed — it is what anyone who does want the axes reaches for, and it is
 * what a stored custom pair is edited with. The disclosure lives inside this
 * component's own panel because the design system has no popover to nest, and
 * generalizing the hand-rolled one here is cheaper than adding one.
 */

import type {
  ExternalAgentTargetId,
  ExternalApprovalRouting,
  ExternalPermissionLevel,
  ExternalPermissionPair,
  ExternalSupportedConfiguration,
} from '@mangostudio/shared/external-agents';
import {
  EXTERNAL_APPROVAL_ROUTINGS,
  EXTERNAL_PERMISSION_LEVELS,
  EXTERNAL_PERMISSION_PRESETS,
  externalPresetFor,
  externalPresetPair,
} from '@mangostudio/shared/external-agents';
import { AlertTriangle, Check, ChevronDown, Lock } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { MicroLabel } from '@/components/ui/MicroLabel';
import { useI18n } from '@/hooks/use-i18n';
import { ICON_SM } from '@/lib/icon-sizes';
import { cn } from '@/lib/utils';
import { ComposerPopover } from './ComposerPopover';

export interface PermissionSelectorProps {
  configurations: readonly ExternalSupportedConfiguration[];
  /** The effective pair once a session exists, not the requested one. */
  level: ExternalPermissionLevel;
  routing: ExternalApprovalRouting;
  /** Needed for the per-vendor line: `careful` is a sandbox here and plan mode there. */
  targetId: ExternalAgentTargetId;
  disabled?: boolean;
  onChange: (next: { level: ExternalPermissionLevel; routing: ExternalApprovalRouting }) => void;
}

export function PermissionSelector({
  configurations,
  level,
  routing,
  targetId,
  disabled = false,
  onChange,
}: PermissionSelectorProps) {
  const { t } = useI18n();
  const labels = t.externalAgents.permission;
  const [open, setOpen] = useState(false);
  // Read once, above the hooks: it is the selected row below, it seeds the
  // matrix, and it is what the effect watches. `externalPresetFor` is a pure
  // lookup, so it can sit here rather than beside the preset list — which is
  // after this component's early return, where a hook may not go.
  const selectedPreset = externalPresetFor({ level, routing });
  // A pair no preset names is a deliberate custom choice, so the axes it was
  // made with are what should be on screen — telling that user their setting
  // vanished would be worse than showing one more control.
  const [showMatrix, setShowMatrix] = useState(selectedPreset === undefined);
  const containerRef = useRef<HTMLDivElement>(null);

  // Re-opened when a *later* pair turns out to be custom, because this
  // component instance outlives the chat it was mounted for: switching to a
  // chat stored on `full-access × auto-review` would otherwise show three
  // presets with none selected and no way to see what is actually set. Only
  // ever opens — a user who expanded the matrix on a preset keeps it expanded.
  useEffect(() => {
    if (selectedPreset === undefined) setShowMatrix(true);
  }, [selectedPreset]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  // Only what the adapter returned. A level or routing it never mentioned is not
  // a choice this vendor has, so it is not a control.
  const levels = EXTERNAL_PERMISSION_LEVELS.filter((candidate) =>
    configurations.some((configuration) => configuration.level === candidate)
  );
  const routings = EXTERNAL_APPROVAL_ROUTINGS.filter((candidate) =>
    configurations.some((configuration) => configuration.routing === candidate)
  );

  if (levels.length === 0 && routings.length === 0) return null;

  const find = (
    candidateLevel: ExternalPermissionLevel,
    candidateRouting: ExternalApprovalRouting
  ) =>
    configurations.find(
      (configuration) =>
        configuration.level === candidateLevel && configuration.routing === candidateRouting
    );

  /**
   * A level is offered when *some* supported pair uses it. Picking it moves the
   * other axis to a routing that composes, rather than leaving the user on a
   * combination nothing supports.
   */
  const routingFor = (candidateLevel: ExternalPermissionLevel): ExternalApprovalRouting => {
    if (find(candidateLevel, routing)?.supported) return routing;
    return (
      configurations.find(
        (configuration) => configuration.level === candidateLevel && configuration.supported
      )?.routing ?? routing
    );
  };
  const levelFor = (candidateRouting: ExternalApprovalRouting): ExternalPermissionLevel => {
    if (find(level, candidateRouting)?.supported) return level;
    return (
      configurations.find(
        (configuration) => configuration.routing === candidateRouting && configuration.supported
      )?.level ?? level
    );
  };

  const active = find(level, routing);
  const unattended = active?.unattended === true;

  // Only presets this vendor can actually run. One with no supported candidate
  // is absent rather than disabled: a control that cannot work reads as a
  // MangoStudio fault, not as something this vendor does not do.
  const presets = EXTERNAL_PERMISSION_PRESETS.flatMap((preset) => {
    const pair = externalPresetPair(preset, configurations);
    return pair ? [{ id: preset.id, pair }] : [];
  });
  const hasPresets = presets.length > 0;

  return (
    <div ref={containerRef} className="relative flex items-center">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={labels.label}
        className="composer-chip max-w-[13rem] disabled:opacity-50"
      >
        {unattended ? (
          <AlertTriangle size={ICON_SM} className="shrink-0 text-warning" />
        ) : (
          <Lock size={ICON_SM} className="composer-chip-icon shrink-0" />
        )}
        <span className="composer-chip-key text-fg-muted">{`${labels.modeKey}:`}</span>
        <span className={cn('composer-chip-value', unattended && 'text-warning')}>
          {labels.levelName[level]}
        </span>
        <ChevronDown size={ICON_SM} className="shrink-0" />
      </button>

      {open ? (
        <ComposerPopover className="max-h-[70vh] space-y-3 overflow-y-auto p-3">
          {hasPresets ? (
            <Axis heading={labels.presetHeading}>
              {presets.map((preset) => (
                <Option
                  key={preset.id}
                  name={labels.preset[preset.id].label}
                  description={`${labels.preset[preset.id].description} ${
                    labels.presetVendor[preset.id][targetId]
                  }`}
                  selected={selectedPreset === preset.id}
                  supported
                  unsupportedReason={null}
                  // Which warning depends on which axis this preset resolved
                  // to, not on the preset. `autonomous` falling back to
                  // `default × auto-review` cannot leave the workspace, so the
                  // level warning would be false there — the true statement is
                  // that its approvals are answered without the user.
                  warning={unattendedWarning(preset.pair, find, labels)}
                  onSelect={() => onChange(preset.pair)}
                />
              ))}
            </Axis>
          ) : null}

          {hasPresets ? (
            <button
              type="button"
              onClick={() => setShowMatrix((value) => !value)}
              aria-expanded={showMatrix}
              className="flex h-7 w-full items-center gap-1 rounded-sm px-1 text-xs text-fg-muted transition-colors hover:bg-fill-hover hover:text-fg"
            >
              <ChevronDown size={ICON_SM} className={cn('shrink-0', !showMatrix && '-rotate-90')} />
              {labels.advanced}
            </button>
          ) : null}

          {showMatrix || !hasPresets ? (
            <>
              <Axis heading={labels.whatItCanDo}>
                {levels.map((candidate) => {
                  const configuration = find(candidate, routingFor(candidate));
                  return (
                    <Option
                      key={candidate}
                      name={labels.levelName[candidate]}
                      description={labels.level[candidate]}
                      selected={level === candidate}
                      supported={configuration?.supported === true}
                      unsupportedReason={reasonText(configuration, t)}
                      warning={configuration?.unattended ? labels.unattendedLevelWarning : null}
                      onSelect={() =>
                        onChange({ level: candidate, routing: routingFor(candidate) })
                      }
                    />
                  );
                })}
              </Axis>

              <Axis heading={labels.whoApproves}>
                {routings.map((candidate) => {
                  const configuration = find(levelFor(candidate), candidate);
                  return (
                    <Option
                      key={candidate}
                      name={labels.routingName[candidate]}
                      description={labels.routing[candidate]}
                      selected={routing === candidate}
                      supported={configuration?.supported === true}
                      unsupportedReason={reasonText(configuration, t)}
                      warning={candidate === 'auto-review' ? labels.unattendedRoutingWarning : null}
                      onSelect={() => onChange({ level: levelFor(candidate), routing: candidate })}
                    />
                  );
                })}
              </Axis>
            </>
          ) : null}
        </ComposerPopover>
      ) : null}
    </div>
  );
}

/**
 * The warning an unattended pair earns, chosen by the axis that makes it so.
 *
 * Both axes mean "the agent proceeds without you" and they mean different
 * things about *what* it may do: `full-access` can act outside the workspace,
 * `auto-review` answers its own approvals inside it. Saying the wrong one is
 * either overstating the risk or — worse — understating it.
 */
function unattendedWarning(
  pair: ExternalPermissionPair,
  find: (
    level: ExternalPermissionLevel,
    routing: ExternalApprovalRouting
  ) => ExternalSupportedConfiguration | undefined,
  labels: ReturnType<typeof useI18n>['t']['externalAgents']['permission']
): string | null {
  if (!find(pair.level, pair.routing)?.unattended) return null;
  return pair.routing === 'auto-review'
    ? labels.unattendedRoutingWarning
    : labels.unattendedLevelWarning;
}

function Axis({ heading, children }: { heading: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      {/* The capitals are the micro-label class's, not the catalog's: a screen
          reader announcing an all-caps string letter by letter is reading
          styling, and a locale that does not want capitals for this role can
          drop the class without rewriting its copy. */}
      <MicroLabel as="p" className="px-2">
        {heading}
      </MicroLabel>
      {children}
    </div>
  );
}

function Option({
  name,
  description,
  selected,
  supported,
  unsupportedReason,
  warning,
  onSelect,
}: {
  name: string;
  description: string;
  selected: boolean;
  supported: boolean;
  unsupportedReason: string | null;
  warning: string | null;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      disabled={!supported}
      onClick={onSelect}
      className={cn(
        'flex w-full items-start gap-2 rounded-sm px-2 py-2 text-left transition-colors disabled:cursor-not-allowed',
        selected ? 'bg-fill-selected' : 'enabled:hover:bg-fill-hover'
      )}
    >
      {/* A fixed column, so the check and the empty circle sit on one axis down
          the list. */}
      <span
        className={cn(
          'mt-0.5 flex size-4 shrink-0 items-center justify-center',
          selected ? 'text-accent-fg' : 'text-fg-muted'
        )}
      >
        {selected ? <Check size={ICON_SM} /> : '○'}
      </span>
      <span className="min-w-0 flex-1 space-y-0.5">
        {/* A refused pair is not faded: the reason under it is the thing to read.
            The name steps down a text colour instead. */}
        <span className={cn('block text-sm font-medium', supported ? 'text-fg' : 'text-fg-muted')}>
          {name}
        </span>
        <span className="block text-xs text-fg-muted">{description}</span>
        {!supported && unsupportedReason ? (
          <span className="block text-xs text-fg-muted">{unsupportedReason}</span>
        ) : null}
        {supported && warning ? (
          // The glyph carries the tone and the words stay in the primary text
          // colour — one step above the description they follow, so the risk
          // is never the quietest line in the row.
          <span className="flex items-start gap-1 text-xs text-fg">
            <AlertTriangle size={ICON_SM} className="mt-px shrink-0 text-warning" />
            {warning}
          </span>
        ) : null}
      </span>
    </button>
  );
}

/**
 * The adapter's own explanation, looked up in the dictionary.
 *
 * The key is the vendor's reason for refusing, so an unknown one falls back to a
 * generic line rather than rendering a raw i18n key at the user.
 */
function reasonText(
  configuration: ExternalSupportedConfiguration | undefined,
  t: ReturnType<typeof useI18n>['t']
): string | null {
  if (!configuration || configuration.supported) return null;
  const key = configuration.unsupportedReasonKey?.split('.').at(-1);
  const known = key
    ? (t.externalAgents.unsupported as Record<string, string | undefined>)[key]
    : undefined;
  return known ?? t.externalAgents.permission.unsupportedGeneric;
}
