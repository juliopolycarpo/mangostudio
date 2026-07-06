import type { MarkdownFrontmatter } from '../markdown/frontmatter';
import { parseMarkdownFrontmatter } from '../markdown/frontmatter';
import type { AgentId, AgentProfile, AgentRole } from './schemas';

const BUILT_IN_AGENT_IDS = ['chat', 'default', 'explore'] as const;
const AGENT_ROLE_VALUES = ['primary', 'subagent', 'both'] as const;
const REASONING_EFFORT_VALUES = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
const USER_AGENT_ID_PATTERN = /^user:[a-z0-9]+(?:-[a-z0-9]+)*$/;

export class AgentProfileValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentProfileValidationError';
  }
}

export interface ParseAgentMarkdownOptions {
  readonly id: AgentId;
  readonly path?: string;
}

export const BUILT_IN_CHAT_AGENT: AgentProfile = Object.freeze({
  id: 'chat',
  name: 'Chat',
  description: 'General-purpose conversational chat agent.',
  kind: 'builtin',
  role: 'primary',
  source: { type: 'builtin' as const },
  systemPrompt: '',
  toolNames: [],
  toolsEnabled: true,
  subagentIds: [],
  metadata: {},
});

export const BUILT_IN_DEFAULT_AGENT: AgentProfile = Object.freeze({
  id: 'default',
  name: 'Default',
  description: 'Default task-focused agent profile.',
  kind: 'builtin',
  role: 'both',
  source: { type: 'builtin' as const },
  systemPrompt: '',
  toolNames: [],
  toolsEnabled: true,
  subagentIds: ['explore'] as const,
  metadata: {},
});

export const BUILT_IN_EXPLORE_AGENT: AgentProfile = Object.freeze({
  id: 'explore',
  name: 'Explore',
  description: 'Built-in subagent for bounded research and codebase exploration.',
  kind: 'builtin',
  role: 'subagent',
  source: { type: 'builtin' as const },
  systemPrompt:
    'Explore the requested problem space carefully. Gather relevant context, inspect available files or tools when useful, and return a concise, concrete final report.\n\nFinal report requirements:\n- Always end with a "Final Report" section.\n- Include: key findings, relevant file paths, tools/commands used, risks or unknowns, and recommended next steps.\n- Do not make changes unless explicitly asked.',
  toolNames: [],
  toolsEnabled: true,
  subagentIds: [],
  metadata: {},
});

export const BUILT_IN_AGENT_PROFILES: ReadonlyArray<AgentProfile> = Object.freeze([
  BUILT_IN_CHAT_AGENT,
  BUILT_IN_DEFAULT_AGENT,
  BUILT_IN_EXPLORE_AGENT,
]);

export function isAgentId(value: unknown): value is AgentId {
  return typeof value === 'string' && isValidAgentId(value);
}

export function assertAgentProfile(profile: AgentProfile): AgentProfile {
  if (!isValidAgentId(profile.id)) {
    throw new AgentProfileValidationError('Agent id must be chat, default, or user:<slug>.');
  }

  if (!profile.name.trim()) {
    throw new AgentProfileValidationError('Agent name must not be blank.');
  }

  if (!isAgentRole(profile.role)) {
    throw new AgentProfileValidationError('Agent role must be primary, subagent, or both.');
  }

  return profile;
}

export function parseAgentMarkdown(
  markdown: string,
  options: ParseAgentMarkdownOptions
): AgentProfile {
  if (!isValidAgentId(options.id)) {
    throw new AgentProfileValidationError('Agent id must be chat, default, or user:<slug>.');
  }

  const { frontmatter, body } = parseMarkdownFrontmatter(markdown);
  const name = resolveAgentName(frontmatter.name, options.id);
  const role = resolveAgentRole(frontmatter.role, frontmatter.mode);
  const toolNames = normalizeStringList(frontmatter.tools);
  const subagentIds = normalizeStringList(frontmatter.subagents).filter(isAgentId);
  const model = optionalString(frontmatter.model);
  const profile: AgentProfile = {
    id: options.id,
    name,
    description: optionalString(frontmatter.description) ?? '',
    kind: isBuiltInAgentId(options.id) ? 'builtin' : 'user',
    role,
    source: options.path ? { type: 'markdown', path: options.path } : { type: 'markdown' },
    systemPrompt: body.trim(),
    ...(model ? { model } : {}),
    toolNames,
    toolsEnabled: toolNames.length > 0,
    subagentIds,
    metadata: extractAgentMetadata(frontmatter),
  };

  return assertAgentProfile(profile);
}

function resolveAgentRole(roleValue: unknown, modeValue: unknown): AgentRole {
  if (isAgentRole(roleValue)) {
    return roleValue;
  }

  if (modeValue === 'subagent') {
    return 'subagent';
  }

  if (modeValue === 'primary') {
    return 'primary';
  }

  if (roleValue !== undefined) {
    throw new AgentProfileValidationError('Agent role must be primary, subagent, or both.');
  }

  return 'primary';
}

function extractAgentMetadata(frontmatter: MarkdownFrontmatter): MarkdownFrontmatter {
  const metadata: MarkdownFrontmatter = {};
  for (const [key, value] of Object.entries(frontmatter)) {
    if (!['name', 'description', 'model', 'tools', 'role', 'mode', 'subagents'].includes(key)) {
      metadata[key] = value;
    }
  }
  return metadata;
}

function resolveAgentName(value: unknown, id: AgentId): string {
  if (value === undefined) {
    return slugNameFromId(id);
  }

  if (typeof value !== 'string' || !value.trim()) {
    throw new AgentProfileValidationError('Agent name must not be blank.');
  }

  return value.trim();
}

function normalizeStringList(value: unknown): ReadonlyArray<string> {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }

  if (typeof value === 'string') {
    return value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }

  return [];
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmedValue = value.trim();
  return trimmedValue ? trimmedValue : undefined;
}

function slugNameFromId(id: AgentId): string {
  if (id === 'chat') {
    return BUILT_IN_CHAT_AGENT.name;
  }

  if (id === 'default') {
    return BUILT_IN_DEFAULT_AGENT.name;
  }

  return id
    .slice('user:'.length)
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function isValidAgentId(value: string): value is AgentId {
  return isBuiltInAgentId(value) || USER_AGENT_ID_PATTERN.test(value);
}

function isBuiltInAgentId(value: string): value is 'chat' | 'default' {
  return BUILT_IN_AGENT_IDS.some((agentId) => agentId === value);
}

function isAgentRole(value: unknown): value is AgentRole {
  return AGENT_ROLE_VALUES.some((role) => role === value);
}

export function isReasoningEffort(value: unknown): value is AgentProfile['reasoningEffort'] {
  return REASONING_EFFORT_VALUES.some((effort) => effort === value);
}
