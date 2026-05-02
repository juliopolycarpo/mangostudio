import { useCallback } from 'react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { RuleFileCard } from '@/components/settings/RuleFileCard';
import { useI18n } from '@/hooks/use-i18n';
import type {
  PromptSettings as PromptSettingsData,
  RuleFileSetting,
} from '@/hooks/use-global-settings';

interface PromptSettingsProps {
  promptSettings: PromptSettingsData;
  onTextSystemPromptChange: (value: string) => void;
  onImageSystemPromptChange: (value: string) => void;
  onUpdateRuleFile: (id: string, updates: Partial<RuleFileSetting>) => void;
  onAddCustomRule: () => void;
  onRemoveCustomRule: (id: string) => void;
}

export function PromptSettings({
  promptSettings,
  onTextSystemPromptChange,
  onImageSystemPromptChange,
  onUpdateRuleFile,
  onAddCustomRule,
  onRemoveCustomRule,
}: PromptSettingsProps) {
  const { t } = useI18n();
  const s = t.settings.prompts;

  const handleUpdateAgentsMd = useCallback(
    (updates: Partial<RuleFileSetting>) => onUpdateRuleFile('agentsMd', updates),
    [onUpdateRuleFile]
  );

  const handleUpdateClaudeMd = useCallback(
    (updates: Partial<RuleFileSetting>) => onUpdateRuleFile('claudeMd', updates),
    [onUpdateRuleFile]
  );

  const ruleLabels = {
    enabledLabel: s.enabledLabel,
    injectionRoleLabel: s.injectionRoleLabel,
    injectionRoleSystem: s.injectionRoleSystem,
    injectionRoleUser: s.injectionRoleUser,
    frequencyLabel: s.frequencyLabel,
    frequencyFirstTurn: s.frequencyFirstTurn,
    frequencyFirstTurnHint: s.frequencyFirstTurnHint,
    frequencyEveryTurn: s.frequencyEveryTurn,
    removeRule: s.removeRule,
    rulePathLabel: s.rulePathLabel,
    rulePathPlaceholder: s.rulePathPlaceholder,
  };

  return (
    <div className="space-y-4">
      {/* ── Default Prompts ── */}
      <Card variant="solid" className="space-y-3 p-6">
        <h3 className="text-xs uppercase tracking-widest font-bold text-on-surface-variant/80 font-label">
          {s.defaultPromptsLabel}
        </h3>

        <label className="text-sm font-medium text-on-surface-variant" htmlFor="text-system-prompt">
          {s.textSystemPromptLabel}
        </label>
        <textarea
          id="text-system-prompt"
          value={promptSettings.textSystemPrompt}
          onChange={(e) => onTextSystemPromptChange(e.target.value)}
          placeholder={s.textSystemPromptPlaceholder}
          className="
            w-full bg-surface-container-lowest border border-outline-variant/20 rounded-xl p-4
            text-sm text-on-surface focus:ring-1 focus:ring-primary/40 focus:outline-none
            focus:border-primary/60 placeholder:text-on-surface-variant/40
            min-h-25 transition-all resize-none font-body
          "
        />

        <label
          className="text-sm font-medium text-on-surface-variant"
          htmlFor="image-system-prompt"
        >
          {s.imageSystemPromptLabel}
        </label>
        <textarea
          id="image-system-prompt"
          value={promptSettings.imageSystemPrompt}
          onChange={(e) => onImageSystemPromptChange(e.target.value)}
          placeholder={s.imageSystemPromptPlaceholder}
          className="
            w-full bg-surface-container-lowest border border-outline-variant/20 rounded-xl p-4
            text-sm text-on-surface focus:ring-1 focus:ring-primary/40 focus:outline-none
            focus:border-primary/60 placeholder:text-on-surface-variant/40
            min-h-25 transition-all resize-none font-body
          "
        />
      </Card>

      {/* ── Rule Files ── */}
      <Card variant="solid" className="space-y-4 p-6">
        <h3 className="text-xs uppercase tracking-widest font-bold text-on-surface-variant/80 font-label">
          {s.ruleFilesLabel}
        </h3>

        <RuleFileCard
          setting={promptSettings.agentsMd}
          isFixed
          onUpdate={handleUpdateAgentsMd}
          labels={ruleLabels}
        />

        <RuleFileCard
          setting={promptSettings.claudeMd}
          isFixed
          onUpdate={handleUpdateClaudeMd}
          labels={ruleLabels}
        />
      </Card>

      {/* ── Custom Rules ── */}
      <Card variant="solid" className="space-y-4 p-6">
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-1">
            <h3 className="text-xs uppercase tracking-widest font-bold text-on-surface-variant/80 font-label">
              {s.customRulesLabel}
            </h3>
            <p className="text-sm text-on-surface-variant/60">{s.customRulesDescription}</p>
          </div>
          <Button variant="secondary" size="sm" onClick={onAddCustomRule}>
            {s.addRule}
          </Button>
        </div>

        {promptSettings.customRules.map((rule) => (
          <RuleFileCard
            key={rule.id}
            setting={rule}
            onUpdate={(updates) => onUpdateRuleFile(rule.id, updates)}
            onRemove={() => onRemoveCustomRule(rule.id)}
            labels={ruleLabels}
          />
        ))}

        {promptSettings.customRules.length === 0 && (
          <p className="text-sm text-on-surface-variant/40 text-center py-4">{s.addRule}</p>
        )}
      </Card>
    </div>
  );
}
