import type {
  PromptSettings as PromptSettingsData,
  RuleFileSetting,
} from '@mangostudio/shared/prompt-rules';
import { Plus } from 'lucide-react';
import { useCallback } from 'react';
import { RuleFileCard } from '@/components/settings/RuleFileCard';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { useI18n } from '@/hooks/use-i18n';

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
      <Card className="space-y-3 p-4 sm:p-6">
        <h3 className="text-xs uppercase tracking-widest font-bold text-fg-muted">
          {s.defaultPromptsLabel}
        </h3>

        <label className="text-sm font-medium text-fg-muted" htmlFor="text-system-prompt">
          {s.textSystemPromptLabel}
        </label>
        <textarea
          id="text-system-prompt"
          value={promptSettings.textSystemPrompt}
          onChange={(e) => onTextSystemPromptChange(e.target.value)}
          placeholder={s.textSystemPromptPlaceholder}
          className="
            w-full bg-control border border-stroke rounded-xl p-4
            text-sm text-fg focus:ring-1 focus:ring-focus focus:outline-none
            focus:border-focus placeholder:text-fg-subtle
            min-h-25 transition-all resize-none           "
        />

        <label className="text-sm font-medium text-fg-muted" htmlFor="image-system-prompt">
          {s.imageSystemPromptLabel}
        </label>
        <textarea
          id="image-system-prompt"
          value={promptSettings.imageSystemPrompt}
          onChange={(e) => onImageSystemPromptChange(e.target.value)}
          placeholder={s.imageSystemPromptPlaceholder}
          className="
            w-full bg-control border border-stroke rounded-xl p-4
            text-sm text-fg focus:ring-1 focus:ring-focus focus:outline-none
            focus:border-focus placeholder:text-fg-subtle
            min-h-25 transition-all resize-none           "
        />
      </Card>

      {/* ── Rule Files ── */}
      <Card className="space-y-4 p-4 sm:p-6">
        <h3 className="text-xs uppercase tracking-widest font-bold text-fg-muted">
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
      <Card className="space-y-4 p-4 sm:p-6">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 sm:gap-4">
          <div className="space-y-1">
            <h3 className="text-xs uppercase tracking-widest font-bold text-fg-muted">
              {s.customRulesLabel}
            </h3>
            <p className="text-sm text-fg-muted">{s.customRulesDescription}</p>
          </div>
          <Button
            variant="secondary"
            size="sm"
            onClick={onAddCustomRule}
            className="shrink-0 whitespace-nowrap"
          >
            <Plus className="w-3.5 h-3.5" />
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
          <p className="text-sm text-fg-subtle text-center py-4">{s.addRule}</p>
        )}
      </Card>
    </div>
  );
}
