import type { ModelOption } from '@mangostudio/shared';
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
import type { Locale } from '@mangostudio/shared/i18n';
import {
  WORKSPACE_PANEL_WIDTH_DEFAULT,
  type WorkspacePanelId,
  type WorkspaceSettings,
} from '@mangostudio/shared/workspaces';
import {
  ArrowDown,
  ArrowUp,
  FolderGit2,
  FolderOpen,
  ListTodo,
  PanelRight,
  RotateCcw,
  X,
} from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { WorkdirPickerDialog } from '@/features/workspace/WorkdirPickerDialog';
import { useI18n } from '@/hooks/use-i18n';

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
  setChatDelegationEnabled: (value: boolean) => void;
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
  addRecentWorkdir: (value: string) => void;
}

const IMAGE_QUALITY_OPTIONS = ['512px', '1K', '2K', '4K'] as const;

const LOCALE_OPTIONS: { value: Locale; label: string }[] = [
  { value: 'en', label: 'English' },
  { value: 'pt-BR', label: 'Português (BR)' },
];

const PROMPT_PREFIX_LENGTH_MIN = 10;
const PROMPT_PREFIX_LENGTH_MAX = 80;
const TIMEOUT_STEP_MS = 30_000;

/**
 * General settings tab: language selector, image quality grid.
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
  setChatDelegationEnabled,
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
  addRecentWorkdir,
}: GeneralSettingsProps) {
  const { t, locale, setLocale } = useI18n();
  const s = t.settings.general;
  const workspace = t.workspace;
  const panelLabels: Readonly<Record<WorkspacePanelId, string>> = {
    git: t.git.title,
    todos: t.chat.todo.title,
  };
  const panelIcons = {
    git: FolderGit2,
    todos: ListTodo,
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
    <div className="space-y-4">
      {/* ── Language ── */}
      <Card variant="solid" className="space-y-3 p-4 sm:p-6">
        <h3 className="text-xs uppercase tracking-widest font-bold text-on-surface-variant/80 font-label">
          {s.languageLabel}
        </h3>
        <p className="text-sm text-on-surface-variant/60">{s.languageDescription}</p>
        <select
          value={locale}
          onChange={(e) => setLocale(e.target.value as Locale)}
          id="language-select"
          className="
            w-full rounded-xl px-4 py-2.5 text-sm
            bg-surface-container-lowest text-on-surface
            border border-outline-variant/20
            focus:outline-none focus:border-primary/60 focus:ring-1 focus:ring-primary/20
            transition-colors cursor-pointer
          "
        >
          {LOCALE_OPTIONS.map(({ value, label }) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </Card>

      <Card variant="solid" className="space-y-4 p-4 sm:p-6">
        <div className="space-y-1">
          <h3 className="text-xs uppercase tracking-widest font-bold text-on-surface-variant/80 font-label">
            {workspace.settingsLabel}
          </h3>
          <p className="text-sm text-on-surface-variant/60">{workspace.settingsDescription}</p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <button
            type="button"
            onClick={() => setWorkdirPickerOpen(true)}
            className="flex min-w-0 flex-1 items-center gap-3 rounded-xl border border-outline-variant/20 bg-surface-container-lowest px-3 py-2.5 text-left transition-colors hover:border-primary/35"
            title={workspaceSettings.defaultWorkdir || workspace.defaultEmpty}
          >
            <FolderOpen size={17} className="shrink-0 text-primary/80" />
            <span className="min-w-0 flex-1">
              <span className="block font-label text-[10px] font-bold uppercase tracking-widest text-on-surface-variant/55">
                {workspace.defaultLabel}
              </span>
              <span className="block truncate font-mono text-xs text-on-surface">
                {workspaceSettings.defaultWorkdir || workspace.defaultEmpty}
              </span>
            </span>
          </button>
          <div className="flex gap-2">
            <Button type="button" variant="secondary" onClick={() => setWorkdirPickerOpen(true)}>
              {workspace.changeDefault}
            </Button>
            {workspaceSettings.defaultWorkdir ? (
              <Button
                type="button"
                variant="ghost"
                onClick={() => setDefaultWorkdir('')}
                aria-label={workspace.clearDefault}
                title={workspace.clearDefault}
              >
                <X size={16} />
              </Button>
            ) : null}
          </div>
        </div>
        <div className="flex items-start justify-between gap-4 border-t border-outline-variant/15 pt-4">
          <div className="space-y-1">
            <p className="text-sm font-medium text-on-surface">{workspace.restrictToolsLabel}</p>
            <p className="text-sm text-on-surface-variant/60">
              {workspace.restrictToolsDescription}
            </p>
          </div>
          <input
            type="checkbox"
            checked={workspaceSettings.restrictToolsToWorkdir}
            onChange={(event) => setRestrictToolsToWorkdir(event.target.checked)}
            aria-label={workspace.restrictToolsLabel}
            className="mt-1 h-4 w-4 shrink-0 rounded border-outline-variant/30 accent-primary"
          />
        </div>
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
      </Card>

      <Card variant="solid" className="space-y-4 p-4 sm:p-6">
        <div className="flex items-start gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <PanelRight size={18} />
          </span>
          <div className="min-w-0 flex-1 space-y-1">
            <h3 className="font-label text-xs font-bold uppercase tracking-widest text-on-surface-variant/80">
              {workspace.sidePanelTitle}
            </h3>
            <p className="text-sm text-on-surface-variant/60">{workspace.sidePanelDescription}</p>
          </div>
        </div>

        <div className="overflow-hidden rounded-2xl border border-outline-variant/20 bg-surface-container-lowest">
          {workspaceSettings.sidePanel.panelOrder.map((panelId, index) => {
            const Icon = panelIcons[panelId];
            const label = panelLabels[panelId];
            const isVisible = workspaceSettings.sidePanel.visiblePanelIds.includes(panelId);
            return (
              <div
                key={panelId}
                className="flex items-center gap-3 border-b border-outline-variant/15 px-3 py-2.5 last:border-b-0"
              >
                <input
                  type="checkbox"
                  checked={isVisible}
                  onChange={(event) => setWorkspacePanelVisible(panelId, event.target.checked)}
                  aria-label={workspace.sidePanelShow.replace('{panel}', label)}
                  className="size-4 shrink-0 rounded border-outline-variant/30 accent-primary"
                />
                <Icon size={17} className="shrink-0 text-primary/80" />
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-on-surface">
                  {label}
                </span>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => moveWorkspacePanel(panelId, 'up')}
                    disabled={index === 0}
                    aria-label={workspace.sidePanelMoveUp.replace('{panel}', label)}
                    className="flex size-8 items-center justify-center rounded-lg text-on-surface-variant transition-colors hover:bg-surface-container-high hover:text-on-surface disabled:opacity-25"
                  >
                    <ArrowUp size={15} />
                  </button>
                  <button
                    type="button"
                    onClick={() => moveWorkspacePanel(panelId, 'down')}
                    disabled={index === workspaceSettings.sidePanel.panelOrder.length - 1}
                    aria-label={workspace.sidePanelMoveDown.replace('{panel}', label)}
                    className="flex size-8 items-center justify-center rounded-lg text-on-surface-variant transition-colors hover:bg-surface-container-high hover:text-on-surface disabled:opacity-25"
                  >
                    <ArrowDown size={15} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        <div className="flex items-center justify-between gap-3 text-xs text-on-surface-variant/60">
          <span>
            {workspace.sidePanelWidth.replace('{width}', String(workspaceSettings.sidePanel.width))}
          </span>
          {workspaceSettings.sidePanel.width !== WORKSPACE_PANEL_WIDTH_DEFAULT ? (
            <button
              type="button"
              onClick={() => setWorkspacePanelWidth(WORKSPACE_PANEL_WIDTH_DEFAULT)}
              className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-on-surface-variant transition-colors hover:bg-surface-container-high hover:text-on-surface"
            >
              <RotateCcw size={13} />
              {workspace.sidePanelResetWidth}
            </button>
          ) : null}
        </div>
      </Card>

      {/* ── Default Image Quality ── */}
      <Card variant="solid" className="space-y-3 p-4 sm:p-6">
        <h3 className="text-xs uppercase tracking-widest font-bold text-on-surface-variant/80 font-label">
          {s.imageQualityLabel}
        </h3>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {IMAGE_QUALITY_OPTIONS.map((q) => (
            <Button
              key={q}
              variant={imageQuality === q ? 'primary' : 'secondary'}
              size="md"
              onClick={() => setImageQuality(q)}
            >
              {q}
            </Button>
          ))}
        </div>
      </Card>

      <Card variant="solid" className="space-y-4 p-4 sm:p-6">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <h3 className="text-xs uppercase tracking-widest font-bold text-on-surface-variant/80 font-label">
              {s.multiAgentLabel}
            </h3>
            <p className="text-sm text-on-surface-variant/60">{s.multiAgentDescription}</p>
          </div>
          <input
            type="checkbox"
            checked={multiAgentSettings.enabled}
            onChange={(event) => setMultiAgentEnabled(event.target.checked)}
            aria-label={s.multiAgentEnabledLabel}
            className="mt-1 h-4 w-4 rounded border-outline-variant/30 accent-primary"
          />
        </div>

        <label className="flex items-center gap-2 rounded-xl border border-outline-variant/20 bg-surface-container-lowest px-3 py-2 text-sm text-on-surface">
          <input
            type="checkbox"
            checked={multiAgentSettings.chatDelegationEnabled}
            onChange={(event) => setChatDelegationEnabled(event.target.checked)}
            disabled={!multiAgentSettings.enabled}
            className="accent-primary disabled:opacity-50"
          />
          {s.chatDelegationEnabledLabel}
        </label>

        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <label className="block space-y-2">
            <span className="text-sm font-semibold text-on-surface">{s.traceVisibilityLabel}</span>
            <select
              value={multiAgentSettings.traceVisibility}
              onChange={(event) =>
                setTraceVisibility(event.target.value as MultiAgentSettings['traceVisibility'])
              }
              disabled={!multiAgentSettings.enabled}
              className="w-full rounded-xl px-3 py-2 text-sm bg-surface-container-lowest text-on-surface border border-outline-variant/20 focus:outline-none focus:border-primary/60 focus:ring-1 focus:ring-primary/20 disabled:opacity-50"
            >
              <option value="compact">{s.traceVisibilityCompact}</option>
              <option value="full">{s.traceVisibilityFull}</option>
              <option value="off">{s.traceVisibilityOff}</option>
            </select>
          </label>
          <NumberSetting
            label={s.maxDepthLabel}
            value={multiAgentSettings.maxDepth}
            min={0}
            max={3}
            disabled={!multiAgentSettings.enabled}
            onChange={setMaxDelegationDepth}
          />
          <NumberSetting
            label={s.maxSubagentCallsLabel}
            value={multiAgentSettings.maxSubagentCalls}
            min={MAX_SUBAGENT_CALLS_MIN}
            max={MAX_SUBAGENT_CALLS_MAX}
            disabled={!multiAgentSettings.enabled}
            onChange={setMaxSubagentCalls}
          />
          <NumberSetting
            label={s.defaultMaxTurnsLabel}
            value={multiAgentSettings.defaultMaxTurns}
            min={SUBAGENT_MAX_TURNS_MIN}
            max={SUBAGENT_MAX_TURNS_MAX}
            disabled={!multiAgentSettings.enabled}
            onChange={setDefaultSubagentMaxTurns}
          />
        </div>

        <div className="space-y-3">
          <div className="flex flex-col sm:flex-row sm:items-baseline sm:justify-between gap-1 sm:gap-4">
            <label
              htmlFor="subagent-timeout"
              className="text-xs uppercase tracking-widest font-bold text-on-surface-variant/80 font-label"
            >
              {s.timeoutLabel}
            </label>
            <span className="text-sm font-medium text-on-surface">
              {s.secondsHint.replace(
                '{value}',
                String(Math.round(multiAgentSettings.timeoutMs / 1000))
              )}
            </span>
          </div>
          <input
            id="subagent-timeout"
            type="range"
            min={30_000}
            max={900_000}
            step={TIMEOUT_STEP_MS}
            value={multiAgentSettings.timeoutMs}
            onChange={(event) => setSubagentTimeoutMs(Number(event.target.value))}
            disabled={!multiAgentSettings.enabled}
            className="w-full h-2 bg-surface-container-lowest rounded-full appearance-none cursor-pointer accent-primary disabled:cursor-not-allowed disabled:opacity-50"
          />
        </div>
      </Card>

      <Card variant="solid" className="space-y-4 p-4 sm:p-6">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <h3 className="text-xs uppercase tracking-widest font-bold text-on-surface-variant/80 font-label">
              {s.chatTitlesLabel}
            </h3>
            <p className="text-sm text-on-surface-variant/60">{s.chatTitlesDescription}</p>
          </div>
          <input
            type="checkbox"
            checked={chatTitleSettings.autoRenameEnabled}
            onChange={(event) => setChatAutoRenameEnabled(event.target.checked)}
            aria-label={s.chatTitlesToggleLabel}
            className="mt-1 h-4 w-4 rounded border-outline-variant/30 accent-primary"
          />
        </div>

        <div className="space-y-3">
          <label
            htmlFor="chat-title-strategy"
            className="text-xs uppercase tracking-widest font-bold text-on-surface-variant/80 font-label"
          >
            {s.chatTitleSourceLabel}
          </label>
          <select
            id="chat-title-strategy"
            value={chatTitleSettings.strategy}
            onChange={(event) => setChatTitleStrategy(event.target.value as ChatTitleStrategy)}
            disabled={!chatTitleSettings.autoRenameEnabled}
            className="w-full rounded-xl px-4 py-2.5 text-sm bg-surface-container-lowest text-on-surface border border-outline-variant/20 focus:outline-none focus:border-primary/60 focus:ring-1 focus:ring-primary/20 transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
          >
            <option value="prompt_prefix">{s.chatTitleSourcePrompt}</option>
            <option value="model">{s.chatTitleSourceModel}</option>
          </select>
        </div>

        {chatTitleSettings.strategy === 'model' ? (
          <div className="space-y-3">
            <label
              htmlFor="chat-title-model"
              className="text-xs uppercase tracking-widest font-bold text-on-surface-variant/80 font-label"
            >
              {s.chatTitleModelLabel}
            </label>
            <p className="text-sm text-on-surface-variant/60">{s.chatTitleModelDescription}</p>
            <select
              id="chat-title-model"
              value={chatTitleSettings.preferredModel}
              onChange={(event) => setPreferredChatTitleModel(event.target.value)}
              disabled={!chatTitleSettings.autoRenameEnabled}
              className="w-full rounded-xl px-4 py-2.5 text-sm bg-surface-container-lowest text-on-surface border border-outline-variant/20 focus:outline-none focus:border-primary/60 focus:ring-1 focus:ring-primary/20 transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
            >
              <option value="current_model">{s.chatTitleModelCurrent}</option>
              {missingTitleModelOption.map((model) => (
                <option key={model.modelId} value={model.modelId}>
                  {model.displayName}
                </option>
              ))}
              {availableTitleModels.map((model) => (
                <option key={model.modelId} value={model.modelId}>
                  {model.displayName}
                </option>
              ))}
            </select>
          </div>
        ) : null}

        <div className="space-y-3">
          <div className="flex flex-col sm:flex-row sm:items-baseline sm:justify-between gap-1 sm:gap-4">
            <label
              htmlFor="chat-title-prefix-length"
              className="text-xs uppercase tracking-widest font-bold text-on-surface-variant/80 font-label"
            >
              {s.chatTitlePrefixLengthLabel}
            </label>
            <span className="text-sm font-medium text-on-surface">
              {s.chatTitlePrefixLengthHint.replace(
                '{value}',
                String(chatTitleSettings.promptPrefixLength)
              )}
            </span>
          </div>
          <p className="text-sm text-on-surface-variant/60">{s.chatTitlePrefixLengthDescription}</p>
          <input
            id="chat-title-prefix-length"
            type="range"
            min={PROMPT_PREFIX_LENGTH_MIN}
            max={PROMPT_PREFIX_LENGTH_MAX}
            step={1}
            value={chatTitleSettings.promptPrefixLength}
            onChange={(event) => setChatTitlePromptPrefixLength(Number(event.target.value))}
            disabled={!chatTitleSettings.autoRenameEnabled}
            className="w-full h-2 bg-surface-container-lowest rounded-full appearance-none cursor-pointer accent-primary disabled:cursor-not-allowed disabled:opacity-50"
          />
        </div>
      </Card>
    </div>
  );
}

function NumberSetting({
  label,
  value,
  min,
  max,
  disabled,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  disabled: boolean;
  onChange: (value: number) => void;
}) {
  return (
    <label className="block space-y-2">
      <span className="text-sm font-semibold text-on-surface">{label}</span>
      <input
        type="number"
        min={min}
        max={max}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
        className="w-full rounded-xl border border-outline-variant/20 bg-surface-container-lowest px-3 py-2 text-sm text-on-surface focus:border-primary/60 focus:outline-none focus:ring-1 focus:ring-primary/20 disabled:opacity-50"
      />
    </label>
  );
}
