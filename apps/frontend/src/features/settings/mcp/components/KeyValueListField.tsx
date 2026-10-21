/**
 * Editable key/value rows used for stdio env vars and http auth headers.
 */

import { Input } from '@/components/ui/Input';
import { useI18n } from '@/hooks/use-i18n';
import type { KeyValueEntry } from '../lib/server-form';
import { EntryList } from './EntryList';

interface KeyValueListFieldProps {
  label: string;
  hint?: string;
  entries: KeyValueEntry[];
  onChange: (entries: KeyValueEntry[]) => void;
  /** Masks the value column (used for write-only auth headers). */
  secretValues?: boolean;
}

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
    <EntryList
      label={label}
      hint={hint}
      entries={entries}
      onAdd={() => onChange([...entries, { key: '', value: '' }])}
      onRemove={(index) => onChange(entries.filter((_, i) => i !== index))}
      renderEntry={(entry, index) => (
        <>
          <div className="min-w-0 flex-1">
            <Input
              value={entry.key}
              onChange={(e) => updateEntry(index, { key: e.target.value })}
              placeholder={s.keyPlaceholder}
              aria-label={`${label} — ${s.keyPlaceholder}`}
            />
          </div>
          <div className="min-w-0 flex-1">
            <Input
              type={secretValues ? 'password' : 'text'}
              value={entry.value}
              onChange={(e) => updateEntry(index, { value: e.target.value })}
              placeholder={s.valuePlaceholder}
              aria-label={`${label} — ${s.valuePlaceholder}`}
            />
          </div>
        </>
      )}
    />
  );
}
