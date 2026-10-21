import type { AgentId, AgentProfile, AgentProfileUpsertBody } from '@mangostudio/shared/agents';
import type { Messages } from '@mangostudio/shared/i18n';
import type { ToolSettingsDescriptor } from '@mangostudio/shared/tool-settings';

export type AgentEditorMode = 'friendly' | 'raw';

export interface EditableAgentProfile extends AgentProfile {
  readonly slug?: string;
}

/**
 * The editor reads its copy straight from the agents page's messages rather
 * than from a hand-copied subset of them, so a new key is one edit, not two.
 */
export type AgentEditorLabels = Messages['settings']['agents'];

export interface AgentEditorProps {
  readonly agent: EditableAgentProfile;
  readonly allAgents: ReadonlyArray<AgentProfile>;
  readonly tools: ReadonlyArray<ToolSettingsDescriptor>;
  readonly modelOptions: ReadonlyArray<ModelSelectOption>;
  readonly labels: AgentEditorLabels;
  readonly isNew: boolean;
  readonly isSaving: boolean;
  readonly isPreviewing: boolean;
  readonly onSave: (agent: EditableAgentProfile, body: AgentProfileUpsertBody) => void;
  readonly onPreviewMarkdown: (markdown: string, agentId: AgentId) => Promise<AgentProfile>;
  readonly onDelete: (agent: AgentProfile) => void;
  readonly onCancelNew: () => void;
}

export interface ModelSelectOption {
  readonly value: string;
  readonly label: string;
}
