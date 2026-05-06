/**
 * Parameter input field generated from a descriptor.
 */

import { useMemo } from 'react';
import type { ToolParameterDescriptor } from '@mangostudio/shared/tool-settings';
import { useI18n } from '@/hooks/use-i18n';
import { useModelCatalog } from '@/hooks/use-model-catalog';

interface ToolParameterFieldProps {
  descriptor: ToolParameterDescriptor;
  value: unknown;
  onChange: (value: unknown) => void;
  disabled: boolean;
}

function toSafeString(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return '';
}

export function ToolParameterField({
  descriptor,
  value,
  onChange,
  disabled,
}: ToolParameterFieldProps) {
  const { t } = useI18n();
  const { catalog } = useModelCatalog();

  const imageModels = useMemo(() => {
    const models = catalog.imageModels ?? [];
    // Group by provider
    const groups = new Map<string, typeof models>();
    for (const m of models) {
      const provider = m.provider ?? 'other';
      const list = groups.get(provider);
      if (list) {
        list.push(m);
      } else {
        groups.set(provider, [m]);
      }
    }
    return { models, groups };
  }, [catalog.imageModels]);

  const baseInputClass =
    'w-full rounded-xl px-4 py-2.5 text-sm bg-surface-container-lowest text-on-surface border border-outline-variant/20 placeholder:text-on-surface/30 focus:outline-none focus:border-primary/60 focus:ring-1 focus:ring-primary/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed';

  const descriptorValue = value ?? descriptor.defaultValue ?? '';

  // Model selector: backed by the catalog, not static options
  if (descriptor.modelType === 'image') {
    return (
      <div className="space-y-1">
        {descriptor.label && (
          <label className="text-sm text-on-surface-variant">{descriptor.label}</label>
        )}
        <select
          value={toSafeString(descriptorValue)}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          className={baseInputClass}
        >
          <option value="auto">{t.settings.tools.autoModelOption}</option>
          {[...imageModels.groups.entries()].map(([provider, models]) => (
            <optgroup key={provider} label={provider}>
              {models.map((m) => (
                <option key={m.modelId} value={m.modelId}>
                  {m.displayName}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </div>
    );
  }

  switch (descriptor.type) {
    case 'boolean': {
      return (
        <label className="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={Boolean(descriptorValue)}
            onChange={(e) => onChange(e.target.checked)}
            disabled={disabled}
            className="h-4 w-4 rounded border-outline-variant/30 accent-primary disabled:opacity-50 disabled:cursor-not-allowed"
          />
          {descriptor.label}
        </label>
      );
    }

    case 'number': {
      return (
        <div className="space-y-1">
          {descriptor.label && (
            <label className="text-sm text-on-surface-variant">{descriptor.label}</label>
          )}
          <input
            type="number"
            min={descriptor.min}
            max={descriptor.max}
            step={1}
            value={descriptorValue === '' ? '' : Number(descriptorValue)}
            onChange={(e) => onChange(e.target.value ? Number(e.target.value) : undefined)}
            disabled={disabled}
            placeholder={descriptor.description}
            className={baseInputClass}
          />
        </div>
      );
    }

    case 'select': {
      return (
        <div className="space-y-1">
          {descriptor.label && (
            <label className="text-sm text-on-surface-variant">{descriptor.label}</label>
          )}
          <select
            value={toSafeString(descriptorValue)}
            onChange={(e) => onChange(e.target.value)}
            disabled={disabled}
            className={baseInputClass}
          >
            {descriptor.options?.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
      );
    }

    default: {
      return (
        <div className="space-y-1">
          {descriptor.label && (
            <label className="text-sm text-on-surface-variant">{descriptor.label}</label>
          )}
          <input
            type="text"
            value={toSafeString(descriptorValue)}
            onChange={(e) => onChange(e.target.value)}
            disabled={disabled}
            placeholder={descriptor.description}
            className={baseInputClass}
          />
        </div>
      );
    }
  }
}
