import type { ContextCompactionBehavior, ContextSettings } from '../chat';
import type {
  PromptInjectionRole,
  PromptSendFrequency,
  PromptSettings,
  RuleFileSetting,
} from '../prompt-rules';
import type { ReasoningEffort } from '../types';
import type { AppSettings, ImageQuality } from './contracts';

export const IMAGE_QUALITY_OPTIONS = ['512px', '1K', '2K', '4K'] as const;

export const MAX_TOOL_ITERATIONS_MIN = 1;
export const MAX_TOOL_ITERATIONS_MAX = 25;
export const MAX_TOOL_ITERATIONS_DEFAULT = 10;

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

export const DEFAULT_APP_SETTINGS: AppSettings = {
  promptSettings: DEFAULT_PROMPT_SETTINGS,
  globalImageQuality: '1K',
  thinkingEnabled: false,
  reasoningEffort: 'medium',
  maxToolIterations: MAX_TOOL_ITERATIONS_DEFAULT,
  contextSettings: DEFAULT_CONTEXT_SETTINGS,
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

function clampThreshold(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(0.99, Math.max(0.5, Math.round(value * 100) / 100));
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
    contextSettings: normalizeContextSettings(value.contextSettings),
  };
}
