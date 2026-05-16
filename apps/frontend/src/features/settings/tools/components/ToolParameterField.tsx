/**
 * Parameter input field generated from a descriptor.
 */

import type { ToolParameterDescriptor } from '@mangostudio/shared/tool-settings';
import { Pencil, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { useI18n } from '@/hooks/use-i18n';
import { useModelCatalog } from '@/hooks/use-model-catalog';

interface ToolParameterFieldProps {
  descriptor: ToolParameterDescriptor;
  value: unknown;
  onChange: (value: unknown) => void;
  disabled: boolean;
}

interface PathListItem {
  path: string;
  enabled: boolean;
}

function toSafeString(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return '';
}

function isPathListItem(item: unknown): item is PathListItem {
  return (
    typeof item === 'object' &&
    item !== null &&
    'path' in item &&
    typeof (item as Record<string, unknown>).path === 'string' &&
    'enabled' in item &&
    typeof (item as Record<string, unknown>).enabled === 'boolean'
  );
}

function isPathListItemArray(value: unknown): value is PathListItem[] {
  return Array.isArray(value) && value.every(isPathListItem);
}

function PathListField({
  value,
  onChange,
  disabled,
  placeholder,
}: {
  value: unknown;
  onChange: (value: unknown) => void;
  disabled: boolean;
  placeholder?: string;
}) {
  const { t } = useI18n();
  const s = t.settings.tools.pathList;

  const items = isPathListItemArray(value) ? value : [];
  const [newPath, setNewPath] = useState('');
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editingPath, setEditingPath] = useState('');

  const handleAdd = () => {
    const trimmed = newPath.trim();
    if (!trimmed) return;
    if (items.some((item) => item.path === trimmed)) return;
    onChange([...items, { path: trimmed, enabled: true }]);
    setNewPath('');
  };

  const handleToggle = (index: number) => {
    const updated = items.map((item, i) =>
      i === index ? { ...item, enabled: !item.enabled } : item
    );
    onChange(updated);
  };

  const handleDelete = (index: number) => {
    onChange(items.filter((_, i) => i !== index));
  };

  const startEdit = (index: number) => {
    setEditingIndex(index);
    setEditingPath(items[index].path);
  };

  const saveEdit = () => {
    if (editingIndex === null) return;
    const trimmed = editingPath.trim();
    if (!trimmed) return;
    if (items.some((item, i) => i !== editingIndex && item.path === trimmed)) return;
    const updated = items.map((item, i) =>
      i === editingIndex ? { ...item, path: trimmed } : item
    );
    onChange(updated);
    setEditingIndex(null);
    setEditingPath('');
  };

  const cancelEdit = () => {
    setEditingIndex(null);
    setEditingPath('');
  };

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <input
          type="text"
          value={newPath}
          onChange={(e) => setNewPath(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              handleAdd();
            }
          }}
          disabled={disabled}
          placeholder={placeholder}
          className="flex-1 rounded-xl px-4 py-2.5 text-sm bg-surface-container-lowest text-on-surface border border-outline-variant/20 placeholder:text-on-surface/30 focus:outline-none focus:border-primary/60 focus:ring-1 focus:ring-primary/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        />
        <Button
          variant="secondary"
          size="sm"
          disabled={disabled || !newPath.trim()}
          onClick={handleAdd}
        >
          {s.add}
        </Button>
      </div>

      {items.length === 0 ? (
        <p className="text-sm text-on-surface-variant/40 py-2">{s.noPaths}</p>
      ) : (
        <ul className="space-y-1.5">
          {items.map((item, index) => (
            <li
              key={item.path}
              className="flex items-center gap-2 p-2 rounded-lg bg-surface-container-lowest border border-outline-variant/10"
            >
              <input
                type="checkbox"
                checked={item.enabled}
                onChange={() => handleToggle(index)}
                disabled={disabled}
                className="h-4 w-4 rounded border-outline-variant/30 accent-primary shrink-0 disabled:opacity-50 disabled:cursor-not-allowed"
              />
              {editingIndex === index ? (
                <>
                  <input
                    type="text"
                    value={editingPath}
                    onChange={(e) => setEditingPath(e.target.value)}
                    onBlur={saveEdit}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        saveEdit();
                      }
                      if (e.key === 'Escape') {
                        cancelEdit();
                      }
                    }}
                    className="flex-1 rounded-lg px-3 py-1.5 text-sm bg-surface-container-lowest text-on-surface border border-outline-variant/20 focus:outline-none focus:border-primary/60 focus:ring-1 focus:ring-primary/20"
                    autoFocus
                  />
                </>
              ) : (
                <>
                  <span
                    className={`flex-1 text-sm ${item.enabled ? 'text-on-surface' : 'text-on-surface-variant/40 line-through'}`}
                  >
                    {item.path}
                  </span>
                  <button
                    onClick={() => startEdit(index)}
                    disabled={disabled}
                    className="p-1.5 rounded-md text-on-surface-variant hover:bg-surface-container-high disabled:opacity-50 disabled:cursor-not-allowed"
                    aria-label={s.edit}
                  >
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => handleDelete(index)}
                    disabled={disabled}
                    className="p-1.5 rounded-md text-danger hover:bg-danger/10 disabled:opacity-50 disabled:cursor-not-allowed"
                    aria-label={s.delete}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
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

  const label = useMemo(() => {
    if (descriptor.name === 'letAiDecideQuality') {
      return t.settings.tools.letAiDecideQualityLabel;
    }
    if (descriptor.name === 'allowedPaths') {
      return t.settings.tools.parameters.allowedPathsLabel;
    }
    if (descriptor.name === 'deniedPaths') {
      return t.settings.tools.parameters.deniedPathsLabel;
    }
    return descriptor.label;
  }, [descriptor.name, descriptor.label, t]);

  const description = useMemo(() => {
    if (descriptor.name === 'letAiDecideQuality') {
      return t.settings.tools.letAiDecideQualityDescription;
    }
    if (descriptor.name === 'allowedPaths') {
      return t.settings.tools.parameters.allowedPathsDescription;
    }
    if (descriptor.name === 'deniedPaths') {
      return t.settings.tools.parameters.deniedPathsDescription;
    }
    return descriptor.description;
  }, [descriptor.name, descriptor.description, t]);

  const baseInputClass =
    'w-full rounded-xl px-4 py-2.5 text-sm bg-surface-container-lowest text-on-surface border border-outline-variant/20 placeholder:text-on-surface/30 focus:outline-none focus:border-primary/60 focus:ring-1 focus:ring-primary/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed';

  const descriptorValue = value ?? descriptor.defaultValue ?? '';

  // Model selector: backed by the catalog, not static options
  if (descriptor.modelType === 'image') {
    return (
      <div className="space-y-1">
        {label && <label className="text-sm text-on-surface-variant">{label}</label>}
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
          {label}
        </label>
      );
    }

    case 'number': {
      return (
        <div className="space-y-1">
          {label && <label className="text-sm text-on-surface-variant">{label}</label>}
          <input
            type="number"
            min={descriptor.min}
            max={descriptor.max}
            step={1}
            value={descriptorValue === '' ? '' : Number(descriptorValue)}
            onChange={(e) => onChange(e.target.value ? Number(e.target.value) : undefined)}
            disabled={disabled}
            placeholder={description}
            className={baseInputClass}
          />
        </div>
      );
    }

    case 'select': {
      return (
        <div className="space-y-1">
          {label && <label className="text-sm text-on-surface-variant">{label}</label>}
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

    case 'string_list': {
      const listValue = Array.isArray(descriptorValue)
        ? // biome-ignore lint/nursery/noBaseToString: Migrated from ESLint
          descriptorValue.join('\n')
        : toSafeString(descriptorValue);
      return (
        <div className="space-y-1">
          {label && <label className="text-sm text-on-surface-variant">{label}</label>}
          <textarea
            value={listValue}
            onChange={(e) => {
              const lines = e.target.value
                .split('\n')
                .map((s) => s.trim())
                .filter((s) => s.length > 0);
              onChange(lines);
            }}
            disabled={disabled}
            placeholder={description}
            rows={4}
            className={`${baseInputClass} resize-y`}
          />
        </div>
      );
    }

    case 'path_list': {
      return (
        <div className="space-y-1">
          {label && <label className="text-sm text-on-surface-variant">{label}</label>}
          <PathListField
            value={descriptorValue}
            onChange={onChange}
            disabled={disabled}
            placeholder={description}
          />
        </div>
      );
    }

    default: {
      return (
        <div className="space-y-1">
          {label && <label className="text-sm text-on-surface-variant">{label}</label>}
          <input
            type="text"
            value={toSafeString(descriptorValue)}
            onChange={(e) => onChange(e.target.value)}
            disabled={disabled}
            placeholder={description}
            className={baseInputClass}
          />
        </div>
      );
    }
  }
}
