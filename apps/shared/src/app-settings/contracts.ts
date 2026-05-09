import type { ContextSettings } from '../chat';
import type { ReasoningEffort } from '../types';
import type { PromptSettings } from '../prompt-rules';

export type ImageQuality = '512px' | '1K' | '2K' | '4K';

export interface ChatTitleSettings {
  autoRenameEnabled: boolean;
  promptPrefixLength: number;
}

export interface AppSettings {
  promptSettings: PromptSettings;
  globalImageQuality: ImageQuality;
  thinkingEnabled: boolean;
  reasoningEffort: ReasoningEffort;
  maxToolIterations: number;
  contextSettings: ContextSettings;
  chatTitleSettings: ChatTitleSettings;
}
