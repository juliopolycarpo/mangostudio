/**
 * The container configuration form, shared by the add dialog and the card.
 *
 * One component because the two surfaces edit the same thing, and the mount
 * editor in particular is where a divergence would be expensive: a rule
 * enforced in one place and not the other reads as the feature being broken in
 * whichever one is laxer.
 */

import type { ContainerDetection, ContainerEngine } from '@mangostudio/shared/environments';
import { CONTAINER_MAX_MOUNTS } from '@mangostudio/shared/environments';
import { Plus, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';
import {
  type ContainerFormError,
  type ContainerFormFields,
  type ContainerMountIssue,
  emptyContainerMount,
} from '../container-form';

const ENGINES: readonly ContainerEngine[] = ['docker', 'podman'];

interface ContainerConfigFieldsProps {
  readonly idPrefix: string;
  readonly form: ContainerFormFields;
  /** Every field's verdict, so one bad field cannot hide another's message. */
  readonly errors: readonly ContainerFormError[];
  /** Detection result, when the surface has one; absent hides availability copy. */
  readonly detection?: ContainerDetection | undefined;
  readonly onChange: (patch: Partial<ContainerFormFields>) => void;
}

export function ContainerConfigFields({
  idPrefix,
  form,
  errors,
  detection,
  onChange,
}: ContainerConfigFieldsProps) {
  const { t } = useI18n();
  const labels = t.environments.entities.container;
  const optional = t.environments.entities.add.optional;
  const errorFor = (field: ContainerFormError['field']): ContainerFormError | undefined =>
    errors.find((entry) => entry.field === field);
  const mountError = errorFor('mounts');
  const mountIssueMessage = (issue: ContainerMountIssue | undefined): string => {
    switch (issue) {
      case 'too-long':
        return labels.mountTooLong;
      case 'container-path':
        return labels.mountContainerInvalid;
      default:
        return labels.mountIncomplete;
    }
  };

  const setMount = (index: number, patch: Partial<ContainerFormFields['mounts'][number]>): void => {
    onChange({
      mounts: form.mounts.map((mount, at) => (at === index ? { ...mount, ...patch } : mount)),
    });
  };

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <Input
          id={`${idPrefix}-image`}
          label={labels.imageLabel}
          placeholder="node:22"
          value={form.image}
          error={form.image.trim() && errorFor('image') ? labels.imageInvalid : undefined}
          onChange={(event) => onChange({ image: event.target.value })}
        />
        <p className="text-[11px] text-on-surface-variant/60">{labels.imageHint}</p>
      </div>

      <div className="space-y-1">
        <p className="font-medium text-on-surface-variant text-xs">{labels.engineLabel}</p>
        <div className="flex gap-2">
          {ENGINES.map((engine) => {
            const status = detection?.engines.find((entry) => entry.engine === engine);
            const unavailable = status !== undefined && !status.available;
            return (
              <button
                key={engine}
                type="button"
                aria-pressed={form.engine === engine}
                onClick={() => onChange({ engine })}
                className={`flex-1 rounded-xl border px-3 py-2 text-left text-xs transition-colors ${
                  form.engine === engine
                    ? 'border-primary/45 bg-primary/10 text-on-surface'
                    : 'border-outline-variant/20 text-on-surface-variant/70 hover:bg-surface-container-highest'
                }`}
              >
                <span className="font-semibold">{labels.engine[engine]}</span>
                <span className="mt-0.5 block text-[10px] text-on-surface-variant/60">
                  {status?.available
                    ? (status.version ?? labels.engineReady)
                    : unavailable
                      ? labels.engineUnavailable
                      : ''}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <label className="flex items-start gap-2 text-xs text-on-surface-variant">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={!form.network}
          onChange={(event) => onChange({ network: !event.target.checked })}
        />
        <span>
          <span className="font-medium text-on-surface">{labels.networkOffLabel}</span>
          <span className="mt-0.5 block text-[11px] text-on-surface-variant/60">
            {labels.networkOffHint}
          </span>
        </span>
      </label>

      <div className="grid gap-2 sm:grid-cols-2">
        <Input
          id={`${idPrefix}-cpus`}
          label={`${labels.cpusLabel} · ${optional}`}
          inputMode="decimal"
          placeholder="2"
          value={form.cpus}
          error={errorFor('cpus') ? labels.cpusInvalid : undefined}
          onChange={(event) => onChange({ cpus: event.target.value })}
        />
        <Input
          id={`${idPrefix}-memory`}
          label={`${labels.memoryLabel} · ${optional}`}
          inputMode="numeric"
          placeholder="2048"
          value={form.memoryMib}
          error={errorFor('memoryMib') ? labels.memoryInvalid : undefined}
          onChange={(event) => onChange({ memoryMib: event.target.value })}
        />
      </div>
      <p className="text-[11px] text-on-surface-variant/60">{labels.limitsHint}</p>

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <p className="font-medium text-on-surface-variant text-xs">{labels.mountsLabel}</p>
          <Button
            variant="secondary"
            className="h-7 gap-1 px-2 text-[11px]"
            disabled={form.mounts.length >= CONTAINER_MAX_MOUNTS}
            onClick={() => onChange({ mounts: [...form.mounts, emptyContainerMount()] })}
          >
            <Plus size={12} />
            {labels.mountAdd}
          </Button>
        </div>
        <p className="text-[11px] text-on-surface-variant/60">{labels.mountsHint}</p>

        {form.mounts.map((mount, index) => (
          <div
            // Rows are positional and can be identical while being typed, so the
            // index is the only stable identity a row has here.
            // biome-ignore lint/suspicious/noArrayIndexKey: positional rows with no id of their own
            key={index}
            className="grid items-end gap-2 rounded-xl border border-outline-variant/20 p-2 sm:grid-cols-[1fr_1fr_auto]"
          >
            <Input
              id={`${idPrefix}-mount-host-${index}`}
              label={labels.mountHostLabel}
              value={mount.hostPath}
              onChange={(event) => setMount(index, { hostPath: event.target.value })}
            />
            <Input
              id={`${idPrefix}-mount-container-${index}`}
              label={labels.mountContainerLabel}
              value={mount.containerPath}
              onChange={(event) => setMount(index, { containerPath: event.target.value })}
            />
            <div className="flex items-center gap-2 pb-2">
              <label className="flex items-center gap-1 text-[11px] text-on-surface-variant">
                <input
                  type="checkbox"
                  checked={mount.readonly}
                  onChange={(event) => setMount(index, { readonly: event.target.checked })}
                />
                {labels.mountReadonly}
              </label>
              <button
                type="button"
                aria-label={labels.mountRemove}
                className="rounded-lg p-1 text-on-surface-variant/70 hover:bg-surface-container-highest"
                onClick={() => onChange({ mounts: form.mounts.filter((_row, at) => at !== index) })}
              >
                <X size={14} />
              </button>
            </div>
          </div>
        ))}

        {mountError ? (
          <p className="text-[11px] text-error" role="alert">
            {mountError.refusal
              ? formatMessage(
                  labels.mountRefusal[mountError.refusal.code],
                  mountError.refusal.params
                )
              : mountIssueMessage(mountError.mountIssue)}
          </p>
        ) : null}
      </div>
    </div>
  );
}
