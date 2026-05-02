export type FixedRuleFileKind = 'agents' | 'claude';

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
