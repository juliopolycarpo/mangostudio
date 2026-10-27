import { ToggleSwitch } from '@/components/ui/Toggle';

import { SettingsRow } from './SettingsRow';

interface SettingToggleProps {
  readonly label: string;
  readonly description?: string;
  readonly checked: boolean;
  readonly onChange: (value: boolean) => void;
}

/**
 * A `SettingsRow` whose control is a switch: name and hint on the left, the
 * switch on the right, and the whole row is the click target. Settings save as
 * they change, so the control is a switch rather than a checkbox.
 *
 * Usage: <SettingToggle label={s.enableLabel} description={s.enableDescription} checked={enabled} onChange={setEnabled} />
 */
export function SettingToggle({ label, description, checked, onChange }: SettingToggleProps) {
  return (
    <SettingsRow as="label" label={label} hint={description}>
      <ToggleSwitch
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        aria-label={label}
      />
    </SettingsRow>
  );
}
