import {
  MAX_SUBAGENT_CALLS_DEFAULT,
  MAX_SUBAGENT_CALLS_MAX,
  MAX_SUBAGENT_CALLS_MIN,
  MAX_TOOL_ITERATIONS_DEFAULT,
  MAX_TOOL_ITERATIONS_MAX,
  MAX_TOOL_ITERATIONS_MIN,
  SUBAGENT_MAX_TURNS_DEFAULT,
  SUBAGENT_MAX_TURNS_MAX,
  SUBAGENT_MAX_TURNS_MIN,
} from '../agentic-limits';
import type { ContextCompactionBehavior, ContextSettings } from '../chat';
import { CHAT_TITLE_PROMPT_LENGTH_DEFAULT, clampChatTitlePromptLength } from '../chat/title';
import {
  COMMIT_MESSAGE_MAX_DIFF_KB_DEFAULT,
  COMMIT_MESSAGE_MAX_DIFF_KB_MAX,
  COMMIT_MESSAGE_MAX_DIFF_KB_MIN,
  DEFAULT_COMMIT_MESSAGE_PROMPT,
} from '../git/commit-message';
import type {
  PromptInjectionRole,
  PromptSendFrequency,
  PromptSettings,
  RuleFileSetting,
} from '../prompt-rules';
import type { ReasoningEffort } from '../types';
import {
  RECENT_WORKDIRS_MAX,
  WORKSPACE_PANEL_IDS,
  WORKSPACE_PANEL_WIDTH_DEFAULT,
  WORKSPACE_PANEL_WIDTH_MAX,
  WORKSPACE_PANEL_WIDTH_MIN,
  type WorkspacePanelId,
  type WorkspaceSettings,
} from '../workspaces';
import type {
  AppSettings,
  ChatTitleSettings,
  GitSettings,
  ImageQuality,
  MultiAgentSettings,
  SkillSourceSettings,
} from './schemas';

const CURRENT_MODEL_SETTING = 'current_model';

export const IMAGE_QUALITY_OPTIONS = ['512px', '1K', '2K', '4K'] as const;

export {
  MAX_SUBAGENT_CALLS_DEFAULT,
  MAX_SUBAGENT_CALLS_MAX,
  MAX_SUBAGENT_CALLS_MIN,
  MAX_TOOL_ITERATIONS_DEFAULT,
  MAX_TOOL_ITERATIONS_MAX,
  MAX_TOOL_ITERATIONS_MIN,
  SUBAGENT_MAX_TURNS_DEFAULT,
  SUBAGENT_MAX_TURNS_MAX,
  SUBAGENT_MAX_TURNS_MIN,
};

export const DEFAULT_PROMPT_SETTINGS: PromptSettings = {
  textSystemPrompt: '',
  imageSystemPrompt: '',
  agentsMd: {
    id: 'agentsMd',
    label: 'AGENTS.md',
    path: '~/.mango/AGENTS.md',
    enabled: false,
    injectionRole: 'system',
    sendFrequency: 'first-turn',
  },
  claudeMd: {
    id: 'claudeMd',
    label: 'CLAUDE.md',
    path: '~/.claude/CLAUDE.md',
    enabled: false,
    injectionRole: 'system',
    sendFrequency: 'first-turn',
  },
  customRules: [],
};

export const DEFAULT_CONTEXT_SETTINGS: ContextSettings = {
  compactionBehavior: 'ask',
  warningThreshold: 0.85,
  dangerThreshold: 0.92,
  hardStopThreshold: 0.97,
  preferredSummaryModel: 'current_model',
  providerCompactionEnabled: true,
};

export const DEFAULT_CHAT_TITLE_SETTINGS: ChatTitleSettings = {
  autoRenameEnabled: true,
  strategy: 'prompt_prefix',
  promptPrefixLength: CHAT_TITLE_PROMPT_LENGTH_DEFAULT,
  preferredModel: CURRENT_MODEL_SETTING,
};

export const DEFAULT_MULTI_AGENT_SETTINGS: MultiAgentSettings = {
  enabled: true,
  chatDelegationEnabled: false,
  traceVisibility: 'compact',
  maxDepth: 1,
  maxSubagentCalls: MAX_SUBAGENT_CALLS_DEFAULT,
  timeoutMs: 15 * 60 * 1000,
  defaultMaxTurns: SUBAGENT_MAX_TURNS_DEFAULT,
};

export const DEFAULT_SKILL_SOURCE_SETTINGS: SkillSourceSettings = {
  agents: false,
  claude: false,
};

export const DEFAULT_WORKSPACE_SETTINGS: WorkspaceSettings = {
  defaultWorkdir: '',
  recentWorkdirs: [],
  restrictToolsToWorkdir: false,
  sidePanel: {
    visiblePanelIds: [...WORKSPACE_PANEL_IDS],
    panelOrder: [...WORKSPACE_PANEL_IDS],
    width: WORKSPACE_PANEL_WIDTH_DEFAULT,
  },
};

export const DEFAULT_GIT_SETTINGS: GitSettings = {
  signCommits: false,
  signOff: false,
  commitMessage: {
    preferredModel: '',
    systemPrompt: DEFAULT_COMMIT_MESSAGE_PROMPT,
    maxDiffKb: COMMIT_MESSAGE_MAX_DIFF_KB_DEFAULT,
  },
};

export const DEFAULT_APP_SETTINGS: AppSettings = {
  promptSettings: DEFAULT_PROMPT_SETTINGS,
  globalImageQuality: '1K',
  thinkingEnabled: false,
  reasoningEffort: 'medium',
  maxToolIterations: MAX_TOOL_ITERATIONS_DEFAULT,
  multiAgentSettings: DEFAULT_MULTI_AGENT_SETTINGS,
  contextSettings: DEFAULT_CONTEXT_SETTINGS,
  chatTitleSettings: DEFAULT_CHAT_TITLE_SETTINGS,
  skillSources: DEFAULT_SKILL_SOURCE_SETTINGS,
  workspaceSettings: DEFAULT_WORKSPACE_SETTINGS,
  gitSettings: DEFAULT_GIT_SETTINGS,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPromptInjectionRole(value: unknown): value is PromptInjectionRole {
  return value === 'system' || value === 'user';
}

function isPromptSendFrequency(value: unknown): value is PromptSendFrequency {
  return value === 'first-turn' || value === 'every-turn';
}

function isContextCompactionBehavior(value: unknown): value is ContextCompactionBehavior {
  return (
    value === 'ask' ||
    value === 'auto_compact_current_chat' ||
    value === 'continue_with_summary_new_chat' ||
    value === 'off'
  );
}

function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return (
    value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'xhigh' ||
    value === 'max'
  );
}

function isImageQuality(value: unknown): value is ImageQuality {
  return typeof value === 'string' && IMAGE_QUALITY_OPTIONS.includes(value as ImageQuality);
}

function isChatTitleStrategy(value: unknown): value is ChatTitleSettings['strategy'] {
  return value === 'prompt_prefix' || value === 'model';
}

function isTraceVisibility(value: unknown): value is MultiAgentSettings['traceVisibility'] {
  return value === 'compact' || value === 'full' || value === 'off';
}

function clampThreshold(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(0.99, Math.max(0.5, Math.round(value * 100) / 100));
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function normalizeRuleFileSetting(value: unknown, fallback: RuleFileSetting): RuleFileSetting {
  if (!isRecord(value)) return fallback;

  return {
    id: typeof value.id === 'string' && value.id.length > 0 ? value.id : fallback.id,
    label: typeof value.label === 'string' ? value.label : fallback.label,
    path: typeof value.path === 'string' ? value.path : fallback.path,
    enabled: typeof value.enabled === 'boolean' ? value.enabled : fallback.enabled,
    injectionRole: isPromptInjectionRole(value.injectionRole)
      ? value.injectionRole
      : fallback.injectionRole,
    sendFrequency: isPromptSendFrequency(value.sendFrequency)
      ? value.sendFrequency
      : fallback.sendFrequency,
  };
}

export function normalizePromptSettings(value: unknown): PromptSettings {
  if (!isRecord(value)) return DEFAULT_PROMPT_SETTINGS;

  return {
    textSystemPrompt: typeof value.textSystemPrompt === 'string' ? value.textSystemPrompt : '',
    imageSystemPrompt: typeof value.imageSystemPrompt === 'string' ? value.imageSystemPrompt : '',
    agentsMd: normalizeRuleFileSetting(value.agentsMd, DEFAULT_PROMPT_SETTINGS.agentsMd),
    claudeMd: normalizeRuleFileSetting(value.claudeMd, DEFAULT_PROMPT_SETTINGS.claudeMd),
    customRules: Array.isArray(value.customRules)
      ? value.customRules.map((rule, index) =>
          normalizeRuleFileSetting(rule, {
            id: `custom-rule-${index + 1}`,
            label: '',
            path: '',
            enabled: false,
            injectionRole: 'system',
            sendFrequency: 'first-turn',
          })
        )
      : [],
  };
}

export function clampMaxToolIterations(value: number): number {
  if (!Number.isFinite(value)) return MAX_TOOL_ITERATIONS_DEFAULT;

  const rounded = Math.round(value);
  if (rounded < MAX_TOOL_ITERATIONS_MIN) return MAX_TOOL_ITERATIONS_MIN;
  if (rounded > MAX_TOOL_ITERATIONS_MAX) return MAX_TOOL_ITERATIONS_MAX;
  return rounded;
}

export function normalizeContextSettings(value: unknown): ContextSettings {
  if (!isRecord(value)) return DEFAULT_CONTEXT_SETTINGS;

  const warningThreshold = clampThreshold(
    typeof value.warningThreshold === 'number'
      ? value.warningThreshold
      : DEFAULT_CONTEXT_SETTINGS.warningThreshold,
    DEFAULT_CONTEXT_SETTINGS.warningThreshold
  );
  const dangerThreshold = clampThreshold(
    typeof value.dangerThreshold === 'number'
      ? value.dangerThreshold
      : DEFAULT_CONTEXT_SETTINGS.dangerThreshold,
    DEFAULT_CONTEXT_SETTINGS.dangerThreshold
  );
  const hardStopThreshold = clampThreshold(
    typeof value.hardStopThreshold === 'number'
      ? value.hardStopThreshold
      : DEFAULT_CONTEXT_SETTINGS.hardStopThreshold,
    DEFAULT_CONTEXT_SETTINGS.hardStopThreshold
  );
  const [normalizedWarning, normalizedDanger, normalizedHardStop] = [
    warningThreshold,
    dangerThreshold,
    hardStopThreshold,
  ].sort((left, right) => left - right);

  return {
    compactionBehavior: isContextCompactionBehavior(value.compactionBehavior)
      ? value.compactionBehavior
      : DEFAULT_CONTEXT_SETTINGS.compactionBehavior,
    warningThreshold: normalizedWarning,
    dangerThreshold: normalizedDanger,
    hardStopThreshold: normalizedHardStop,
    preferredSummaryModel:
      typeof value.preferredSummaryModel === 'string' && value.preferredSummaryModel.length > 0
        ? value.preferredSummaryModel
        : DEFAULT_CONTEXT_SETTINGS.preferredSummaryModel,
    providerCompactionEnabled:
      typeof value.providerCompactionEnabled === 'boolean'
        ? value.providerCompactionEnabled
        : DEFAULT_CONTEXT_SETTINGS.providerCompactionEnabled,
  };
}

export function normalizeChatTitleSettings(value: unknown): ChatTitleSettings {
  if (!isRecord(value)) return DEFAULT_CHAT_TITLE_SETTINGS;

  return {
    autoRenameEnabled:
      typeof value.autoRenameEnabled === 'boolean'
        ? value.autoRenameEnabled
        : DEFAULT_CHAT_TITLE_SETTINGS.autoRenameEnabled,
    strategy: isChatTitleStrategy(value.strategy)
      ? value.strategy
      : DEFAULT_CHAT_TITLE_SETTINGS.strategy,
    promptPrefixLength: clampChatTitlePromptLength(
      typeof value.promptPrefixLength === 'number'
        ? value.promptPrefixLength
        : DEFAULT_CHAT_TITLE_SETTINGS.promptPrefixLength
    ),
    preferredModel:
      typeof value.preferredModel === 'string' && value.preferredModel.length > 0
        ? value.preferredModel
        : DEFAULT_CHAT_TITLE_SETTINGS.preferredModel,
  };
}

export function normalizeMultiAgentSettings(value: unknown): MultiAgentSettings {
  if (!isRecord(value)) return DEFAULT_MULTI_AGENT_SETTINGS;

  return {
    enabled:
      typeof value.enabled === 'boolean' ? value.enabled : DEFAULT_MULTI_AGENT_SETTINGS.enabled,
    chatDelegationEnabled:
      typeof value.chatDelegationEnabled === 'boolean'
        ? value.chatDelegationEnabled
        : DEFAULT_MULTI_AGENT_SETTINGS.chatDelegationEnabled,
    traceVisibility: isTraceVisibility(value.traceVisibility)
      ? value.traceVisibility
      : DEFAULT_MULTI_AGENT_SETTINGS.traceVisibility,
    maxDepth: clampInteger(value.maxDepth, DEFAULT_MULTI_AGENT_SETTINGS.maxDepth, 0, 3),
    maxSubagentCalls: clampInteger(
      value.maxSubagentCalls,
      DEFAULT_MULTI_AGENT_SETTINGS.maxSubagentCalls,
      MAX_SUBAGENT_CALLS_MIN,
      MAX_SUBAGENT_CALLS_MAX
    ),
    timeoutMs: clampInteger(
      value.timeoutMs,
      DEFAULT_MULTI_AGENT_SETTINGS.timeoutMs,
      1_000,
      3_600_000
    ),
    defaultMaxTurns: clampInteger(
      value.defaultMaxTurns,
      DEFAULT_MULTI_AGENT_SETTINGS.defaultMaxTurns,
      SUBAGENT_MAX_TURNS_MIN,
      SUBAGENT_MAX_TURNS_MAX
    ),
  };
}

export function normalizeSkillSourceSettings(value: unknown): SkillSourceSettings {
  if (!isRecord(value)) return DEFAULT_SKILL_SOURCE_SETTINGS;

  return {
    agents: typeof value.agents === 'boolean' ? value.agents : DEFAULT_SKILL_SOURCE_SETTINGS.agents,
    claude: typeof value.claude === 'boolean' ? value.claude : DEFAULT_SKILL_SOURCE_SETTINGS.claude,
  };
}

export function normalizeWorkspaceSettings(value: unknown): WorkspaceSettings {
  if (!isRecord(value)) return DEFAULT_WORKSPACE_SETTINGS;

  const recentWorkdirs = Array.isArray(value.recentWorkdirs)
    ? Array.from(
        new Set(
          value.recentWorkdirs.filter(
            (workdir): workdir is string => typeof workdir === 'string' && workdir.length > 0
          )
        )
      ).slice(0, RECENT_WORKDIRS_MAX)
    : [];

  const sidePanel = isRecord(value.sidePanel) ? value.sidePanel : {};
  const visiblePanelIds = normalizeWorkspacePanelIds(
    sidePanel.visiblePanelIds,
    DEFAULT_WORKSPACE_SETTINGS.sidePanel.visiblePanelIds
  );
  const panelOrder = normalizeWorkspacePanelIds(
    sidePanel.panelOrder,
    DEFAULT_WORKSPACE_SETTINGS.sidePanel.panelOrder
  );
  for (const panelId of WORKSPACE_PANEL_IDS) {
    if (!panelOrder.includes(panelId)) panelOrder.push(panelId);
  }

  return {
    defaultWorkdir: typeof value.defaultWorkdir === 'string' ? value.defaultWorkdir : '',
    recentWorkdirs,
    restrictToolsToWorkdir:
      typeof value.restrictToolsToWorkdir === 'boolean'
        ? value.restrictToolsToWorkdir
        : DEFAULT_WORKSPACE_SETTINGS.restrictToolsToWorkdir,
    sidePanel: {
      visiblePanelIds,
      panelOrder,
      width: clampInteger(
        sidePanel.width,
        WORKSPACE_PANEL_WIDTH_DEFAULT,
        WORKSPACE_PANEL_WIDTH_MIN,
        WORKSPACE_PANEL_WIDTH_MAX
      ),
    },
  };
}

function normalizeWorkspacePanelIds(
  value: unknown,
  fallback: readonly WorkspacePanelId[]
): WorkspacePanelId[] {
  if (!Array.isArray(value)) return [...fallback];

  return Array.from(
    new Set(
      value.filter(
        (panelId): panelId is WorkspacePanelId =>
          typeof panelId === 'string' && WORKSPACE_PANEL_IDS.includes(panelId as WorkspacePanelId)
      )
    )
  );
}

export function normalizeGitSettings(value: unknown): GitSettings {
  if (!isRecord(value)) return DEFAULT_GIT_SETTINGS;

  const commitMessage = isRecord(value.commitMessage) ? value.commitMessage : {};

  return {
    signCommits:
      typeof value.signCommits === 'boolean' ? value.signCommits : DEFAULT_GIT_SETTINGS.signCommits,
    signOff: typeof value.signOff === 'boolean' ? value.signOff : DEFAULT_GIT_SETTINGS.signOff,
    commitMessage: {
      preferredModel:
        typeof commitMessage.preferredModel === 'string'
          ? commitMessage.preferredModel
          : DEFAULT_GIT_SETTINGS.commitMessage.preferredModel,
      systemPrompt:
        typeof commitMessage.systemPrompt === 'string' &&
        commitMessage.systemPrompt.trim().length > 0
          ? commitMessage.systemPrompt
          : DEFAULT_COMMIT_MESSAGE_PROMPT,
      maxDiffKb: clampInteger(
        commitMessage.maxDiffKb,
        COMMIT_MESSAGE_MAX_DIFF_KB_DEFAULT,
        COMMIT_MESSAGE_MAX_DIFF_KB_MIN,
        COMMIT_MESSAGE_MAX_DIFF_KB_MAX
      ),
    },
  };
}

export function normalizeAppSettings(value: unknown): AppSettings {
  if (!isRecord(value)) return DEFAULT_APP_SETTINGS;

  return {
    promptSettings: normalizePromptSettings(value.promptSettings),
    globalImageQuality: isImageQuality(value.globalImageQuality)
      ? value.globalImageQuality
      : DEFAULT_APP_SETTINGS.globalImageQuality,
    thinkingEnabled:
      typeof value.thinkingEnabled === 'boolean'
        ? value.thinkingEnabled
        : DEFAULT_APP_SETTINGS.thinkingEnabled,
    reasoningEffort: isReasoningEffort(value.reasoningEffort)
      ? value.reasoningEffort
      : DEFAULT_APP_SETTINGS.reasoningEffort,
    maxToolIterations: clampMaxToolIterations(
      typeof value.maxToolIterations === 'number'
        ? value.maxToolIterations
        : DEFAULT_APP_SETTINGS.maxToolIterations
    ),
    multiAgentSettings: normalizeMultiAgentSettings(value.multiAgentSettings),
    contextSettings: normalizeContextSettings(value.contextSettings),
    chatTitleSettings: normalizeChatTitleSettings(value.chatTitleSettings),
    skillSources: normalizeSkillSourceSettings(value.skillSources),
    workspaceSettings: normalizeWorkspaceSettings(value.workspaceSettings),
    gitSettings: normalizeGitSettings(value.gitSettings),
  };
}
