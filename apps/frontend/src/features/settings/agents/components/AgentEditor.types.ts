import type {
  AgentId,
  AgentProfile,
  AgentProfileUpsertBody,
  AgentRole,
} from '@mangostudio/shared/agents';
import type { ToolSettingsDescriptor } from '@mangostudio/shared/tool-settings';

export type AgentEditorMode = 'friendly' | 'raw';

export interface EditableAgentProfile extends AgentProfile {
  readonly slug?: string;
}

export interface AgentEditorLabels {
  readonly builtIn: string;
  readonly user: string;
  readonly createTitle: string;
  readonly name: string;
  readonly slug: string;
  readonly description: string;
  readonly role: string;
  readonly roles: Record<AgentRole, string>;
  readonly systemPrompt: string;
  readonly model: string;
  readonly modelDefaultOption: string;
  readonly thinking: string;
  readonly reasoningEffort: string;
  readonly reasoningEfforts: Record<NonNullable<AgentProfile['reasoningEffort']>, string>;
  readonly maxToolIterations: string;
  readonly toolsEnabled: string;
  readonly toolAllowlist: string;
  readonly noTools: string;
  readonly subagents: string;
  readonly noSubagents: string;
  readonly path: string;
  readonly friendlyMode: string;
  readonly rawMode: string;
  readonly rawMarkdown: string;
  readonly preview: string;
  readonly previewing: string;
  readonly save: string;
  readonly saving: string;
  readonly reset: string;
  readonly delete: string;
  readonly sectionIdentity: string;
  readonly sectionBehavior: string;
  readonly sectionReasoning: string;
  readonly sectionTools: string;
  readonly unsavedChanges: string;
  readonly confirmResetTitle: string;
  readonly confirmResetDescription: string;
  readonly confirmReset: string;
  readonly cancel: string;
}

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
