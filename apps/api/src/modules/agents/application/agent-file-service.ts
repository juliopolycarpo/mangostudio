import type { AgentProfile, UserAgentId } from '@mangostudio/shared/agents';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { basename, extname, relative, resolve } from 'path';
import { getConfig } from '../../../lib/config';
import { AgentSettingsError, slugFromAgentId, userAgentIdFromSlug } from '../domain/agent-profile';
import { parseAgentMarkdownProfile, serializeAgentMarkdown } from './agent-markdown-parser';

export const MAX_AGENT_MARKDOWN_BYTES = 256 * 1024;

const MARKDOWN_EXTENSION = '.md';

export interface AgentFileRecord {
  readonly profile: AgentProfile;
  readonly markdown: string;
}

export function getAgentsDir(): string {
  return getConfig().agents.dir;
}

export function listMarkdownAgentProfiles(): AgentProfile[] {
  const agentsDir = getAgentsDir();
  if (!existsSync(agentsDir)) return [];

  return readdirSync(agentsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && extname(entry.name) === MARKDOWN_EXTENSION)
    .map((entry) =>
      readMarkdownAgent(userAgentIdFromSlug(basename(entry.name, MARKDOWN_EXTENSION)))
    )
    .map((record) => record.profile)
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function readMarkdownAgent(agentId: UserAgentId): AgentFileRecord {
  const filePath = resolveAgentPath(agentId);
  assertReadableMarkdownFile(filePath);
  const markdown = readAgentMarkdown(filePath);
  return {
    markdown,
    profile: parseAgentMarkdownProfile(markdown, { id: agentId, path: filePath }),
  };
}

export function writeMarkdownAgent(profile: AgentProfile): AgentProfile {
  if (!profile.id.startsWith('user:')) {
    throw new AgentSettingsError('Only user agents can be written to markdown.', 422, 'VALIDATION');
  }

  const agentId = profile.id as UserAgentId;
  const filePath = resolveAgentPath(agentId);
  mkdirSync(getAgentsDir(), { recursive: true });
  const markdown = serializeAgentMarkdown({
    ...profile,
    source: { type: 'markdown', path: filePath },
  });
  assertMarkdownSize(markdown);
  writeFileSync(filePath, markdown, 'utf8');
  return parseAgentMarkdownProfile(markdown, { id: agentId, path: filePath });
}

export function createMarkdownAgent(profile: AgentProfile): AgentProfile {
  if (!profile.id.startsWith('user:')) {
    throw new AgentSettingsError('Only user agents can be created as markdown.', 422, 'VALIDATION');
  }

  const filePath = resolveAgentPath(profile.id as UserAgentId);
  if (existsSync(filePath)) {
    throw new AgentSettingsError('Agent already exists.', 409, 'VALIDATION');
  }

  return writeMarkdownAgent(profile);
}

export function deleteMarkdownAgent(agentId: UserAgentId): void {
  const filePath = resolveAgentPath(agentId);
  assertReadableMarkdownFile(filePath);
  rmSync(filePath, { force: true });
}

export function previewAgentMarkdown(markdown: string, agentId: UserAgentId): AgentFileRecord {
  assertMarkdownSize(markdown);
  return {
    markdown,
    profile: parseAgentMarkdownProfile(markdown, { id: agentId }),
  };
}

function resolveAgentPath(agentId: UserAgentId): string {
  const agentsDir = resolve(getAgentsDir());
  const filePath = resolve(agentsDir, `${slugFromAgentId(agentId)}${MARKDOWN_EXTENSION}`);
  assertPathInsideAgentsDir(filePath, agentsDir);
  return filePath;
}

function assertPathInsideAgentsDir(filePath: string, agentsDir: string): void {
  const relativePath = relative(agentsDir, filePath);
  if (relativePath.startsWith('..') || relativePath === '' || relativePath.includes('..')) {
    throw new AgentSettingsError(
      'Agent path must stay inside the agents directory.',
      422,
      'VALIDATION'
    );
  }
}

function assertReadableMarkdownFile(filePath: string): void {
  if (extname(filePath) !== MARKDOWN_EXTENSION) {
    throw new AgentSettingsError('Only .md agent files are allowed.', 422, 'VALIDATION');
  }

  try {
    const stat = lstatSync(filePath);
    if (!stat.isFile()) {
      throw new AgentSettingsError('Agent path is not a regular file.', 422, 'VALIDATION');
    }
    if (stat.size > MAX_AGENT_MARKDOWN_BYTES) {
      throw new AgentSettingsError('Agent markdown is too large.', 422, 'VALIDATION');
    }
  } catch (error) {
    if (error instanceof AgentSettingsError) throw error;
    throw new AgentSettingsError('Agent not found.', 404, 'NOT_FOUND');
  }
}

function readAgentMarkdown(filePath: string): string {
  try {
    return readFileSync(filePath, 'utf8');
  } catch {
    throw new AgentSettingsError('Agent file is not readable.', 422, 'VALIDATION');
  }
}

function assertMarkdownSize(markdown: string): void {
  if (Buffer.byteLength(markdown, 'utf8') > MAX_AGENT_MARKDOWN_BYTES) {
    throw new AgentSettingsError('Agent markdown is too large.', 422, 'VALIDATION');
  }
}
