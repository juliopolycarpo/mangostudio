export type FixedRuleFileKind = 'agents' | 'claude';

export type PromptInjectionRole = 'system' | 'user';

export type PromptSendFrequency = 'first-turn' | 'every-turn';

export interface RuleFileSetting {
  id: string;
  label: string;
  path: string;
  enabled: boolean;
  injectionRole: PromptInjectionRole;
  sendFrequency: PromptSendFrequency;
}

export interface PromptSettings {
  textSystemPrompt: string;
  imageSystemPrompt: string;
  agentsMd: RuleFileSetting;
  claudeMd: RuleFileSetting;
  customRules: RuleFileSetting[];
}

export interface RuleFileDescriptor {
  kind?: FixedRuleFileKind;
  label: string;
  path: string;
  exists: boolean;
  readable: boolean;
  sizeBytes?: number;
  error?: string;
}

export interface RuleFilePreviewBody {
  path: string;
}

export interface RuleFilePreviewResponse extends RuleFileDescriptor {
  content?: string;
  truncated: boolean;
}
