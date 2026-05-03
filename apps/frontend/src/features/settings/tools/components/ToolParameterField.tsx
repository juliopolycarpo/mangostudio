/**
 * Parameter input field generated from a descriptor.
 */

import type { ToolParameterDescriptor } from '@mangostudio/shared/tool-settings';

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
  const baseInputClass =
    'w-full rounded-xl px-4 py-2.5 text-sm bg-surface-container-lowest text-on-surface border border-outline-variant/20 placeholder:text-on-surface/30 focus:outline-none focus:border-primary/60 focus:ring-1 focus:ring-primary/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed';

  const descriptorValue = value ?? descriptor.defaultValue ?? '';

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
