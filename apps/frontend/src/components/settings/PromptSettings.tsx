import type {
  PromptSettings as PromptSettingsData,
  RuleFileSetting,
} from '@mangostudio/shared/prompt-rules';
import { Plus } from 'lucide-react';
import { useCallback } from 'react';
import { RuleFileRows } from '@/components/settings/RuleFileRows';
import { SettingsPage } from '@/components/settings/SettingsPage';
import { SettingsRow } from '@/components/settings/SettingsRow';
import { SettingsSection } from '@/components/settings/SettingsSection';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Textarea } from '@/components/ui/Textarea';
import { useI18n } from '@/hooks/use-i18n';
import { ICON_SM } from '@/lib/icon-sizes';

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
    frequencyHint: s.frequencyHint,
    frequencyEveryTurn: s.frequencyEveryTurn,
    removeRule: s.removeRule,
    rulePathLabel: s.rulePathLabel,
    rulePathPlaceholder: s.rulePathPlaceholder,
  };

  return (
    <SettingsPage title={t.settings.tabs.prompts}>
      <SettingsSection title={s.defaultPromptsLabel}>
        <SettingsRow label={s.textSystemPromptLabel} htmlFor="text-system-prompt" layout="stacked">
          <Textarea
            id="text-system-prompt"
            value={promptSettings.textSystemPrompt}
            onChange={(e) => onTextSystemPromptChange(e.target.value)}
            placeholder={s.textSystemPromptPlaceholder}
            rows={4}
          />
        </SettingsRow>
        <SettingsRow
          label={s.imageSystemPromptLabel}
          htmlFor="image-system-prompt"
          layout="stacked"
        >
          <Textarea
            id="image-system-prompt"
            value={promptSettings.imageSystemPrompt}
            onChange={(e) => onImageSystemPromptChange(e.target.value)}
            placeholder={s.imageSystemPromptPlaceholder}
            rows={4}
          />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title={s.ruleFilesLabel} cards>
        <RuleFileRows
          setting={promptSettings.agentsMd}
          isFixed
          onUpdate={handleUpdateAgentsMd}
          labels={ruleLabels}
        />
        <RuleFileRows
          setting={promptSettings.claudeMd}
          isFixed
          onUpdate={handleUpdateClaudeMd}
          labels={ruleLabels}
        />
      </SettingsSection>

      <SettingsSection
        title={s.customRulesLabel}
        description={s.customRulesDescription}
        cards
        action={
          <Button variant="secondary" size="sm" onClick={onAddCustomRule}>
            <Plus size={ICON_SM} />
            {s.addRule}
          </Button>
        }
      >
        {promptSettings.customRules.map((rule) => (
          <RuleFileRows
            key={rule.id}
            setting={rule}
            onUpdate={(updates) => onUpdateRuleFile(rule.id, updates)}
            onRemove={() => onRemoveCustomRule(rule.id)}
            labels={ruleLabels}
          />
        ))}

        {promptSettings.customRules.length === 0 && (
          <EmptyState title={s.customRulesEmpty} className="min-h-0" />
        )}
      </SettingsSection>
    </SettingsPage>
  );
}
