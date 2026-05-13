import type { AgentId, AgentProfile } from '@mangostudio/shared/agents';
import { AgentProfileValidationError, parseAgentMarkdown } from '@mangostudio/shared/agents';
import { AgentSettingsError, normalizeAgentProfile } from '../domain/agent-profile';

const FRONTMATTER_BOUNDARY = '---';

export function parseAgentMarkdownProfile(
  markdown: string,
  options: { readonly id: AgentId; readonly path?: string }
): AgentProfile {
  try {
    return normalizeAgentProfile(parseAgentMarkdown(markdown, options));
  } catch (error) {
    if (error instanceof AgentProfileValidationError) {
      throw new AgentSettingsError(error.message, 422, 'VALIDATION');
    }
    throw error;
  }
}

export function serializeAgentMarkdown(profile: AgentProfile): string {
  const lines = [
    FRONTMATTER_BOUNDARY,
    `name: ${quoteYamlScalar(profile.name)}`,
    `description: ${quoteYamlScalar(profile.description)}`,
    `role: ${profile.role}`,
  ];

  if (profile.model) lines.push(`model: ${quoteYamlScalar(profile.model)}`);
  if (profile.toolNames.length > 0) lines.push(...serializeStringList('tools', profile.toolNames));
  if (profile.subagentIds.length > 0) {
    lines.push(...serializeStringList('subagents', profile.subagentIds));
  }

  for (const [key, value] of Object.entries(profile.metadata)) {
    if (isReservedFrontmatterKey(key)) continue;
    if (isScalarMetadataValue(value)) lines.push(`${key}: ${serializeMetadataValue(value)}`);
    if (isStringArray(value)) lines.push(...serializeStringList(key, value));
  }

  lines.push(FRONTMATTER_BOUNDARY, '', profile.systemPrompt.trim(), '');
  return lines.join('\n');
}

function serializeStringList(key: string, values: ReadonlyArray<string>): string[] {
  return [key + ':', ...values.map((value) => `  - ${quoteYamlScalar(value)}`)];
}

function serializeMetadataValue(value: string | number | boolean): string {
  return typeof value === 'string' ? quoteYamlScalar(value) : String(value);
}

function quoteYamlScalar(value: string): string {
  return JSON.stringify(value);
}

function isReservedFrontmatterKey(key: string): boolean {
  return ['name', 'description', 'model', 'tools', 'role', 'mode', 'subagents'].includes(key);
}

function isScalarMetadataValue(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function isStringArray(value: unknown): value is ReadonlyArray<string> {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}
