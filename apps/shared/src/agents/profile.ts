import type { AgentId, AgentProfile, AgentRole } from './contracts';

const BUILT_IN_AGENT_IDS = ['chat', 'default', 'explore'] as const;
const AGENT_ROLE_VALUES = ['primary', 'subagent', 'both'] as const;
const REASONING_EFFORT_VALUES = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
const USER_AGENT_ID_PATTERN = /^user:[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FRONTMATTER_BOUNDARY = '---';
const ARRAY_ITEM_PREFIX = '- ';

type ParsedFrontmatterValue = string | number | boolean | ReadonlyArray<string>;
type ParsedFrontmatter = Record<string, ParsedFrontmatterValue>;

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
    'Explore the requested problem space carefully. Gather relevant context, inspect available files or tools when useful, and return a concise summary with concrete findings, file paths, risks, and recommended next steps. Do not make changes unless explicitly asked.',
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

  const { frontmatter, body } = parseMarkdownParts(markdown);
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

function parseMarkdownParts(markdown: string): {
  readonly frontmatter: ParsedFrontmatter;
  readonly body: string;
} {
  const lines = markdown.replaceAll('\r\n', '\n').split('\n');
  if (lines[0]?.trim() !== FRONTMATTER_BOUNDARY) {
    return { frontmatter: {}, body: markdown };
  }

  const closingIndex = lines.findIndex(
    (line, index) => index > 0 && line.trim() === FRONTMATTER_BOUNDARY
  );
  if (closingIndex === -1) {
    return { frontmatter: {}, body: markdown };
  }

  return {
    frontmatter: parseFrontmatter(lines.slice(1, closingIndex)),
    body: lines.slice(closingIndex + 1).join('\n'),
  };
}

function parseFrontmatter(lines: ReadonlyArray<string>): ParsedFrontmatter {
  const frontmatter: ParsedFrontmatter = {};
  let arrayKey: string | undefined;

  for (const line of lines) {
    const trimmedLine = line.trim();
    if (!trimmedLine || trimmedLine.startsWith('#')) {
      continue;
    }

    if (arrayKey && trimmedLine.startsWith(ARRAY_ITEM_PREFIX)) {
      const currentValue = frontmatter[arrayKey];
      frontmatter[arrayKey] = [
        ...(isStringArray(currentValue) ? currentValue : []),
        unquote(trimmedLine.slice(ARRAY_ITEM_PREFIX.length).trim()),
      ];
      continue;
    }

    arrayKey = undefined;
    const separatorIndex = trimmedLine.indexOf(':');
    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmedLine.slice(0, separatorIndex).trim();
    const rawValue = trimmedLine.slice(separatorIndex + 1).trim();
    if (!key) {
      continue;
    }

    if (!rawValue) {
      frontmatter[key] = [];
      arrayKey = key;
      continue;
    }

    frontmatter[key] = parseFrontmatterScalar(rawValue);
  }

  return frontmatter;
}

function parseFrontmatterScalar(rawValue: string): ParsedFrontmatterValue {
  if (rawValue.startsWith('[') && rawValue.endsWith(']')) {
    return rawValue
      .slice(1, -1)
      .split(',')
      .map((value) => unquote(value.trim()))
      .filter(Boolean);
  }

  if (rawValue === 'true') {
    return true;
  }

  if (rawValue === 'false') {
    return false;
  }

  const numericValue = Number(rawValue);
  if (Number.isFinite(numericValue) && rawValue !== '') {
    return numericValue;
  }

  return unquote(rawValue);
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

function extractAgentMetadata(frontmatter: ParsedFrontmatter): ParsedFrontmatter {
  const metadata: ParsedFrontmatter = {};
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

function isStringArray(value: unknown): value is ReadonlyArray<string> {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isAgentRole(value: unknown): value is AgentRole {
  return AGENT_ROLE_VALUES.some((role) => role === value);
}

function unquote(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}

export function isReasoningEffort(value: unknown): value is AgentProfile['reasoningEffort'] {
  return REASONING_EFFORT_VALUES.some((effort) => effort === value);
}
