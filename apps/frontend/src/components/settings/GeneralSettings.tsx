import type {
  ChatTitleSettings,
  ChatTitleStrategy,
  MultiAgentSettings,
} from '@mangostudio/shared/app-settings';
import {
  MAX_SUBAGENT_CALLS_MAX,
  MAX_SUBAGENT_CALLS_MIN,
  SUBAGENT_MAX_TURNS_MAX,
  SUBAGENT_MAX_TURNS_MIN,
} from '@mangostudio/shared/app-settings';
import type { ModelOption } from '@mangostudio/shared/catalog';
import type { Locale } from '@mangostudio/shared/i18n';
import {
  CHAT_SIDEBAR_WIDTH_DEFAULT,
  WORKSPACE_PANEL_WIDTH_DEFAULT,
  type WorkspacePanelId,
  type WorkspaceSettings,
} from '@mangostudio/shared/workspaces';
import {
  ArrowDown,
  ArrowUp,
  FolderGit2,
  FolderOpen,
  GitPullRequest,
  ListTodo,
  RotateCcw,
  TerminalSquare,
  X,
} from 'lucide-react';
import { useState } from 'react';
import { SettingsPage } from '@/components/settings/SettingsPage';
import { SettingsRow } from '@/components/settings/SettingsRow';
import { SettingsSection } from '@/components/settings/SettingsSection';
import { SettingsSegmented } from '@/components/settings/SettingsSegmented';
import { SettingsSliderRow } from '@/components/settings/SettingsSliderRow';
import { SettingToggle } from '@/components/settings/SettingToggle';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';
import { Chip } from '@/components/ui/Chip';
import { FIELD_CLASS, Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { RerunSetupCard } from '@/features/onboarding/RerunSetupCard';
import { WorkdirPickerDialog } from '@/features/workspace/WorkdirPickerDialog';
import { useI18n } from '@/hooks/use-i18n';
import { ICON_MD, ICON_SM } from '@/lib/icon-sizes';
import { modelSelectOptions } from '@/lib/model-select-options';
import { cn } from '@/lib/utils';

interface GeneralSettingsProps {
  imageQuality: string;
  setImageQuality: (val: string) => void;
  chatTitleSettings: ChatTitleSettings;
  availableTitleModels: ModelOption[];
  setChatAutoRenameEnabled: (value: boolean) => void;
  setChatTitleStrategy: (value: ChatTitleStrategy) => void;
  setChatTitlePromptPrefixLength: (value: number) => void;
  setPreferredChatTitleModel: (value: string) => void;
  multiAgentSettings: MultiAgentSettings;
  setMultiAgentEnabled: (value: boolean) => void;
  setTraceVisibility: (value: MultiAgentSettings['traceVisibility']) => void;
  setMaxDelegationDepth: (value: number) => void;
  setMaxSubagentCalls: (value: number) => void;
  setSubagentTimeoutMs: (value: number) => void;
  setDefaultSubagentMaxTurns: (value: number) => void;
  workspaceSettings: WorkspaceSettings;
  setDefaultWorkdir: (value: string) => void;
  setRestrictToolsToWorkdir: (value: boolean) => void;
  setWorkspacePanelVisible: (panelId: WorkspacePanelId, visible: boolean) => void;
  moveWorkspacePanel: (panelId: WorkspacePanelId, direction: 'up' | 'down') => void;
  setWorkspacePanelWidth: (value: number) => void;
  setChatSidebarWidth: (value: number) => void;
  addRecentWorkdir: (value: string) => void;
}

const IMAGE_QUALITY_OPTIONS = ['512px', '1K', '2K', '4K'].map((quality) => ({
  value: quality,
  label: quality,
}));

const LOCALE_OPTIONS: { value: Locale; label: string }[] = [
  { value: 'en', label: 'English' },
  { value: 'pt-BR', label: 'Português (BR)' },
];

const PROMPT_PREFIX_LENGTH_MIN = 10;
const PROMPT_PREFIX_LENGTH_MAX = 80;
const TIMEOUT_STEP_MS = 30_000;

/**
 * General settings page: language, image quality, working directory, side
 * panels, multi-agent turns and chat titles.
 */
export function GeneralSettings({
  imageQuality,
  setImageQuality,
  chatTitleSettings,
  availableTitleModels,
  setChatAutoRenameEnabled,
  setChatTitleStrategy,
  setChatTitlePromptPrefixLength,
  setPreferredChatTitleModel,
  multiAgentSettings,
  setMultiAgentEnabled,
  setTraceVisibility,
  setMaxDelegationDepth,
  setMaxSubagentCalls,
  setSubagentTimeoutMs,
  setDefaultSubagentMaxTurns,
  workspaceSettings,
  setDefaultWorkdir,
  setRestrictToolsToWorkdir,
  setWorkspacePanelVisible,
  moveWorkspacePanel,
  setWorkspacePanelWidth,
  setChatSidebarWidth,
  addRecentWorkdir,
}: GeneralSettingsProps) {
  const { t, locale, setLocale } = useI18n();
  const s = t.settings.general;
  const workspace = t.workspace;
  const panelLabels: Readonly<Record<WorkspacePanelId, string>> = {
    git: t.git.title,
    github: t.github.title,
    todos: t.chat.todo.title,
    terminal: t.terminal.title,
  };
  const panelIcons = {
    git: FolderGit2,
    github: GitPullRequest,
    todos: ListTodo,
    terminal: TerminalSquare,
  } satisfies Readonly<Record<WorkspacePanelId, typeof FolderGit2>>;
  const [isWorkdirPickerOpen, setWorkdirPickerOpen] = useState(false);
  const missingTitleModelOption =
    chatTitleSettings.preferredModel !== 'current_model' &&
    !availableTitleModels.some((model) => model.modelId === chatTitleSettings.preferredModel)
      ? [
          {
            modelId: chatTitleSettings.preferredModel,
            displayName: chatTitleSettings.preferredModel,
          },
        ]
      : [];

  return (
    <SettingsPage title={t.settings.tabs.general}>
      <SettingsSection>
        <SettingsRow
          label={s.languageLabel}
          hint={s.languageDescription}
          htmlFor="language-select"
          layout="field"
        >
          <Select
            id="language-select"
            value={locale}
            onChange={(value) => setLocale(value as Locale)}
            ariaLabel={s.languageLabel}
            options={LOCALE_OPTIONS}
          />
        </SettingsRow>
        <SettingsRow label={s.imageQualityLabel} layout="stacked">
          <SettingsSegmented
            ariaLabel={s.imageQualityLabel}
            value={imageQuality}
            options={IMAGE_QUALITY_OPTIONS}
            onChange={setImageQuality}
          />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title={workspace.settingsLabel} description={workspace.settingsDescription}>
        <SettingsRow label={workspace.defaultLabel} layout="stacked">
          {/* Below `sm` the path takes the first line and its two buttons the
              second, as one group: the clear button never wraps off on its own. */}
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setWorkdirPickerOpen(true)}
              className={cn(
                FIELD_CLASS,
                'flex min-w-0 flex-1 basis-full cursor-pointer items-center gap-2 text-left sm:basis-48'
              )}
              title={workspaceSettings.defaultWorkdir || workspace.defaultEmpty}
            >
              <FolderOpen size={ICON_MD} className="shrink-0 text-fg-muted" />
              <span className="min-w-0 flex-1 truncate font-mono text-xs">
                {workspaceSettings.defaultWorkdir || workspace.defaultEmpty}
              </span>
            </button>
            <div className="flex shrink-0 items-center gap-2">
              <Button type="button" variant="secondary" onClick={() => setWorkdirPickerOpen(true)}>
                {workspace.changeDefault}
              </Button>
              {workspaceSettings.defaultWorkdir ? (
                <Button
                  type="button"
                  variant="subtle"
                  size="icon"
                  onClick={() => setDefaultWorkdir('')}
                  aria-label={workspace.clearDefault}
                  title={workspace.clearDefault}
                >
                  <X size={ICON_MD} />
                </Button>
              ) : null}
            </div>
          </div>
        </SettingsRow>
        <SettingToggle
          label={workspace.restrictToolsLabel}
          description={workspace.restrictToolsDescription}
          checked={workspaceSettings.restrictToolsToWorkdir}
          onChange={setRestrictToolsToWorkdir}
        />
        <WorkdirPickerDialog
          open={isWorkdirPickerOpen}
          initialPath={workspaceSettings.defaultWorkdir}
          recentWorkdirs={workspaceSettings.recentWorkdirs}
          showUseDefault={false}
          onSelect={(path) => {
            setDefaultWorkdir(path);
            addRecentWorkdir(path);
            setWorkdirPickerOpen(false);
          }}
          onClose={() => setWorkdirPickerOpen(false)}
        />
      </SettingsSection>

      <SettingsSection
        title={workspace.chatSidebarTitle}
        description={workspace.chatSidebarDescription}
      >
        <WidthRow
          width={workspaceSettings.chatSidebarWidth}
          defaultWidth={CHAT_SIDEBAR_WIDTH_DEFAULT}
          resetLabel={workspace.chatSidebarResetWidth}
          onReset={() => setChatSidebarWidth(CHAT_SIDEBAR_WIDTH_DEFAULT)}
        />
      </SettingsSection>

      <SettingsSection
        title={workspace.sidePanelTitle}
        description={workspace.sidePanelDescription}
      >
        {workspaceSettings.sidePanel.panelOrder.map((panelId, index) => {
          const Icon = panelIcons[panelId];
          const label = panelLabels[panelId];
          const isVisible = workspaceSettings.sidePanel.visiblePanelIds.includes(panelId);
          return (
            <SettingsRow
              key={panelId}
              label={
                <span className="flex items-center gap-2">
                  <Icon size={ICON_MD} className="shrink-0 text-fg-muted" />
                  <span className="truncate">{label}</span>
                </span>
              }
            >
              <div className="flex items-center gap-1">
                <Button
                  type="button"
                  variant="subtle"
                  size="icon"
                  onClick={() => moveWorkspacePanel(panelId, 'up')}
                  disabled={index === 0}
                  aria-label={workspace.sidePanelMoveUp.replace('{panel}', label)}
                >
                  <ArrowUp size={ICON_MD} />
                </Button>
                <Button
                  type="button"
                  variant="subtle"
                  size="icon"
                  onClick={() => moveWorkspacePanel(panelId, 'down')}
                  disabled={index === workspaceSettings.sidePanel.panelOrder.length - 1}
                  aria-label={workspace.sidePanelMoveDown.replace('{panel}', label)}
                >
                  <ArrowDown size={ICON_MD} />
                </Button>
                <Checkbox
                  checked={isVisible}
                  onChange={(event) => setWorkspacePanelVisible(panelId, event.target.checked)}
                  aria-label={workspace.sidePanelShow.replace('{panel}', label)}
                  className="ml-3"
                />
              </div>
            </SettingsRow>
          );
        })}
        <WidthRow
          width={workspaceSettings.sidePanel.width}
          defaultWidth={WORKSPACE_PANEL_WIDTH_DEFAULT}
          resetLabel={workspace.sidePanelResetWidth}
          onReset={() => setWorkspacePanelWidth(WORKSPACE_PANEL_WIDTH_DEFAULT)}
        />
      </SettingsSection>

      <SettingsSection title={s.multiAgentLabel} description={s.multiAgentDescription}>
        <SettingToggle
          label={s.multiAgentEnabledLabel}
          checked={multiAgentSettings.enabled}
          onChange={setMultiAgentEnabled}
        />
        <SettingsRow label={s.traceVisibilityLabel} layout="field">
          <Select
            value={multiAgentSettings.traceVisibility}
            onChange={(value) => setTraceVisibility(value as MultiAgentSettings['traceVisibility'])}
            disabled={!multiAgentSettings.enabled}
            ariaLabel={s.traceVisibilityLabel}
            options={[
              { value: 'compact', label: s.traceVisibilityCompact },
              { value: 'full', label: s.traceVisibilityFull },
              { value: 'off', label: s.traceVisibilityOff },
            ]}
          />
        </SettingsRow>
        <NumberSetting
          id="multi-agent-max-depth"
          label={s.maxDepthLabel}
          value={multiAgentSettings.maxDepth}
          min={0}
          max={3}
          disabled={!multiAgentSettings.enabled}
          onChange={setMaxDelegationDepth}
        />
        <NumberSetting
          id="multi-agent-max-calls"
          label={s.maxSubagentCallsLabel}
          value={multiAgentSettings.maxSubagentCalls}
          min={MAX_SUBAGENT_CALLS_MIN}
          max={MAX_SUBAGENT_CALLS_MAX}
          disabled={!multiAgentSettings.enabled}
          onChange={setMaxSubagentCalls}
        />
        <NumberSetting
          id="multi-agent-default-turns"
          label={s.defaultMaxTurnsLabel}
          value={multiAgentSettings.defaultMaxTurns}
          min={SUBAGENT_MAX_TURNS_MIN}
          max={SUBAGENT_MAX_TURNS_MAX}
          disabled={!multiAgentSettings.enabled}
          onChange={setDefaultSubagentMaxTurns}
        />
        <SettingsSliderRow
          id="subagent-timeout"
          label={s.timeoutLabel}
          readout={s.secondsHint.replace(
            '{value}',
            String(Math.round(multiAgentSettings.timeoutMs / 1000))
          )}
          min={30_000}
          max={900_000}
          step={TIMEOUT_STEP_MS}
          value={multiAgentSettings.timeoutMs}
          onChange={setSubagentTimeoutMs}
          disabled={!multiAgentSettings.enabled}
        />
      </SettingsSection>

      <SettingsSection title={s.chatTitlesLabel} description={s.chatTitlesDescription}>
        <SettingToggle
          label={s.chatTitlesToggleLabel}
          checked={chatTitleSettings.autoRenameEnabled}
          onChange={setChatAutoRenameEnabled}
        />
        <SettingsRow label={s.chatTitleSourceLabel} htmlFor="chat-title-strategy" layout="field">
          <Select
            id="chat-title-strategy"
            value={chatTitleSettings.strategy}
            onChange={(value) => setChatTitleStrategy(value as ChatTitleStrategy)}
            ariaLabel={s.chatTitleSourceLabel}
            disabled={!chatTitleSettings.autoRenameEnabled}
            options={[
              { value: 'prompt_prefix', label: s.chatTitleSourcePrompt },
              { value: 'model', label: s.chatTitleSourceModel },
            ]}
          />
        </SettingsRow>
        {chatTitleSettings.strategy === 'model' ? (
          <SettingsRow
            label={s.chatTitleModelLabel}
            hint={s.chatTitleModelDescription}
            htmlFor="chat-title-model"
            layout="field"
          >
            <Select
              id="chat-title-model"
              value={chatTitleSettings.preferredModel}
              onChange={setPreferredChatTitleModel}
              ariaLabel={s.chatTitleModelLabel}
              disabled={!chatTitleSettings.autoRenameEnabled}
              options={modelSelectOptions(
                { value: 'current_model', label: s.chatTitleModelCurrent },
                missingTitleModelOption,
                availableTitleModels
              )}
            />
          </SettingsRow>
        ) : null}
        <SettingsSliderRow
          id="chat-title-prefix-length"
          label={s.chatTitlePrefixLengthLabel}
          hint={s.chatTitlePrefixLengthDescription}
          readout={s.chatTitlePrefixLengthHint.replace(
            '{value}',
            String(chatTitleSettings.promptPrefixLength)
          )}
          min={PROMPT_PREFIX_LENGTH_MIN}
          max={PROMPT_PREFIX_LENGTH_MAX}
          value={chatTitleSettings.promptPrefixLength}
          onChange={setChatTitlePromptPrefixLength}
          disabled={!chatTitleSettings.autoRenameEnabled}
        />
      </SettingsSection>

      <RerunSetupCard />
    </SettingsPage>
  );
}

/**
 * A width the user sets by dragging an edge elsewhere, shown here as a value with
 * its way back. The value is last and fixed-width, so it stays flush with the
 * control edge; Reset grows in to its left only once the width is not the default.
 */
function WidthRow({
  width,
  defaultWidth,
  resetLabel,
  onReset,
}: {
  width: number;
  defaultWidth: number;
  resetLabel: string;
  onReset: () => void;
}) {
  const { t } = useI18n();
  const workspace = t.workspace;
  const isDefault = width === defaultWidth;

  return (
    <SettingsRow
      label={workspace.widthLabel}
      hint={workspace.widthDefaultHint.replace('{width}', String(defaultWidth))}
    >
      <div className="flex items-center gap-3">
        {isDefault ? null : (
          <Button type="button" variant="subtle" size="sm" onClick={onReset}>
            <RotateCcw size={ICON_SM} />
            {resetLabel}
          </Button>
        )}
        <Chip className="tabular-nums">{width}px</Chip>
      </div>
    </SettingsRow>
  );
}

function NumberSetting({
  id,
  label,
  value,
  min,
  max,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  disabled: boolean;
  onChange: (value: number) => void;
}) {
  return (
    <SettingsRow label={label} htmlFor={id}>
      <Input
        id={id}
        type="number"
        min={min}
        max={max}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
        className="w-32 text-center"
      />
    </SettingsRow>
  );
}
