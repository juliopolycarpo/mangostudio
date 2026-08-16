/**
 * Built-in tool: delegate_to_agent
 * Delegates bounded work to an allowed subagent during the current turn.
 */

import { SUBAGENT_MAX_TURNS_MAX, SUBAGENT_MAX_TURNS_MIN } from '@mangostudio/shared/app-settings';

import { getBoundedOptionalInteger, getOptionalString, getRequiredString } from '../arg-parsing';
import { registerTool } from '../registry';
import type { DelegateToAgentInput, ToolContext } from '../types';

export const DELEGATE_TO_AGENT_TOOL_NAME = 'delegate_to_agent';

const definition = {
  name: DELEGATE_TO_AGENT_TOOL_NAME,
  description:
    'Delegates bounded exploration or execution work to an allowed subagent and returns a concise result for this turn.',
  parameters: {
    type: 'object',
    properties: {
      agentId: {
        type: 'string',
        description: 'Target subagent id, such as "explore" or "user:researcher".',
      },
      task: {
        type: 'string',
        description: 'Specific, bounded task for the subagent to perform.',
      },
      context: {
        type: ['string', 'null'],
        description:
          'Context that helps the subagent avoid rediscovery. Pass null when there is none.',
      },
      expectedOutput: {
        type: ['string', 'null'],
        description:
          'Format or acceptance criteria for the result. Pass null to leave it unconstrained.',
      },
      maxTurns: {
        type: ['integer', 'null'],
        minimum: SUBAGENT_MAX_TURNS_MIN,
        maximum: SUBAGENT_MAX_TURNS_MAX,
        description:
          'Maximum subagent model/tool turns for this delegation. Pass null to use the configured default.',
      },
    },
    required: ['agentId', 'task', 'context', 'expectedOutput', 'maxTurns'],
    additionalProperties: false,
  },
};

// biome-ignore lint/suspicious/useAwait: Migrated from ESLint
async function execute(args: Record<string, unknown>, context: ToolContext): Promise<unknown> {
  if (!context.delegateToAgent) {
    throw new Error('Delegation is not available in this runtime.');
  }

  return context.delegateToAgent(parseDelegateArgs(args));
}

/** Registers this built-in tool. // Usage: register() */
export function register(): void {
  registerTool({
    definition,
    settings: {
      title: 'Delegate to agent',
      description: 'Allows primary agents to delegate bounded work to configured subagents.',
      category: 'system',
      enabledByDefault: true,
      canDisable: true,
      defaultParameters: {},
      parameterDescriptors: [],
    },
    execute,
  });
}

function parseDelegateArgs(args: Record<string, unknown>): DelegateToAgentInput {
  const agentId = getRequiredString(args.agentId, 'agentId');
  const task = getRequiredString(args.task, 'task');
  const context = getOptionalString(args.context, 'context');
  const expectedOutput = getOptionalString(args.expectedOutput, 'expectedOutput');
  const maxTurns = getBoundedOptionalInteger(args.maxTurns, 'maxTurns', {
    min: SUBAGENT_MAX_TURNS_MIN,
    max: SUBAGENT_MAX_TURNS_MAX,
  });

  return {
    agentId,
    task,
    ...(context ? { context } : {}),
    ...(expectedOutput ? { expectedOutput } : {}),
    ...(maxTurns !== undefined ? { maxTurns } : {}),
  };
}
