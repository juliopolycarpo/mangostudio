import type { GitSettings } from '@mangostudio/shared/app-settings';
import {
  COMMIT_MESSAGE_MAX_DIFF_KB_MAX,
  COMMIT_MESSAGE_MAX_DIFF_KB_MIN,
  DEFAULT_COMMIT_MESSAGE_PROMPT,
} from '@mangostudio/shared/git';
import { RotateCcw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { SettingToggle } from '@/components/settings/SettingToggle';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { useI18n } from '@/hooks/use-i18n';
import { useModelCatalog } from '@/hooks/use-model-catalog';

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
    <div className="space-y-4">
      <Card variant="solid" className="space-y-3 p-4 sm:p-6">
        <h2 className="text-lg font-bold text-on-surface">{labels.title}</h2>
        <p className="text-sm text-on-surface-variant/70">{labels.description}</p>
      </Card>

      <Card variant="solid" className="space-y-5 p-4 sm:p-6">
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
      </Card>

      <Card variant="solid" className="space-y-5 p-4 sm:p-6">
        <div className="space-y-1">
          <h3 className="text-base font-bold text-on-surface">{commitMessageLabels.title}</h3>
          <p className="text-sm text-on-surface-variant/70">{commitMessageLabels.description}</p>
          <p className="text-xs text-on-surface-variant/60">{commitMessageLabels.dataNotice}</p>
        </div>

        <label className="block space-y-2">
          <span className="block text-sm font-semibold text-on-surface">
            {commitMessageLabels.modelLabel}
          </span>
          <span className="block text-xs text-on-surface-variant/60">
            {commitMessageLabels.modelDescription}
          </span>
          <select
            value={settings.commitMessage.preferredModel}
            onChange={(event) => setPreferredCommitMessageModel(event.target.value)}
            aria-label={commitMessageLabels.modelLabel}
            className="w-full cursor-pointer rounded-xl border border-outline-variant/20 bg-surface-container-lowest px-4 py-2.5 text-sm text-on-surface outline-none transition-colors focus:border-primary/60 focus:ring-1 focus:ring-primary/20"
          >
            <option value="">{commitMessageLabels.modelCurrent}</option>
            {missingModel.map((model) => (
              <option key={model.modelId} value={model.modelId}>
                {model.displayName}
              </option>
            ))}
            {catalog.textModels.map((model) => (
              <option key={model.modelId} value={model.modelId}>
                {model.displayName}
              </option>
            ))}
          </select>
        </label>

        <label className="block space-y-2">
          <span className="block text-sm font-semibold text-on-surface">
            {commitMessageLabels.promptLabel}
          </span>
          <span className="block text-xs text-on-surface-variant/60">
            {commitMessageLabels.promptDescription}
          </span>
          <textarea
            value={systemPromptDraft}
            onChange={(event) => setSystemPromptDraft(event.target.value)}
            onBlur={persistSystemPrompt}
            aria-label={commitMessageLabels.promptLabel}
            rows={8}
            className="w-full resize-y rounded-xl border border-outline-variant/20 bg-surface-container-lowest px-4 py-3 font-mono text-xs leading-5 text-on-surface outline-none transition-colors focus:border-primary/60 focus:ring-1 focus:ring-primary/20"
          />
        </label>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => {
            setSystemPromptDraft(DEFAULT_COMMIT_MESSAGE_PROMPT);
            resetCommitMessageSystemPrompt();
          }}
        >
          <RotateCcw size={14} />
          {commitMessageLabels.resetPrompt}
        </Button>

        <label className="block space-y-2">
          <span className="block text-sm font-semibold text-on-surface">
            {commitMessageLabels.maxDiffLabel}
          </span>
          <span className="block text-xs text-on-surface-variant/60">
            {commitMessageLabels.maxDiffDescription}
          </span>
          <input
            type="number"
            min={COMMIT_MESSAGE_MAX_DIFF_KB_MIN}
            max={COMMIT_MESSAGE_MAX_DIFF_KB_MAX}
            step={1}
            value={maxDiffKbDraft}
            onChange={(event) => setMaxDiffKbDraft(event.target.value)}
            onBlur={persistMaxDiffKb}
            aria-label={commitMessageLabels.maxDiffLabel}
            className="w-full rounded-xl border border-outline-variant/20 bg-surface-container-lowest px-4 py-2.5 text-sm text-on-surface outline-none transition-colors focus:border-primary/60 focus:ring-1 focus:ring-primary/20"
          />
        </label>
      </Card>
    </div>
  );
}
