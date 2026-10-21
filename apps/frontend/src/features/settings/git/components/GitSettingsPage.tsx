import type { GitSettings } from '@mangostudio/shared/app-settings';
import {
  COMMIT_MESSAGE_MAX_DIFF_KB_MAX,
  COMMIT_MESSAGE_MAX_DIFF_KB_MIN,
  DEFAULT_COMMIT_MESSAGE_PROMPT,
} from '@mangostudio/shared/git';
import { RotateCcw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { SettingsPage } from '@/components/settings/SettingsPage';
import { SettingsRow } from '@/components/settings/SettingsRow';
import { SettingsSection } from '@/components/settings/SettingsSection';
import { SettingToggle } from '@/components/settings/SettingToggle';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { useI18n } from '@/hooks/use-i18n';
import { useModelCatalog } from '@/hooks/use-model-catalog';
import { ICON_SM } from '@/lib/icon-sizes';
import { modelSelectOptions } from '@/lib/model-select-options';

interface GitSettingsPageProps {
  readonly settings: GitSettings;
  readonly setSignCommits: (value: boolean) => void;
  readonly setSignOff: (value: boolean) => void;
  readonly setPreferredCommitMessageModel: (value: string) => void;
  readonly setCommitMessageSystemPrompt: (value: string) => void;
  readonly resetCommitMessageSystemPrompt: () => void;
  readonly setCommitMessageMaxDiffKb: (value: number) => void;
}

export function GitSettingsPage({
  settings,
  setSignCommits,
  setSignOff,
  setPreferredCommitMessageModel,
  setCommitMessageSystemPrompt,
  resetCommitMessageSystemPrompt,
  setCommitMessageMaxDiffKb,
}: GitSettingsPageProps) {
  const { t } = useI18n();
  const labels = t.settings.git;
  const commitMessageLabels = labels.commitMessages;
  const { catalog } = useModelCatalog();
  const [systemPromptDraft, setSystemPromptDraft] = useState(settings.commitMessage.systemPrompt);
  useEffect(() => {
    setSystemPromptDraft(settings.commitMessage.systemPrompt);
  }, [settings.commitMessage.systemPrompt]);

  const persistSystemPrompt = () => {
    const nextPrompt = systemPromptDraft.trim() ? systemPromptDraft : DEFAULT_COMMIT_MESSAGE_PROMPT;
    setSystemPromptDraft(nextPrompt);
    setCommitMessageSystemPrompt(nextPrompt);
  };

  // Held as a draft because persisting mid-edit clamps the value to the minimum and blocks typing.
  const [maxDiffKbDraft, setMaxDiffKbDraft] = useState(String(settings.commitMessage.maxDiffKb));
  useEffect(() => {
    setMaxDiffKbDraft(String(settings.commitMessage.maxDiffKb));
  }, [settings.commitMessage.maxDiffKb]);

  const persistMaxDiffKb = () => {
    const parsed = Number.parseInt(maxDiffKbDraft, 10);
    const nextMaxDiffKb = Number.isNaN(parsed)
      ? settings.commitMessage.maxDiffKb
      : Math.min(COMMIT_MESSAGE_MAX_DIFF_KB_MAX, Math.max(COMMIT_MESSAGE_MAX_DIFF_KB_MIN, parsed));
    setMaxDiffKbDraft(String(nextMaxDiffKb));
    setCommitMessageMaxDiffKb(nextMaxDiffKb);
  };
  const missingModel =
    settings.commitMessage.preferredModel &&
    !catalog.textModels.some((model) => model.modelId === settings.commitMessage.preferredModel)
      ? [
          {
            modelId: settings.commitMessage.preferredModel,
            displayName: settings.commitMessage.preferredModel,
          },
        ]
      : [];

  return (
    <SettingsPage title={labels.title} description={labels.description}>
      <SettingsSection>
        <SettingToggle
          label={labels.signCommitsLabel}
          description={labels.signCommitsDescription}
          checked={settings.signCommits}
          onChange={setSignCommits}
        />
        <SettingToggle
          label={labels.signOffLabel}
          description={labels.signOffDescription}
          checked={settings.signOff}
          onChange={setSignOff}
        />
      </SettingsSection>

      <SettingsSection
        title={commitMessageLabels.title}
        description={commitMessageLabels.description}
        notice={<Callout tone="info">{commitMessageLabels.dataNotice}</Callout>}
      >
        <SettingsRow
          label={commitMessageLabels.modelLabel}
          hint={commitMessageLabels.modelDescription}
          layout="field"
        >
          <Select
            value={settings.commitMessage.preferredModel}
            onChange={setPreferredCommitMessageModel}
            ariaLabel={commitMessageLabels.modelLabel}
            options={modelSelectOptions(
              { value: '', label: commitMessageLabels.modelCurrent },
              missingModel,
              catalog.textModels
            )}
          />
        </SettingsRow>

        <SettingsRow
          label={commitMessageLabels.promptLabel}
          hint={commitMessageLabels.promptDescription}
          htmlFor="commit-message-prompt"
          layout="stacked"
          aside={
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => {
                setSystemPromptDraft(DEFAULT_COMMIT_MESSAGE_PROMPT);
                resetCommitMessageSystemPrompt();
              }}
            >
              <RotateCcw size={ICON_SM} />
              {commitMessageLabels.resetPrompt}
            </Button>
          }
        >
          <Textarea
            id="commit-message-prompt"
            value={systemPromptDraft}
            onChange={(event) => setSystemPromptDraft(event.target.value)}
            onBlur={persistSystemPrompt}
            rows={8}
          />
        </SettingsRow>

        <SettingsRow
          label={commitMessageLabels.maxDiffLabel}
          hint={commitMessageLabels.maxDiffDescription}
          htmlFor="commit-message-max-diff"
        >
          <Input
            id="commit-message-max-diff"
            type="number"
            min={COMMIT_MESSAGE_MAX_DIFF_KB_MIN}
            max={COMMIT_MESSAGE_MAX_DIFF_KB_MAX}
            step={1}
            value={maxDiffKbDraft}
            onChange={(event) => setMaxDiffKbDraft(event.target.value)}
            onBlur={persistMaxDiffKb}
            className="w-32 text-center"
          />
        </SettingsRow>
      </SettingsSection>
    </SettingsPage>
  );
}
