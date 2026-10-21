/**
 * A list of editable rows with a remove button on each and an Add button under
 * them — the shape shared by a command's arguments and its key/value pairs.
 */

import { Plus, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { SettingsField } from '@/components/settings/SettingsField';
import { Button } from '@/components/ui/Button';
import { useI18n } from '@/hooks/use-i18n';
import { ICON_MD, ICON_SM } from '@/lib/icon-sizes';

interface EntryListProps<T> {
  readonly label: string;
  readonly hint?: string;
  readonly entries: readonly T[];
  /** The fields of one row, each in a `min-w-0 flex-1` box so the row shares its width. */
  readonly renderEntry: (entry: T, index: number) => ReactNode;
  readonly onAdd: () => void;
  readonly onRemove: (index: number) => void;
}

export function EntryList<T>({
  label,
  hint,
  entries,
  renderEntry,
  onAdd,
  onRemove,
}: EntryListProps<T>) {
  const { t } = useI18n();
  const s = t.settings.mcp;

  return (
    <SettingsField label={label} hint={hint}>
      {entries.length > 0 && (
        <div className="space-y-2">
          {entries.map((entry, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: rows have no stable identity while being typed
            <div key={index} className="flex items-center gap-2">
              {renderEntry(entry, index)}
              <Button
                type="button"
                variant="subtle"
                size="icon"
                aria-label={s.removeEntry}
                onClick={() => onRemove(index)}
              >
                <X size={ICON_MD} />
              </Button>
            </div>
          ))}
        </div>
      )}
      <Button type="button" variant="subtle" size="sm" className="self-start" onClick={onAdd}>
        <Plus size={ICON_SM} />
        {s.addEntry}
      </Button>
    </SettingsField>
  );
}
