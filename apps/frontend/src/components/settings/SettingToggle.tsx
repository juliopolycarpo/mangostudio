import { Checkbox } from '@/components/ui/Checkbox';

interface SettingToggleProps {
  readonly label: string;
  readonly description: string;
  readonly checked: boolean;
  readonly onChange: (value: boolean) => void;
}

/**
 * Label-plus-description checkbox row used by the settings pages.
 *
 * Usage: <SettingToggle label={s.enableLabel} description={s.enableDescription} checked={enabled} onChange={setEnabled} />
 */
export function SettingToggle({ label, description, checked, onChange }: SettingToggleProps) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-4">
      <span className="space-y-1">
        <span className="block text-sm font-semibold text-on-surface">{label}</span>
        <span className="block text-sm text-on-surface-variant/60">{description}</span>
      </span>
      <Checkbox
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        aria-label={label}
        className="mt-1"
      />
    </label>
  );
}
