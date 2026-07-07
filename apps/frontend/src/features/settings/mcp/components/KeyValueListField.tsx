/**
 * Editable key/value rows used for stdio env vars and http auth headers.
 */

import { Plus, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useI18n } from '@/hooks/use-i18n';
import type { KeyValueEntry } from '../lib/server-form';

interface KeyValueListFieldProps {
  label: string;
  hint?: string;
  entries: KeyValueEntry[];
  onChange: (entries: KeyValueEntry[]) => void;
  /** Masks the value column (used for write-only auth headers). */
  secretValues?: boolean;
}

const inputClassName = `
  flex-1 min-w-0 rounded-xl px-3 py-2 text-sm
  bg-surface-container-high text-on-surface
  border border-outline-variant/20
  placeholder:text-on-surface/30
  focus:outline-none focus:border-primary/60 focus:ring-1 focus:ring-primary/20
  transition-colors
`.trim();

export function KeyValueListField({
  label,
  hint,
  entries,
  onChange,
  secretValues = false,
}: KeyValueListFieldProps) {
  const { t } = useI18n();
  const s = t.settings.mcp;

  const updateEntry = (index: number, patch: Partial<KeyValueEntry>) => {
    onChange(entries.map((entry, i) => (i === index ? { ...entry, ...patch } : entry)));
  };

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm font-medium text-on-surface-variant">{label}</span>
      {hint && <p className="text-xs text-on-surface-variant/60">{hint}</p>}
      <div className="space-y-2">
        {entries.map((entry, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: rows have no stable identity while being typed
          <div key={index} className="flex items-center gap-2">
            <input
              value={entry.key}
              onChange={(e) => updateEntry(index, { key: e.target.value })}
              placeholder={s.keyPlaceholder}
              aria-label={`${label} — ${s.keyPlaceholder}`}
              className={inputClassName}
            />
            <input
              type={secretValues ? 'password' : 'text'}
              value={entry.value}
              onChange={(e) => updateEntry(index, { value: e.target.value })}
              placeholder={s.valuePlaceholder}
              aria-label={`${label} — ${s.valuePlaceholder}`}
              className={inputClassName}
            />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label={s.removeEntry}
              onClick={() => onChange(entries.filter((_, i) => i !== index))}
            >
              <X size={14} />
            </Button>
          </div>
        ))}
      </div>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="self-start"
        onClick={() => onChange([...entries, { key: '', value: '' }])}
      >
        <Plus size={14} />
        {s.addEntry}
      </Button>
    </div>
  );
}
