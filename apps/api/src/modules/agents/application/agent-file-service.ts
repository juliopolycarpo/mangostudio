import { type Dirent, readdirSync, rmSync } from 'node:fs';
import { basename, extname, relative, resolve } from 'node:path';
import type { AgentProfile, UserAgentId } from '@mangostudio/shared/agents';
import { getConfig } from '../../../lib/config';
import {
  RegularFileReadError,
  readRegularFileUtf8,
  statRegularFile,
  writeFileAtomic,
} from '../../../lib/safe-file';
import { AgentSettingsError, slugFromAgentId, userAgentIdFromSlug } from '../domain/agent-profile';
import { parseAgentMarkdownProfile, serializeAgentMarkdown } from './agent-markdown-parser';

const MAX_AGENT_MARKDOWN_BYTES = 256 * 1024;

const MARKDOWN_EXTENSION = '.md';

interface AgentFileRecord {
  readonly profile: AgentProfile;
  readonly markdown: string;
}

function getAgentsDir(): string {
  return getConfig().agents.dir;
}

export function listMarkdownAgentProfiles(): AgentProfile[] {
  return readAgentsDirEntries()
    .filter((entry) => entry.isFile() && extname(entry.name) === MARKDOWN_EXTENSION)
    .flatMap((entry) => readListedAgent(basename(entry.name, MARKDOWN_EXTENSION)))
    .sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * One unusable file must not take the whole list down. The agents directory is
 * also a library propagation destination, and library slugs are wider than
 * agent slugs (`Code_Reviewer` is a valid library slug and an invalid agent
 * one), so a single propagated file could otherwise fail every agent lookup.
 */
function readListedAgent(slug: string): AgentProfile[] {
  try {
    return [readMarkdownAgent(userAgentIdFromSlug(slug)).profile];
  } catch (error) {
    if (error instanceof AgentSettingsError) return [];
    throw error;
  }
}

function readAgentsDirEntries(): Dirent[] {
  try {
    return readdirSync(getAgentsDir(), { withFileTypes: true });
  } catch (error) {
    // A missing agents directory just means no markdown agents yet.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

export function readMarkdownAgent(agentId: UserAgentId): AgentFileRecord {
  const filePath = resolveAgentPath(agentId);
  assertMarkdownExtension(filePath);
  const markdown = readAgentMarkdownFile(filePath);
  return {
    markdown,
    profile: parseAgentMarkdownProfile(markdown, { id: agentId, path: filePath }),
  };
}

export function writeMarkdownAgent(profile: AgentProfile): AgentProfile {
  if (!profile.id.startsWith('user:')) {
    throw new AgentSettingsError('Only user agents can be written to markdown.', 422, 'VALIDATION');
  }
  return persistMarkdownAgent(profile.id as UserAgentId, profile, false);
}

export function createMarkdownAgent(profile: AgentProfile): AgentProfile {
  if (!profile.id.startsWith('user:')) {
    throw new AgentSettingsError('Only user agents can be created as markdown.', 422, 'VALIDATION');
  }
  return persistMarkdownAgent(profile.id as UserAgentId, profile, true);
}

/**
 * Serialize and write a user agent's markdown atomically. `exclusive` rejects an
 * existing file with EEXIST instead of overwriting, closing the create-time race
 * that an `existsSync` precheck could not.
 */
function persistMarkdownAgent(
  agentId: UserAgentId,
  profile: AgentProfile,
  exclusive: boolean
): AgentProfile {
  const filePath = resolveAgentPath(agentId);
  const markdown = serializeAgentMarkdown({
    ...profile,
    source: { type: 'markdown', path: filePath },
  });
  assertMarkdownSize(markdown);

  try {
    writeFileAtomic(filePath, markdown, { exclusive });
  } catch (error) {
    if (exclusive && (error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new AgentSettingsError('Agent already exists.', 409, 'VALIDATION');
    }
    throw error;
  }

  return parseAgentMarkdownProfile(markdown, { id: agentId, path: filePath });
}

export function deleteMarkdownAgent(agentId: UserAgentId): void {
  const filePath = resolveAgentPath(agentId);
  assertMarkdownExtension(filePath);
  assertExistingAgentFile(filePath);
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

function assertMarkdownExtension(filePath: string): void {
  if (extname(filePath) !== MARKDOWN_EXTENSION) {
    throw new AgentSettingsError('Only .md agent files are allowed.', 422, 'VALIDATION');
  }
}

function readAgentMarkdownFile(filePath: string): string {
  try {
    return readRegularFileUtf8(filePath, { maxBytes: MAX_AGENT_MARKDOWN_BYTES }).content;
  } catch (error) {
    throw toAgentReadError(error);
  }
}

function assertExistingAgentFile(filePath: string): void {
  try {
    if (statRegularFile(filePath).sizeBytes > MAX_AGENT_MARKDOWN_BYTES) {
      throw new AgentSettingsError('Agent markdown is too large.', 422, 'VALIDATION');
    }
  } catch (error) {
    throw toAgentReadError(error);
  }
}

function toAgentReadError(error: unknown): AgentSettingsError {
  if (error instanceof AgentSettingsError) return error;
  if (error instanceof RegularFileReadError) {
    switch (error.reason) {
      case 'not-found':
        return new AgentSettingsError('Agent not found.', 404, 'NOT_FOUND');
      case 'not-regular-file':
        return new AgentSettingsError('Agent path is not a regular file.', 422, 'VALIDATION');
      case 'too-large':
        return new AgentSettingsError('Agent markdown is too large.', 422, 'VALIDATION');
      default:
        return new AgentSettingsError('Agent file is not readable.', 422, 'VALIDATION');
    }
  }
  return new AgentSettingsError('Agent not found.', 404, 'NOT_FOUND');
}

function assertMarkdownSize(markdown: string): void {
  if (Buffer.byteLength(markdown, 'utf8') > MAX_AGENT_MARKDOWN_BYTES) {
    throw new AgentSettingsError('Agent markdown is too large.', 422, 'VALIDATION');
  }
}
