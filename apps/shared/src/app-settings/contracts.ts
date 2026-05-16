import type { ContextSettings } from '../chat';
import type { PromptSettings } from '../prompt-rules';
import type { ReasoningEffort } from '../types';

export type ImageQuality = '512px' | '1K' | '2K' | '4K';
export type ChatTitleStrategy = 'prompt_prefix' | 'model';

export interface ChatTitleSettings {
  autoRenameEnabled: boolean;
  strategy: ChatTitleStrategy;
  promptPrefixLength: number;
  preferredModel: string;
}

export interface MultiAgentSettings {
  enabled: boolean;
  chatDelegationEnabled: boolean;
  traceVisibility: 'compact' | 'full' | 'off';
  maxDepth: number;
  maxSubagentCalls: number;
  timeoutMs: number;
  defaultMaxTurns: number;
}

export interface AppSettings {
  promptSettings: PromptSettings;
  globalImageQuality: ImageQuality;
  thinkingEnabled: boolean;
  reasoningEffort: ReasoningEffort;
  maxToolIterations: number;
  multiAgentSettings: MultiAgentSettings;
  contextSettings: ContextSettings;
  chatTitleSettings: ChatTitleSettings;
}
