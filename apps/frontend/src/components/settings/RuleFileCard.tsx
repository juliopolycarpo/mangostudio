import { Toggle } from '@/components/ui/Toggle';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import type {
  RuleFileSetting,
  PromptInjectionRole,
  PromptSendFrequency,
} from '@/hooks/use-global-settings';

interface RuleFileCardProps {
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

const roleOptions: { value: PromptInjectionRole; label: string }[] = [
  { value: 'system', label: 'system' },
  { value: 'user', label: 'user' },
];

const frequencyOptions: { value: PromptSendFrequency; label: string; hint?: string }[] = [
  { value: 'first-turn', label: 'first-turn' },
  { value: 'every-turn', label: 'every-turn' },
];

export function RuleFileCard({
  setting,
  isFixed = false,
  onUpdate,
  onRemove,
  labels,
}: RuleFileCardProps) {
  return (
    <div className="space-y-4 p-5 bg-surface-container-lowest rounded-xl border border-outline-variant/10">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 space-y-1.5">
          {isFixed ? (
            <div>
              <p className="text-sm font-medium text-on-surface">{setting.path}</p>
              {setting.label && (
                <p className="text-xs text-on-surface-variant/60">{setting.label}</p>
              )}
            </div>
          ) : (
            <Input
              id={`rule-path-${setting.id}`}
              label={labels.rulePathLabel}
              value={setting.path}
              placeholder={labels.rulePathPlaceholder}
              onChange={(e) => onUpdate({ path: e.target.value })}
            />
          )}
        </div>
        {!isFixed && onRemove && (
          <Button variant="ghost" size="sm" onClick={onRemove} aria-label={labels.removeRule}>
            {labels.removeRule}
          </Button>
        )}
      </div>

      <div className="flex items-center">
        <Toggle
          id={`rule-enabled-${setting.id}`}
          label={labels.enabledLabel}
          checked={setting.enabled}
          onChange={(e) => onUpdate({ enabled: e.target.checked })}
        />
      </div>

      {/* Injection Role */}
      <fieldset>
        <legend className="text-sm font-medium text-on-surface-variant mb-2">
          {labels.injectionRoleLabel}
        </legend>
        <div className="flex gap-2" role="radiogroup" aria-label={labels.injectionRoleLabel}>
          {roleOptions.map((opt) => (
            <label
              key={opt.value}
              className={`
                px-4 py-2 rounded-lg text-sm font-medium cursor-pointer transition-all
                ${
                  setting.injectionRole === opt.value
                    ? 'bg-primary text-on-primary shadow-sm'
                    : 'bg-surface-container-high text-on-surface-variant hover:bg-surface-container-highest'
                }
              `}
            >
              <input
                type="radio"
                name={`role-${setting.id}`}
                value={opt.value}
                checked={setting.injectionRole === opt.value}
                onChange={() => onUpdate({ injectionRole: opt.value })}
                className="sr-only"
              />
              {opt.value === 'system' ? labels.injectionRoleSystem : labels.injectionRoleUser}
            </label>
          ))}
        </div>
      </fieldset>

      {/* Send Frequency */}
      <fieldset>
        <legend className="text-sm font-medium text-on-surface-variant mb-2">
          {labels.frequencyLabel}
        </legend>
        <div className="flex gap-2" role="radiogroup" aria-label={labels.frequencyLabel}>
          {frequencyOptions.map((opt) => (
            <label
              key={opt.value}
              className={`
                px-4 py-2 rounded-lg text-sm font-medium cursor-pointer transition-all
                ${
                  setting.sendFrequency === opt.value
                    ? 'bg-primary text-on-primary shadow-sm'
                    : 'bg-surface-container-high text-on-surface-variant hover:bg-surface-container-highest'
                }
              `}
            >
              <input
                type="radio"
                name={`freq-${setting.id}`}
                value={opt.value}
                checked={setting.sendFrequency === opt.value}
                onChange={() => onUpdate({ sendFrequency: opt.value })}
                className="sr-only"
              />
              {opt.value === 'first-turn' ? labels.frequencyFirstTurn : labels.frequencyEveryTurn}
            </label>
          ))}
        </div>
        {setting.sendFrequency === 'first-turn' && (
          <p className="text-xs text-on-surface-variant/50 mt-1.5 ml-1">
            {labels.frequencyFirstTurnHint}
          </p>
        )}
      </fieldset>
    </div>
  );
}
