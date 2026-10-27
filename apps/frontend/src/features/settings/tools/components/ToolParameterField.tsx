/**
 * Parameter input field generated from a descriptor.
 */

import type { ToolParameterDescriptor } from '@mangostudio/shared/tool-settings';
import { Pencil, Trash2 } from 'lucide-react';
import { useId, useMemo, useState } from 'react';

import { SettingsField } from '@/components/settings/SettingsField';
import { SettingsRow } from '@/components/settings/SettingsRow';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { ToggleSwitch } from '@/components/ui/Toggle';
import { useI18n } from '@/hooks/use-i18n';
import { useModelCatalog } from '@/hooks/use-model-catalog';
import { ICON_SM } from '@/lib/icon-sizes';
import { cn } from '@/lib/utils';

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

/**
 * What the trigger reads when the stored value matches no option: the first
 * row's label, as a native `<select>` showed. A parameter that has never been
 * set, or one naming a model the catalog has since dropped, would otherwise
 * leave the trigger blank — the control would name nothing while still
 * reading as a chooser.
 *
 * It goes to `Select`'s `placeholder`, never to its `value`. `value` is what
 * `Select` compares each row against, and a row it believes is already chosen
 * commits nothing: routing the fallback through it would make the very row
 * shown on the trigger the one option the user could not pick.
 *
 * // Usage: fallbackLabel(options)
 */
function fallbackLabel(options: readonly { readonly label: string }[]): string | undefined {
  return options[0]?.label;
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

/**
 * The hint belongs to the input that adds a path, so it sits directly under it
 * and the paths already added hang below. The hint also says what an empty list
 * means, so there is no separate "nothing here" line between the two.
 */
function PathListField({
  value,
  onChange,
  disabled,
  ariaLabel,
  hint,
}: {
  value: unknown;
  onChange: (value: unknown) => void;
  disabled: boolean;
  ariaLabel: string;
  hint?: string;
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
      <div className="space-y-1">
        <div className="flex gap-2">
          <div className="min-w-0 flex-1">
            <Input
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
              placeholder={s.pathPlaceholder}
              aria-label={ariaLabel}
              className="font-mono text-xs"
            />
          </div>
          <Button variant="secondary" disabled={disabled || !newPath.trim()} onClick={handleAdd}>
            {s.add}
          </Button>
        </div>
        {hint ? <p className="text-xs text-fg-muted">{hint}</p> : null}
      </div>

      {items.length > 0 ? (
        <ul className="space-y-1">
          {items.map((item, index) => (
            <li
              key={item.path}
              className="flex items-center gap-2 rounded-sm border border-stroke bg-control px-2 py-1"
            >
              <Checkbox
                checked={item.enabled}
                onChange={() => handleToggle(index)}
                disabled={disabled}
              />
              {editingIndex === index ? (
                <div className="min-w-0 flex-1">
                  <Input
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
                    aria-label={s.edit}
                    className="font-mono text-xs"
                  />
                </div>
              ) : (
                <>
                  <span
                    className={cn(
                      'min-w-0 flex-1 break-all font-mono text-xs',
                      item.enabled ? 'text-fg' : 'text-fg-subtle line-through'
                    )}
                  >
                    {item.path}
                  </span>
                  <Button
                    variant="subtle"
                    size="icon-sm"
                    onClick={() => startEdit(index)}
                    disabled={disabled}
                    aria-label={s.edit}
                  >
                    <Pencil size={ICON_SM} />
                  </Button>
                  <Button
                    variant="subtle-danger"
                    size="icon-sm"
                    onClick={() => handleDelete(index)}
                    disabled={disabled}
                    aria-label={s.delete}
                    title={s.delete}
                  >
                    <Trash2 size={ICON_SM} />
                  </Button>
                </>
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function ToolParameterField({
  descriptor,
  value,
  onChange,
  disabled,
}: ToolParameterFieldProps) {
  const fieldId = useId();
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

  // A parameter's name is a field label like any other (14px/500), a weight step
  // under the tool's own 14px/600; the indented `stroke` rule carries the nesting,
  // so the name does not shrink as well.

  const descriptorValue = value ?? descriptor.defaultValue ?? '';

  // Model selector: backed by the catalog, not static options
  if (descriptor.modelType === 'image') {
    const modelOptions = [
      { value: 'auto', label: t.settings.tools.autoModelOption },
      // The provider was an `<optgroup>` heading; the panel carries it on
      // each row instead, which keeps one flat list for the keyboard to
      // arrow through.
      ...[...imageModels.groups.entries()].flatMap(([provider, models]) =>
        models.map((model) => ({
          value: model.modelId,
          label: model.displayName,
          description: provider,
        }))
      ),
    ];
    return (
      <SettingsRow
        label={label}
        hint={description}
        htmlFor={`${fieldId}-model`}
        layout="field"
        className="p-0"
      >
        <Select
          id={`${fieldId}-model`}
          value={toSafeString(descriptorValue)}
          onChange={onChange}
          ariaLabel={label}
          disabled={disabled}
          options={modelOptions}
          placeholder={fallbackLabel(modelOptions)}
        />
      </SettingsRow>
    );
  }

  switch (descriptor.type) {
    case 'boolean': {
      // The autosave makes this an immediate setting, so it is a switch. The
      // padding is the card's own: the row sits inside a tool's row.
      return (
        <SettingsRow as="label" label={label} hint={description} className="p-0">
          <ToggleSwitch
            checked={Boolean(descriptorValue)}
            onChange={(e) => onChange(e.target.checked)}
            disabled={disabled}
            aria-label={label}
          />
        </SettingsRow>
      );
    }

    case 'number': {
      return (
        <SettingsRow label={label} hint={description} htmlFor={`${fieldId}-number`} className="p-0">
          <Input
            id={`${fieldId}-number`}
            type="number"
            min={descriptor.min}
            max={descriptor.max}
            step={1}
            value={descriptorValue === '' ? '' : Number(descriptorValue)}
            onChange={(e) => onChange(e.target.value ? Number(e.target.value) : undefined)}
            disabled={disabled}
            className="w-32 text-center"
          />
        </SettingsRow>
      );
    }

    case 'select': {
      const options = descriptor.options ?? [];
      return (
        <SettingsRow
          label={label}
          hint={description}
          htmlFor={`${fieldId}-select`}
          layout="field"
          className="p-0"
        >
          <Select
            id={`${fieldId}-select`}
            value={toSafeString(descriptorValue)}
            onChange={onChange}
            ariaLabel={label}
            disabled={disabled}
            options={options}
            placeholder={fallbackLabel(options)}
          />
        </SettingsRow>
      );
    }

    case 'string_list': {
      const listValue = Array.isArray(descriptorValue)
        ? descriptorValue.join('\n')
        : toSafeString(descriptorValue);
      return (
        <SettingsField label={label} htmlFor={`${fieldId}-list`} hint={description}>
          <Textarea
            id={`${fieldId}-list`}
            value={listValue}
            onChange={(e) => {
              const lines = e.target.value
                .split('\n')
                .map((s) => s.trim())
                .filter((s) => s.length > 0);
              onChange(lines);
            }}
            disabled={disabled}
            rows={4}
          />
        </SettingsField>
      );
    }

    case 'path_list': {
      return (
        <SettingsField label={label}>
          <PathListField
            value={descriptorValue}
            onChange={onChange}
            disabled={disabled}
            ariaLabel={label}
            hint={description}
          />
        </SettingsField>
      );
    }

    default: {
      return (
        <SettingsRow
          label={label}
          hint={description}
          htmlFor={`${fieldId}-text`}
          layout="field"
          className="p-0"
        >
          <Input
            id={`${fieldId}-text`}
            type="text"
            value={toSafeString(descriptorValue)}
            onChange={(e) => onChange(e.target.value)}
            disabled={disabled}
          />
        </SettingsRow>
      );
    }
  }
}
