import type {
  PromptInjectionRole,
  PromptSendFrequency,
  RuleFileSetting,
} from '@mangostudio/shared/prompt-rules';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Toggle, ToggleSwitch } from '@/components/ui/Toggle';
import { SettingsRow } from './SettingsRow';
import { SettingsSegmented } from './SettingsSegmented';

interface RuleFileRowsProps {
  setting: RuleFileSetting;
  isFixed?: boolean;
  onUpdate: (updates: Partial<RuleFileSetting>) => void;
  onRemove?: () => void;
  labels: {
    enabledLabel: string;
    injectionRoleLabel: string;
    injectionRoleSystem: string;
    injectionRoleUser: string;
    frequencyLabel: string;
    frequencyFirstTurn: string;
    frequencyHint: string;
    frequencyEveryTurn: string;
    removeRule: string;
    rulePathLabel: string;
    rulePathPlaceholder: string;
  };
}

function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/**
 * One rule file as three settings rows — the file and whether it is on, how it
 * is injected, how often. Each file is the whole content of one card (a
 * `SettingsSection` with `cards`), so the path row reads as the file's heading
 * and the other two as its settings. A built-in file shows its path, and the
 * path is the name of its switch, so the row is the label and the switch
 * carries no word of its own; a custom one lets you edit its path, name its
 * switch and remove it.
 *
 * A file that is off is only its path row: settings for a file nothing reads
 * would look live under a switch that says otherwise. Its role and frequency
 * stay in the setting and come back with the switch.
 */
export function RuleFileRows({
  setting,
  isFixed = false,
  onUpdate,
  onRemove,
  labels,
}: RuleFileRowsProps) {
  const roleOptions: { value: PromptInjectionRole; label: string }[] = [
    { value: 'system', label: labels.injectionRoleSystem },
    { value: 'user', label: labels.injectionRoleUser },
  ];
  const frequencyOptions: { value: PromptSendFrequency; label: string }[] = [
    { value: 'first-turn', label: labels.frequencyFirstTurn },
    { value: 'every-turn', label: labels.frequencyEveryTurn },
  ];

  // The label is a free string, so only a label that says more than the path's
  // own file name earns a hint; "AGENTS.md" under "~/.mango/AGENTS.md" repeats it.
  const pathHint =
    setting.label && setting.label !== basename(setting.path) ? setting.label : undefined;

  return (
    <>
      {isFixed ? (
        <SettingsRow
          as="label"
          label={<span className="font-mono">{setting.path}</span>}
          hint={pathHint}
        >
          <ToggleSwitch
            checked={setting.enabled}
            onChange={(e) => onUpdate({ enabled: e.target.checked })}
            aria-label={labels.enabledLabel}
          />
        </SettingsRow>
      ) : (
        <div className="flex flex-wrap items-end gap-x-4 gap-y-3 px-4 py-3">
          <div className="min-w-0 flex-1 basis-56">
            <Input
              id={`rule-path-${setting.id}`}
              label={labels.rulePathLabel}
              value={setting.path}
              placeholder={labels.rulePathPlaceholder}
              onChange={(e) => onUpdate({ path: e.target.value })}
            />
          </div>
          <div className="flex h-8 items-center gap-3">
            <Toggle
              id={`rule-enabled-${setting.id}`}
              label={labels.enabledLabel}
              checked={setting.enabled}
              onChange={(e) => onUpdate({ enabled: e.target.checked })}
            />
            {onRemove ? (
              <Button
                variant="subtle-danger"
                size="sm"
                onClick={onRemove}
                aria-label={labels.removeRule}
              >
                {labels.removeRule}
              </Button>
            ) : null}
          </div>
        </div>
      )}

      {setting.enabled ? (
        <>
          <SettingsRow label={labels.injectionRoleLabel} layout="stacked">
            <SettingsSegmented
              kind="radio"
              name={`role-${setting.id}`}
              ariaLabel={labels.injectionRoleLabel}
              value={setting.injectionRole}
              options={roleOptions}
              onChange={(injectionRole) => onUpdate({ injectionRole })}
            />
          </SettingsRow>

          {/* The hint does not depend on the choice: a line that came and went with it
              moved the control up by a line under the pointer. */}
          <SettingsRow label={labels.frequencyLabel} hint={labels.frequencyHint} layout="stacked">
            <SettingsSegmented
              kind="radio"
              name={`freq-${setting.id}`}
              ariaLabel={labels.frequencyLabel}
              value={setting.sendFrequency}
              options={frequencyOptions}
              onChange={(sendFrequency) => onUpdate({ sendFrequency })}
            />
          </SettingsRow>
        </>
      ) : null}
    </>
  );
}
