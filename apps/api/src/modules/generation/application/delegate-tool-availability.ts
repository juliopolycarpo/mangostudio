import type { AgentProfile } from '@mangostudio/shared/agents';
import type { MultiAgentSettings } from '@mangostudio/shared/app-settings';

/**
 * Decide whether the delegate-to-agent tool should be exposed for a turn, given
 * the multi-agent settings and the acting agent's profile. Shared by
 * turn-context resolution and tool execution so both gates stay in lockstep.
 *
 * // Usage: if (shouldExposeDelegateTool({ profile, settings })) {...}
 */
export function shouldExposeDelegateTool(input: {
  readonly profile: AgentProfile;
  readonly settings: MultiAgentSettings;
}): boolean {
  if (!input.settings.enabled) return false;
  if (input.settings.maxDepth < 1) return false;
  if (input.settings.maxSubagentCalls < 1) return false;
  if (input.profile.subagentIds.length === 0) return false;
  return true;
}
