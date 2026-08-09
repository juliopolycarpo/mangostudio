import type { AgentId, AgentProfile } from '@mangostudio/shared/agents';
import type { ChatRunnerConfiguration } from '@mangostudio/shared/chat';
import type { Kysely } from 'kysely';
import type { Database } from '../../../db/types';
import { getAgentProfile } from '../../agents/application/agent-settings-service';
import { AgentSettingsError } from '../../agents/domain/agent-profile';
import { resolveRunnerAgentId } from '../../chats/domain/chat-runner';

export interface ResolvedRunnerAgent {
  readonly agentId: AgentId;
  readonly profile: AgentProfile;
}

export interface ResolveRunnerAgentInput {
  readonly db: Kysely<Database>;
  readonly userId: string;
  readonly runner: ChatRunnerConfiguration;
  /** The request's explicit override, if it named an agent. */
  readonly agentId?: AgentId;
}

function isMissingAgent(err: unknown): boolean {
  return err instanceof AgentSettingsError && err.status === 404;
}

/**
 * Resolves the profile a turn runs as, from the chat's persisted runner or the
 * request's override.
 *
 * A persisted runner can name an agent that no longer exists: migration 044
 * deliberately carries a dangling `user:<slug>` selection through, and a user
 * can delete an agent a chat is bound to at any time. The chat is still usable,
 * so a missing referent degrades to `default` rather than making every turn in
 * that chat fail with 404 until someone repicks an agent.
 *
 * An explicitly requested agent is a different case: the caller named an id
 * that does not exist, and that is a 404 worth reporting.
 */
export async function resolveRunnerAgentProfile(
  input: ResolveRunnerAgentInput
): Promise<ResolvedRunnerAgent> {
  const agentId = resolveRunnerAgentId(input.runner, input.agentId);

  try {
    const profile = await getAgentProfile(input.db, input.userId, agentId);
    return { agentId: profile.id, profile };
  } catch (err) {
    if (input.agentId || agentId === 'default' || !isMissingAgent(err)) throw err;

    console.warn(
      `[resolve-runner-agent] chat runner names missing agent '${agentId}'; falling back to 'default'`
    );
    const profile = await getAgentProfile(input.db, input.userId, 'default');
    return { agentId: profile.id, profile };
  }
}
