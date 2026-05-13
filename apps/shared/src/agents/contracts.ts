export type BuiltInAgentId = 'chat' | 'default';
export type UserAgentId = `user:${string}`;
export type AgentId = BuiltInAgentId | UserAgentId;
export type AgentExecutionMode = 'chat' | 'agent';
export type AgentKind = 'builtin' | 'user';
export type AgentRole = 'primary' | 'subagent' | 'both';

export type AgentSource =
  | { readonly type: 'builtin' }
  | { readonly type: 'markdown'; readonly path?: string };

export type AgentMetadata = Readonly<Record<string, unknown>>;

export interface AgentProfile {
  readonly id: AgentId;
  readonly name: string;
  readonly description: string;
  readonly kind: AgentKind;
  readonly role: AgentRole;
  readonly source: AgentSource;
  readonly systemPrompt: string;
  readonly model?: string;
  readonly thinkingEnabled?: boolean;
  readonly reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  readonly maxToolIterations?: number;
  readonly toolNames: ReadonlyArray<string>;
  readonly toolsEnabled: boolean;
  readonly subagentIds: ReadonlyArray<AgentId>;
  readonly metadata: AgentMetadata;
}

export interface AgentProfileListResponse {
  readonly agents: ReadonlyArray<AgentProfile>;
}

export interface AgentProfileUpsertBody {
  readonly name: string;
  readonly description: string;
  readonly role: AgentRole;
  readonly systemPrompt: string;
  readonly model?: string;
  readonly thinkingEnabled?: boolean;
  readonly reasoningEffort?: AgentProfile['reasoningEffort'];
  readonly maxToolIterations?: number;
  readonly toolNames: ReadonlyArray<string>;
  readonly toolsEnabled: boolean;
  readonly subagentIds: ReadonlyArray<string>;
  readonly metadata: AgentMetadata;
}

export interface CreateAgentProfileBody extends AgentProfileUpsertBody {
  readonly slug?: string;
}

export interface AgentMarkdownPreviewBody {
  readonly markdown: string;
  readonly id?: UserAgentId;
}

export interface AgentMarkdownPreviewResponse {
  readonly profile: AgentProfile;
  readonly markdown: string;
}

export interface DeleteAgentProfileResponse {
  readonly success: true;
}
