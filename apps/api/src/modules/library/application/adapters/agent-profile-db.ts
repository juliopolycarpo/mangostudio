import { createHash } from 'node:crypto';
import type { AgentId, AgentProfile } from '@mangostudio/shared/agents';
import {
  parseAgentMarkdownProfile,
  serializeAgentMarkdown,
} from '../../../agents/application/agent-markdown-parser';

export class AgentProfileDbAdapterError extends Error {
  constructor(
    readonly code: 'not-found' | 'invalid-markdown',
    message: string
  ) {
    super(message);
    this.name = 'AgentProfileDbAdapterError';
  }
}

export interface AgentProfileDbStore {
  read(userId: string, agentId: AgentId): Promise<AgentProfile | undefined>;
  upsert(userId: string, profile: AgentProfile): Promise<AgentProfile>;
}

export interface RenderedAgentProfile {
  readonly content: string;
  readonly contentHash: string;
}

/** Stable virtual read: the serialized rendering, not the JSON row, owns identity. */
export async function readAgentProfileRendering(
  store: AgentProfileDbStore,
  userId: string,
  agentId: AgentId
): Promise<RenderedAgentProfile> {
  const profile = await store.read(userId, agentId);
  if (!profile) {
    throw new AgentProfileDbAdapterError('not-found', `Agent profile "${agentId}" was not found.`);
  }
  const content = serializeAgentProfileRendering(profile);
  return { content, contentHash: sha256(content) };
}

/** Parse completely before upserting, so invalid markdown can never create a partial row. */
export function writeAgentProfileRendering(
  store: AgentProfileDbStore,
  userId: string,
  agentId: AgentId,
  markdown: string
): Promise<AgentProfile> {
  const profile = parseAgentProfileRendering(markdown, agentId);
  return store.upsert(userId, profile);
}

export function serializeAgentProfileRendering(profile: AgentProfile): string {
  return serializeAgentMarkdown({
    ...profile,
    metadata: Object.fromEntries(
      Object.entries(profile.metadata).sort(([left], [right]) => compareText(left, right))
    ),
  });
}

export function parseAgentProfileRendering(markdown: string, agentId: AgentId): AgentProfile {
  try {
    return parseAgentMarkdownProfile(markdown, { id: agentId });
  } catch (error) {
    throw new AgentProfileDbAdapterError(
      'invalid-markdown',
      error instanceof Error ? error.message : String(error)
    );
  }
}

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
