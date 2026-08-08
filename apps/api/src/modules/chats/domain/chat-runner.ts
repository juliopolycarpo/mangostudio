import type { AgentId } from '@mangostudio/shared/agents';
import type { ChatRunnerConfiguration } from '@mangostudio/shared/chat';

/**
 * The agent a turn runs as when the request does not name one. The chat's
 * persisted runner is the source of truth — falling straight through to
 * `default` would let a chat configured for `explore` execute, and report its
 * capabilities, as a different agent.
 *
 * `external` runners have no MangoStudio agent to fall back to; they are
 * unreachable until plan 006 wires an adapter, and this keeps the resolution
 * total until then.
 */
export function resolveRunnerAgentId(
  runner: ChatRunnerConfiguration,
  requestedAgentId?: AgentId
): AgentId {
  if (requestedAgentId) return requestedAgentId;
  return runner.kind === 'mangostudio' ? runner.agentId : 'default';
}
