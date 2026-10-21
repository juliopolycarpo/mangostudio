import type {
  PromptInjectionRole,
  PromptSendFrequency,
  RuleFileSetting,
} from '@mangostudio/shared/prompt-rules';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Toggle } from '@/components/ui/Toggle';
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
    frequencyFirstTurnHint: string;
    frequencyEveryTurn: string;
    removeRule: string;
    rulePathLabel: string;
    rulePathPlaceholder: string;
  };
}

/**
 * One rule file as three settings rows — the file and whether it is on, how it
 * is injected, how often — for the card of a `SettingsSection`. A built-in file
 * shows its path; a custom one lets you edit it and remove it.
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

  const enabledToggle = (
    <Toggle
      id={`rule-enabled-${setting.id}`}
      label={labels.enabledLabel}
      checked={setting.enabled}
      onChange={(e) => onUpdate({ enabled: e.target.checked })}
    />
  );

  return (
    <>
      {isFixed ? (
        <SettingsRow
          label={<span className="font-mono">{setting.path}</span>}
          hint={setting.label || undefined}
        >
          {enabledToggle}
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
            {enabledToggle}
            {onRemove ? (
              <Button variant="subtle" size="sm" onClick={onRemove} aria-label={labels.removeRule}>
                {labels.removeRule}
              </Button>
            ) : null}
          </div>
        </div>
      )}

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

      <SettingsRow
        label={labels.frequencyLabel}
        hint={setting.sendFrequency === 'first-turn' ? labels.frequencyFirstTurnHint : undefined}
        layout="stacked"
      >
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
  );
}
