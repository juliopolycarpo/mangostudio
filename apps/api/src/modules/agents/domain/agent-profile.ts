import type {
  AgentId,
  AgentProfile,
  AgentProfileUpsertBody,
  BuiltInAgentId,
  UserAgentId,
} from '@mangostudio/shared/agents';
import { assertAgentProfile, isAgentId, isReasoningEffort } from '@mangostudio/shared/agents';
import { MAX_TOOL_ITERATIONS_MAX, MAX_TOOL_ITERATIONS_MIN } from '@mangostudio/shared/app-settings';

const BUILT_IN_AGENT_IDS = ['chat', 'default', 'explore'] as const;
const RESERVED_AGENT_SLUGS = ['chat', 'default', 'explore', 'agents', 'claude'] as const;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export class AgentSettingsError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string
  ) {
    super(message);
    this.name = 'AgentSettingsError';
  }
}

export function isBuiltInAgentId(value: string): value is BuiltInAgentId {
  return BUILT_IN_AGENT_IDS.some((agentId) => agentId === value);
}

export function isUserAgentId(value: string): value is UserAgentId {
  return /^user:[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}

export function assertAgentId(value: string): AgentId {
  if (!isAgentId(value)) {
    throw new AgentSettingsError(
      'Agent id must be chat, default, or user:<slug>.',
      422,
      'VALIDATION'
    );
  }
  return value;
}

export function slugFromAgentId(agentId: UserAgentId): string {
  return agentId.slice('user:'.length);
}

export function userAgentIdFromSlug(slug: string): UserAgentId {
  const normalizedSlug = normalizeAgentSlug(slug);
  return `user:${normalizedSlug}`;
}

export function slugFromName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

export function normalizeAgentSlug(value: string): string {
  const slug = value.trim().toLowerCase();
  if (!SLUG_PATTERN.test(slug)) {
    throw new AgentSettingsError(
      'Agent slug must use lowercase letters, numbers, and hyphens.',
      422,
      'VALIDATION'
    );
  }

  if (RESERVED_AGENT_SLUGS.some((reserved) => reserved === slug)) {
    throw new AgentSettingsError('Agent slug is reserved.', 422, 'VALIDATION');
  }

  return slug;
}

export function normalizeAgentProfile(profile: AgentProfile): AgentProfile {
  const normalized: AgentProfile = {
    id: assertAgentId(profile.id),
    name: profile.name.trim(),
    description: profile.description,
    kind: isBuiltInAgentId(profile.id) ? 'builtin' : 'user',
    role: profile.role,
    source: isBuiltInAgentId(profile.id) ? { type: 'builtin' } : profile.source,
    systemPrompt: profile.systemPrompt,
    ...(profile.model ? { model: profile.model } : {}),
    ...(typeof profile.thinkingEnabled === 'boolean'
      ? { thinkingEnabled: profile.thinkingEnabled }
      : {}),
    ...(isReasoningEffort(profile.reasoningEffort)
      ? { reasoningEffort: profile.reasoningEffort }
      : {}),
    ...(typeof profile.maxToolIterations === 'number'
      ? { maxToolIterations: clampToolIterations(profile.maxToolIterations) }
      : {}),
    toolNames: normalizeStringArray(profile.toolNames),
    toolsEnabled: profile.toolsEnabled,
    subagentIds: normalizeAgentIds(profile.subagentIds),
    metadata: isRecord(profile.metadata) ? profile.metadata : {},
  };

  return assertAgentProfile(normalized);
}

export function profileFromBody(
  agentId: AgentId,
  body: AgentProfileUpsertBody,
  source: AgentProfile['source']
): AgentProfile {
  return normalizeAgentProfile({
    id: agentId,
    name: body.name,
    description: body.description,
    kind: isBuiltInAgentId(agentId) ? 'builtin' : 'user',
    role: body.role,
    source,
    systemPrompt: body.systemPrompt,
    ...(body.model ? { model: body.model } : {}),
    ...(typeof body.thinkingEnabled === 'boolean' ? { thinkingEnabled: body.thinkingEnabled } : {}),
    ...(isReasoningEffort(body.reasoningEffort) ? { reasoningEffort: body.reasoningEffort } : {}),
    ...(typeof body.maxToolIterations === 'number'
      ? { maxToolIterations: body.maxToolIterations }
      : {}),
    toolNames: normalizeStringArray(body.toolNames),
    toolsEnabled: body.toolsEnabled,
    subagentIds: normalizeAgentIds(body.subagentIds),
    metadata: body.metadata,
  });
}

function normalizeStringArray(value: ReadonlyArray<string>): ReadonlyArray<string> {
  return [...new Set(value.map((item) => item.trim()).filter(Boolean))];
}

function normalizeAgentIds(value: ReadonlyArray<unknown>): ReadonlyArray<AgentId> {
  return [...new Set(value.filter(isAgentId))];
}

function clampToolIterations(value: number): number {
  return Math.min(MAX_TOOL_ITERATIONS_MAX, Math.max(MAX_TOOL_ITERATIONS_MIN, Math.round(value)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
